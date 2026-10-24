/**
 * Interactive REPL.
 *
 * Plain readline, deliberately no TUI: real terminal scrollback survives, so a
 * session can be piped, tee'd, and grep'd. For an agentic tool that is worth
 * more to a single user than inline arrow-key dialogs.
 */

import { createInterface } from 'node:readline'
import { existsSync, readFileSync } from 'node:fs'
import { configPath, loadConfig, saveConfig, type Config } from '../config.ts'
import {
  checkReachable,
  filterModels,
  listInstalled,
  listInstalledModels,
  probeModel,
  scanForToolCapable,
} from '../model/probe.ts'
import { resolveModel } from '../model/select.ts'
import { showModel, pullModel, deleteModel, copyModel, createModel, version, runningModels } from '../model/ollama.ts'
import {
  activeProvider,
  addProvider,
  applyConfiguredProvider,
  describeProvider,
  findProvider,
  normalizeHost,
  removeProvider,
  resolveProvider,
  setActiveProvider,
  type ResolvedProvider,
} from '../model/provider.ts'
import { Registry } from '../tools/registry.ts'
import { createTodoStore, render as renderTodos } from '../tools/todo.ts'
import { runTurn, toHistory, describeStop, type StopReason } from '../agent/loop.ts'
import { Gate, type ApprovalRequest } from '../perm/gate.ts'
import { compactIfNeeded, conversationChars, approxTokens } from '../context/compact.ts'
import { fetchModelContextLength } from '../model/modelfile.ts'
import { Transcript, transcriptBytes, evictTranscripts, clearTranscripts, humanBytes } from '../context/transcript.ts'
import type { ChatMessage, ToolContext } from '../types.ts'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'

const out = (s = '') => process.stdout.write(s + '\n')

const USAGE = `${BOLD}commands${RESET}
  /help                 this text
${BOLD}  model${RESET}
  /models               list downloaded models (no probing, no requests)
  /model                show the resolved model, provider, and probe history
  /model use <tag>      probe just that tag and switch to it
  /model show <tag>     show Ollama model metadata
  /model pull <tag>     pull a model from Ollama
  /model delete <tag>   delete a local model
  /model copy <from> <to> copy a model tag
  /model create <name> <Modelfile> create a model from a Modelfile
  /model version         show the active Ollama version
  /model ps              show running Ollama models
  /model pick [filter]  probe matching installed models and choose one
  /model forget [tag]   drop a candidate and forget its probe result
${BOLD}  providers${RESET}
  /provider             list providers and show the active one
  /provider add <name> <host> [--key-env VAR | --key VALUE]
  /provider use <name>  switch; re-resolves a model for the new host
  /provider default     back to OLLAMA_HOST or localhost:11434
  /provider remove <name>
${BOLD}  permissions${RESET}
  /permissions            show permission policy
  /permissions bash …     set bash policy to ask | allow | allowlist
  /permissions allow|deny <tool>
  /permissions reset      clear session-scoped grants
  /tools                list available tools
  /todos                show the current task list
  /transcripts          show transcript location and usage
  /transcripts size | clear
  /clear                forget conversation history
  /exit                 quit`

const MAX_DETAIL_LINES = 24

/** Ask the user to authorize one tool call.
 *
 *  Uses the SAME readline instance as the main loop. A second interface on the
 *  same stdin double-buffers, which silently swallows piped answers — the
 *  approval would hang waiting for input the outer loop had already consumed. */
type AskLine = (promptText: string) => Promise<string | null>

async function askApproval(
  askLine: AskLine,
  req: ApprovalRequest,
): Promise<'allow' | 'deny' | 'allow_session' | 'input_closed'> {
  out('')
  out(`${YELLOW}${BOLD}⏸ approval required${RESET}`)
  out(`  ${YELLOW}${req.summary}${RESET}`)
  const detailLines = req.detail.split('\n')
  for (const l of detailLines.slice(0, MAX_DETAIL_LINES)) out(`  ${DIM}${l}${RESET}`)
  if (detailLines.length > MAX_DETAIL_LINES) {
    out(`  ${DIM}… ${detailLines.length - MAX_DETAIL_LINES} more line(s)${RESET}`)
  }

  for (;;) {
    const raw = await askLine(`  ${BOLD}[y]es / [n]o / [a]lways / [o]nce: ${RESET}`)
    if (raw === null) return 'input_closed'
    const a = raw.trim().toLowerCase()
    if (a === 'y' || a === 'yes') return 'allow'
    if (a === 'n' || a === 'no') return 'deny'
    if (a === 'a' || a === 'always') return 'allow_session'
    if (a === 'o' || a === 'once' || a === '') return 'allow'
    out(`  ${DIM}unrecognized answer${RESET}`)
  }
}

/** Promote a model to the front of the candidate list.
 *
 *  Removal-then-unshift rather than a reorder, so re-picking a model already
 *  present does not leave a duplicate behind. */
function preferModel(cfg: Config, picked: string): void {
  const i = cfg.model.candidates.indexOf(picked)
  if (i !== -1) cfg.model.candidates.splice(i, 1)
  cfg.model.candidates.unshift(picked)
  saveConfig(cfg)
}

/** Switch to a specific tag, probing only that one.
 *
 *  The point is to avoid the scan: `/model use <tag>` costs a single probe even
 *  on a host with dozens of models, where `/model pick` costs one per model. */
async function useModel(cfg: Config, tag: string): Promise<string | null> {
  out(`probing ${tag}…`)
  const r = await probeModel(tag)
  const c = r.status === 'ok' ? GREEN : r.status === 'unsupported' ? YELLOW : RED
  out(`  ${c}${r.status.padEnd(12)}${RESET} ${r.model.padEnd(42)} ${DIM}${r.latencyMs}ms — ${r.detail}${RESET}`)
  cfg.model.known[tag] = { status: r.status, detail: r.detail }
  if (r.status !== 'ok') {
    saveConfig(cfg)
    return null
  }
  preferModel(cfg, tag)
  return tag
}

/** Probe the installed models matching `terms` and offer a picker.
 *
 *  Filtering happens before probing, not after, so narrowing the list actually
 *  saves the calls — cloud endpoints bill every probe.
 *
 *  Takes the caller's `askLine` rather than opening its own readline: a second
 *  interface on the same stdin double-buffers, which silently swallows piped
 *  answers and hangs the prompt. That is why approval already shares one. */
async function pickModel(
  cfg: Config,
  terms: string[] = [],
  ask: AskLine,
): Promise<string | null> {
  const all = await listInstalledModels()
  if (all.length === 0) {
    out(`${RED}no models installed on ${activeProvider().host}${RESET}`)
    return null
  }
  const installed = filterModels(all, terms)
  if (installed.length === 0) {
    out(`${YELLOW}no installed model matches ${terms.join(', ')}${RESET}`)
    out(`${DIM}installed: ${all.join(', ')}${RESET}`)
    return null
  }
  // Probing everything is slow and costs real requests, so an unfiltered pick
  // says what it is about to do and asks first. Any other filter is intentional.
  if (terms.length === 0 && installed.length > 4) {
    out(`${installed.length} models installed; probing all of them costs one request each.`)
    out(`${DIM}installed: ${all.join(', ')}${RESET}`)
    const ans = await ask(`probe all ${installed.length}? [y/N] `)
    if (ans === null || !/^y(es)?$/i.test(ans.trim())) {
      out(`${DIM}cancelled — narrow it first, e.g. /model pick oss${RESET}`)
      return null
    }
  }

  out(`probing ${installed.length} model(s)…`)
  const { capable, rejected } = await scanForToolCapable(installed)
  for (const r of rejected) {
    out(`  ${RED}${r.status.padEnd(12)}${RESET} ${r.model.padEnd(42)} ${DIM}${r.detail}${RESET}`)
    cfg.model.known[r.model] = { status: r.status, detail: r.detail }
  }
  if (capable.length === 0) {
    out(`${RED}no matching model can call tools${RESET}`)
    saveConfig(cfg)
    return null
  }
  capable.forEach((r, i) => out(`  ${CYAN}${i + 1})${RESET} ${r.model} ${DIM}(${r.latencyMs}ms)${RESET}`))

  let picked: string
  if (capable.length === 1) {
    picked = capable[0]!.model
  } else {
    const ans = await ask(`select [1-${capable.length}]: `)
    const idx = Number.parseInt((ans ?? '').trim(), 10)
    picked =
      Number.isInteger(idx) && idx >= 1 && idx <= capable.length
        ? capable[idx - 1]!.model
        : capable[0]!.model
  }
  preferModel(cfg, picked)
  return picked
}

/** Show the provider list and which one is live. */
function showProviders(cfg: Config): void {
  const active = activeProvider()
  out(`active: ${BOLD}${describeProvider(active)}${RESET}`)
  if (cfg.providers.list.length === 0) {
    out(`${DIM}none configured — add one with /provider add <name> <host>${RESET}`)
    return
  }
  for (const p of cfg.providers.list) {
    const isActive = p.name.trim().toLowerCase() === active.name.trim().toLowerCase()
    let resolved: ResolvedProvider
    try {
      resolved = resolveProvider(p)
    } catch (err) {
      out(`  ${isActive ? GREEN : ''}${p.name}${RESET} ${RED}${err instanceof Error ? err.message : String(err)}${RESET}`)
      continue
    }
    out(`  ${isActive ? GREEN : DIM}${isActive ? '* ' : '  '}${describeProvider(resolved)}${RESET}`)
  }
}

/** Point the process at a configured provider, or back to the built-in default. */
function switchProvider(cfg: Config, name: string | undefined): ResolvedProvider | null {
  if (!name || name === 'default') {
    cfg.providers.active = null
    saveConfig(cfg)
    return applyConfiguredProvider(cfg)
  }
  if (!findProvider(cfg, name)) {
    out(`${RED}no provider named "${name}"${RESET}`)
    return null
  }
  cfg.providers.active = name
  saveConfig(cfg)
  return applyConfiguredProvider(cfg)
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const cwd = process.cwd()

  // Adopt providers.active before the first probe, so the model is resolved
  // against the endpoint that will actually serve it rather than the default.
  applyConfiguredProvider(cfg)

  out(`${BOLD}Warhead${RESET} : MGCA (Military Grade Coding Agent) · HindSight Reverse Engineering Studio`)
  out(`${DIM}probing models…${RESET}`)
  let model: string
  try {
    const resolved = await resolveModel(cfg, {
      report: r => {
        const c = r.status === 'ok' ? GREEN : r.status === 'unsupported' ? YELLOW : RED
        out(`  ${c}${r.status.padEnd(12)}${RESET} ${r.model.padEnd(42)} ${DIM}${r.latencyMs}ms — ${r.detail}${RESET}`)
      },
      pick: async capable => {
        if (capable.length === 1) return capable[0]!.model
        capable.forEach((r, i) => out(`  ${CYAN}${i + 1})${RESET} ${r.model} ${DIM}(${r.latencyMs}ms)${RESET}`))
        const ans = await askLine(`select [1-${capable.length}]: `)
        if (ans === null) return capable[0]!.model
        const idx = Number.parseInt(ans.trim(), 10)
        return Number.isInteger(idx) && idx >= 1 && idx <= capable.length
          ? capable[idx - 1]!.model
          : capable[0]!.model
      },
    })
    model = resolved.model
  } catch (err) {
    out(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`)
    process.exitCode = 1
    return
  }
  {
    const reg = new Registry()
    const mutating = reg.tools.filter(x => x.mutates).map(x => x.def.name)
    out(
      `${DIM}tools: ${reg.names().join(', ')}` +
        (mutating.length > 0 ? ` ${DIM}(mutating: ${mutating.join(', ')} — gated)${RESET}` : '') +
        `${RESET}\n`,
    )
  }

  const registry = new Registry()
  const gate = new Gate(() => cfg)
  const todos = createTodoStore()
  let history: ChatMessage[] = []
  const controller = new AbortController()
  let busy = false
  /** Aborts the in-flight turn; null when idle. */
  let turnAbort: AbortController | null = null
  let transcriptClose: () => void = () => {}

  // Ctrl-C handling. Two-stage: the first interrupt cancels the running turn,
  // the second at idle exits. Without this the message telling the user to
  // press Ctrl-C was simply false — the default handler killed the process and
  // lost the session along with the transcript buffer.
  let interruptCount = 0
  let announced = false
  const onSigint = () => {
    if (busy && turnAbort && !turnAbort.signal.aborted) {
      interruptCount = 0
      announced = true
      turnAbort.abort()
      out(`\n${YELLOW}interrupted — cancelling this turn${RESET}`)
      return
    }
    interruptCount++
    if (interruptCount >= 2) {
      out(`${DIM}bye${RESET}`)
      transcriptClose()
      process.exit(0)
    }
    out(`${YELLOW}press Ctrl-C again to exit${RESET}`)
  }
  process.on('SIGINT', onSigint)

  const transcript = new Transcript(cfg.transcripts.enabled, cfg.transcripts.maxToolResultBytes)
  transcriptClose = () => transcript.close()
  transcript.start({ cwd, model })
  if (transcript.file) out(`${DIM}transcript: ${transcript.file}${RESET}`)

  const ctx: ToolContext = {
    cwd,
    signal: controller.signal,
    todos,
    config: () => cfg,
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' })

  // Event-driven line queue rather than `for await (const line of rl)`.
  //
  // The async iterator suspends inside its body while a turn runs, and its
  // internal line listener then conflicts with rl.question() — so an approval
  // prompt raised mid-turn throws "readline was closed". Driving input off the
  // 'line' event and awaiting a queue keeps one code path for both the main
  // prompt and approval prompts, and lets a turn finish after stdin EOF (which
  // is what happens with piped input).
  let rlClosed = false
  const pending: string[] = []
  let waiter: (() => void) | null = null

  const wake = () => {
    const w = waiter
    waiter = null
    w?.()
  }

  rl.on('line', line => {
    pending.push(line)
    wake()
  })
  rl.on('close', () => {
    rlClosed = true
    wake()
  })

  const prompt = () => {
    if (!rlClosed) rl.prompt()
  }

  /** Read one line in response to `promptText`.
   *
   *  Consumes an already-queued line when one exists. This matters for piped
   *  input: readline emits 'close' the instant the last piped line is consumed,
   *  which happens long before the turn that needs approval has finished — so
   *  rl.question() would throw on an already-closed interface. Draining the
   *  queue first makes pre-supplied answers work. */
  const askLine = async (promptText: string): Promise<string | null> => {
    const queued = pending.shift()
    if (queued !== undefined) {
      process.stdout.write(`${promptText}${queued}\n`)
      return queued
    }
    if (rlClosed) return null
    const sig = turnAbort?.signal
    if (sig?.aborted) return null
    return new Promise<string | null>(res => {
      const done = (v: string | null) => {
        rl.off('line', onLine)
        rl.off('close', onClose)
        sig?.removeEventListener('abort', onAbort)
        res(v)
      }
      const onLine = (l: string) => done(l)
      const onClose = () => done(null)
      // Without this, Ctrl-C while an approval prompt is open did nothing: the
      // prompt kept waiting and the turn kept going.
      const onAbort = () => done(null)
      rl.once('line', onLine)
      rl.once('close', onClose)
      sig?.addEventListener('abort', onAbort, { once: true })
      process.stdout.write(promptText)
    })
  }

  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const l = pending.shift()
      if (l !== undefined) return l
      if (rlClosed) return null
      await new Promise<void>(res => {
        waiter = res
      })
    }
  }

  prompt()

  for (;;) {
    const raw = await nextLine()
    if (raw === null) {
      transcript.close()
      break
    }
    const text = raw.trim()

    if (text === '') {
      prompt()
      continue
    }

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/)
      switch (cmd) {
        case 'exit':
        case 'quit':
          transcript.close()
          rl.close()
          return
        case 'help':
          out(USAGE)
          break
        case 'tools':
          for (const t of registry.tools) out(`  ${BOLD}${t.def.name}${RESET} ${DIM}${t.def.description.split('\n')[0]!.slice(0, 90)}${RESET}`)
          break
        case 'todos':
          out(renderTodos(todos.list()))
          break
        case 'clear':
          history = []
          out(`${DIM}history cleared${RESET}`)
          break
        case 'transcripts': {
          const sub = rest[0]
          if (sub === 'clear') {
            const n = clearTranscripts()
            out(`${GREEN}removed ${n} transcript file(s)${RESET}${sub === 'clear' && transcript.file && existsSync(transcript.file) ? ` ${DIM}(current session log was also removed but stays open)${RESET}` : ''}`)
          } else if (sub === 'size') {
            out(`transcripts: ${humanBytes(transcriptBytes())} / ${humanBytes(cfg.transcripts.maxBytes)}`)
          } else {
            out(`current: ${DIM}${transcript.file || '(disabled)'}${RESET}`)
            out(`total:   ${humanBytes(transcriptBytes())} of ${humanBytes(cfg.transcripts.maxBytes)}`)
            out(`${DIM}/transcripts size | clear${RESET}`)
          }
          break
        }
        case 'models': {
          // Lists what is downloaded without probing anything. Every probe is a
          // request, and on a cloud endpoint a billed one, so browsing must be
          // free.
          const host = activeProvider().host
          const installed = await listInstalled()
          if (installed.length === 0) {
            out(`${DIM}no models on ${host}${RESET}`)
            out(`${DIM}cloud tags are not listed until used — set one with /model use <tag>${RESET}`)
            break
          }
          out(`${installed.length} model(s) on ${host}:`)
          for (const m of installed) {
            // humanBytes, not a hardcoded GB divisor: a tag that has been used but
            // not pulled reports its manifest size in KB, which rendered as
            // "0.0GB" and read as a bug rather than as what it was.
            const size = m.sizeBytes !== undefined ? `${DIM}${humanBytes(m.sizeBytes)}${RESET}` : ''
            const params = m.parameterSize ? `${DIM}${m.parameterSize}${RESET}` : ''
            const cloud = m.remote ? ` ${YELLOW}[not pulled]${RESET}` : ''
            const mark = m.name === model ? ` ${GREEN}*${RESET}` : ''
            out(`  ${m.name}${mark}${cloud} ${size} ${params}`)
          }
          out(`${DIM}/model use <tag> to switch · /model pick [filter] to probe a subset${RESET}`)
          break
        }
        case 'provider': {
          const sub = rest[0]
          if (!sub) {
            showProviders(cfg)
            break
          }
          if (sub === 'add') {
            const name = rest[1]
            const rawHost = rest[2]
            if (!name || !rawHost) {
              out(`${DIM}usage: /provider add <name> <host> [--key-env VAR | --key VALUE]${RESET}`)
              out(`${DIM}  host may omit the scheme: localhost:11434${RESET}`)
              break
            }
            let host: string
            try {
              host = normalizeHost(rawHost)
            } catch (err) {
              out(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`)
              break
            }
            // Exactly one credential source: two set at once is ambiguous about
            // which wins, and the inline one would sit in the file for nothing.
            let apiKey: string | undefined
            let apiKeyEnv: string | undefined
            const keyIdx = rest.indexOf('--key')
            const envIdx = rest.indexOf('--key-env')
            if (keyIdx !== -1 && envIdx !== -1) {
              out(`${RED}give either --key-env or --key, not both${RESET}`)
              break
            }
            if (keyIdx !== -1) {
              apiKey = rest[keyIdx + 1]
              if (!apiKey) { out(`${RED}--key needs a value${RESET}`); break }
            }
            if (envIdx !== -1) {
              apiKeyEnv = rest[envIdx + 1]
              if (!apiKeyEnv) { out(`${RED}--key-env needs a variable name${RESET}`); break }
            }
            const { added, replaced } = addProvider(cfg, { name, host, apiKey, apiKeyEnv })
            saveConfig(cfg)
            out(`${GREEN}${added ? 'added' : 'replaced'} provider${RESET} ${BOLD}${name}${RESET} ${DIM}${host}${RESET}`)
            if (apiKey) {
              out(`${YELLOW}  key stored in plaintext in ${configPath()}${RESET}`)
              out(`${DIM}  prefer --key-env so the secret stays out of the file${RESET}`)
            }
            if (apiKeyEnv && !process.env[apiKeyEnv]) {
              out(`${YELLOW}  ${apiKeyEnv} is not set in this shell; the provider will send no key${RESET}`)
            }
            out(`${DIM}  switch with /provider use ${name}${RESET}`)
            break
          }
          if (sub === 'use' || sub === 'default') {
            const before = activeProvider()
            const after = switchProvider(cfg, sub === 'default' ? undefined : rest[1])
            if (!after) break
            out(`${GREEN}provider ->${RESET} ${BOLD}${after.name}${RESET} ${DIM}${after.host}${RESET}`)
            if (after.host === before.host) {
              out(`${DIM}  same host — model unchanged${RESET}`)
              break
            }
            // Tags are per-host: a model that resolves on one endpoint commonly
            // 404s on another, so the old one cannot be trusted to keep working.
            out(`${YELLOW}  host changed — re-resolving a model for ${after.host}${RESET}`)
            // Drop remembered verdicts: they describe the old endpoint, and
            // keeping them would make selectModel skip probing entirely.
            cfg.model.known = {}
            // Ask the endpoint whether it is there before probing models
            // against it — otherwise a mistyped host costs one full probe
            // timeout per candidate before saying anything.
            const reach = await checkReachable(after)
            if (!reach.ok) {
              out(`${RED}${after.host} is not answering: ${reach.detail}${RESET}`)
              out(`${DIM}  provider is still selected; nothing else changed${RESET}`)
              break
            }
            out(`${DIM}  reachable${reach.version ? ` (ollama ${reach.version})` : ""}${RESET}`)
            try {
              const resolved = await resolveModel(cfg, {
                report: r => {
                  const c = r.status === 'ok' ? GREEN : r.status === 'unsupported' ? YELLOW : RED
                  out(`  ${c}${r.status.padEnd(12)}${RESET} ${r.model.padEnd(42)} ${DIM}${r.latencyMs}ms — ${r.detail}${RESET}`)
                },
              })
              model = resolved.model
              out(`${GREEN}model ->${RESET} ${BOLD}${model}${RESET}`)
            } catch (err) {
              out(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`)
              out(`${DIM}  /models to see what this host has, /model use <tag> to pick one${RESET}`)
            }
            break
          }
          if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
            const name = rest[1]
            if (!name) { out(`${DIM}usage: /provider remove <name>${RESET}`); break }
            if (!removeProvider(cfg, name)) {
              out(`${RED}no provider named "${name}"${RESET}`)
              break
            }
            saveConfig(cfg)
            // Removing the active provider must move the process off it, or the
            // next turn would keep talking to a host the user just deleted.
            if (!cfg.providers.active) applyConfiguredProvider(cfg)
            out(`${GREEN}removed${RESET} ${BOLD}${name}${RESET}`)
            out(`${DIM}  active: ${describeProvider(activeProvider())}${RESET}`)
            break
          }
          out(`${DIM}/provider [add <name> <host> [--key-env VAR|--key V] | use <name> | default | remove <name>]${RESET}`)
          break
        }
        case 'model': {
          const sub = rest[0]
          if (sub === 'use') {
            const tag = rest.slice(1).join(' ')
            if (!tag) { out(`${DIM}usage: /model use <tag>${RESET}`); break }
            const picked = await useModel(cfg, tag)
            if (picked) {
              model = picked
              out(`${GREEN}model ->${RESET} ${BOLD}${model}${RESET}`)
            }
            break
          }
          if (sub === 'show' || sub === 'pull' || sub === 'delete') {
            const tag = rest.slice(1).join(' ')
            if (!tag) { out(`${DIM}usage: /model ${sub} <tag>${RESET}`); break }
            try {
              if (sub === 'show') out(JSON.stringify(await showModel(tag), null, 2))
              else if (sub === 'pull') { out(`pulling ${tag}…`); out(JSON.stringify(await pullModel(tag), null, 2)) }
              else {
                const answer = await askLine(`delete ${tag}? [y/N] `)
                if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
                  out(`${DIM}cancelled${RESET}`)
                  break
                }
                out(JSON.stringify(await deleteModel(tag), null, 2)); out(`${GREEN}deleted${RESET} ${tag}`)
              }
            } catch (err) { out(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`) }
            break
          }
          if (sub === 'copy') {
            const source = rest[1], destination = rest[2]
            if (!source || !destination) { out(`${DIM}usage: /model copy <from> <to>${RESET}`); break }
            try { await copyModel(source, destination); out(`${GREEN}copied${RESET} ${source} -> ${destination}`) }
            catch (err) { out(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`) }
            break
          }
          if (sub === 'create') {
            const name = rest[1], file = rest[2]
            if (!name || !file) { out(`${DIM}usage: /model create <name> <Modelfile>${RESET}`); break }
            try {
              const modelfile = readFileSync(file, 'utf8')
              await createModel(name, modelfile)
              out(`${GREEN}created${RESET} ${name}`)
            } catch (err) { out(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`) }
            break
          }
          if (sub === 'version' || sub === 'ps') {
            try {
              const result = sub === 'version' ? await version() : await runningModels()
              out(JSON.stringify(result, null, 2))
            } catch (err) { out(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`) }
            break
          }
          if (sub === 'pick') {
            const picked = await pickModel(cfg, rest.slice(1), askLine)
            if (picked) {
              model = picked
              out(`${GREEN}model ->${RESET} ${BOLD}${model}${RESET}`)
            }
            break
          }
          if (sub === 'forget') {
            const tag = rest.slice(1).join(' ')
            if (tag) {
              const i = cfg.model.candidates.indexOf(tag)
              if (i !== -1) cfg.model.candidates.splice(i, 1)
              const had = tag in cfg.model.known
              delete cfg.model.known[tag]
              saveConfig(cfg)
              out(`${GREEN}forgot${RESET} ${BOLD}${tag}${RESET}${i === -1 && !had ? ` ${DIM}(was not recorded)${RESET}` : ''}`)
            } else {
              const n = cfg.model.candidates.length + Object.keys(cfg.model.known).length
              cfg.model.candidates = []
              cfg.model.known = {}
              saveConfig(cfg)
              out(`${GREEN}cleared${RESET} ${DIM}${n} recorded model(s)${RESET}`)
            }
            break
          }
          out(`provider: ${describeProvider(activeProvider())}`)
          out(`current:  ${BOLD}${model}${RESET}`)
          out(`candidates: ${cfg.model.candidates.join(', ') || '(none)'}`)
          const known = Object.entries(cfg.model.known)
          if (known.length > 0) {
            out(`${DIM}recorded probe results:${RESET}`)
            for (const [m, r] of known) out(`  ${m} — ${r.status}: ${r.detail}`)
          }
          out(`${DIM}/models · /model use <tag> · /model pick [filter] · /model forget [tag]${RESET}`)
          break
        }
        case 'permissions': {
          const sub = rest[0]
          if (sub === 'bash') {
            const level = rest[1]
            if (level === 'ask' || level === 'allow' || level === 'allowlist') {
              cfg.permissions.bash = level
              saveConfig(cfg)
              out(`${GREEN}bash policy ->${RESET} ${level}`)
              if (level === 'allowlist') out(`${DIM}  allowlist: ${cfg.permissions.bashAllowlist.join(', ')}${RESET}`)
            } else {
              out('usage: /permissions bash ask|allow|allowlist')
            }
          } else if (sub === 'reset') {
            gate.resetSession()
            out(`${DIM}session grants cleared${RESET}`)
          } else if (sub === 'allow' || sub === 'deny') {
            const tool = rest[1]
            if (!tool) {
              out('usage: /permissions allow|deny <tool>')
            } else {
              cfg.permissions.tools[tool] = sub
              saveConfig(cfg)
              out(`${GREEN}${tool} ->${RESET} ${sub}`)
            }
          } else {
            out(`${BOLD}bash${RESET}        ${cfg.permissions.bash}`)
            out(`${BOLD}alwaysAllow${RESET} ${cfg.permissions.alwaysAllow.join(', ')}`)
            const perTool = Object.entries(cfg.permissions.tools)
            if (perTool.length > 0) {
              out(`${BOLD}per-tool${RESET}`)
              for (const [k, v] of perTool) out(`  ${k} — ${v}`)
            }
            const s = gate.sessionState()
            if (s.allow.length > 0) out(`${BOLD}session allow${RESET} ${s.allow.join(', ')}`)
            if (s.deny.length > 0) out(`${BOLD}session deny${RESET}  ${s.deny.join(', ')}`)
            out(`${DIM}/permissions bash ask|allow|allowlist · allow|deny <tool> · reset${RESET}`)
          }
          break
        }
        default:
          out(`${YELLOW}unknown command '${cmd}' — /help for the list${RESET}`)
      }
      prompt()
      continue
    }

    if (busy) {
      out(`${DIM}still working on the previous turn — press Ctrl-C to cancel it${RESET}`)
      prompt()
      continue
    }
    // Compaction runs between turns only. Mid-turn it would have to drop tool
    // results whose assistant tool_calls entry was removed, which corrupts the
    // next request.
    if (cfg.transcripts.enabled) evictTranscripts(cfg.transcripts.maxBytes, transcript.file)

    // The turn's controller must exist BEFORE compaction. Previously the
    // summarizer was handed the long-lived `controller`, which is aborted at the
    // start of every turn to cancel the previous one — so the summarizer was
    // always called with an already-aborted signal and returned nothing, making
    // compaction silently inert after the first turn.
    const turnController = new AbortController()
    turnAbort = turnController
    Object.defineProperty(ctx, 'signal', { value: turnController.signal, configurable: true })

    const modelContextTokens = await fetchModelContextLength(model)
    // Ollama models vary wildly in context size (4k to 1M tokens). A fixed
    // threshold sized for a 60k-token model overflows a small one, so clamp to
    // the model's actual window, leaving headroom for the system prompt, tool
    // definitions, and the generated reply.
    const modelThresholdChars = modelContextTokens
      ? Math.max(4000, (modelContextTokens - 2048) * 4)
      : cfg.limits.compactThresholdChars
    const compactThresholdChars = Math.min(cfg.limits.compactThresholdChars, modelThresholdChars)

    const pre = conversationChars([
      { role: 'system', content: '' },
      ...history,
      { role: 'user', content: text },
    ])
    if (pre > compactThresholdChars) {
      out(`${DIM}compacting context (${approxTokens(pre)} tokens)…${RESET}`)
      const c = await compactIfNeeded(
        [...history],
        {
          model,
          thresholdChars: compactThresholdChars,
          keepRecent: cfg.limits.compactKeepRecent,
          signal: turnController.signal,
          ...(modelContextTokens != null ? { numCtx: modelContextTokens } : {}),
        },
      )
      if (c.compacted) {
        history = c.messages.filter(m => m.role !== 'system')
        out(
          `${DIM}compacted ${approxTokens(c.charsBefore)} -> ${approxTokens(c.charsAfter)} tokens${RESET}`,
        )
        transcript.note(`compacted ${approxTokens(c.charsBefore)} -> ${approxTokens(c.charsAfter)} tokens`)
      } else {
        out(`${YELLOW}compaction skipped: ${c.error ?? 'nothing to compact'}${RESET}`)
      }
    }

    busy = true
    controller.abort()
    turnAbort = turnController
    Object.defineProperty(ctx, 'signal', { value: turnController.signal, configurable: true })
    transcript.turn(text)

    out(`${CYAN}⏺${RESET}`)
    let stopReason: StopReason = 'answered'
    let streamed = false
    let trailingNewline = true
    try {
      const res = await runTurn({
        model,
        registry,
        config: cfg,
        ctx,
        history,
        userText: text,
        signal: turnController.signal,
        onToolStart: async call => {
          const tool = registry.get(call.name)
          if (!tool) return true // registry.dispatch reports unknown tools
          const verdict = gate.evaluate(call, tool)
          if (verdict === 'allow') return true
          if (verdict === 'deny') {
            out(`${RED}  denied by policy: ${call.name}${RESET}`)
            return false
          }
          const req = gate.request(call, tool)
          const outcome = await askApproval(askLine, req)
          if (outcome === 'input_closed') {
            // Either stdin ended or the turn was interrupted. Refuse this call
            // without recording a sticky session denial — a cancellation is not
            // the user rejecting `write`, and must not silently ban it for the
            // rest of the session.
            if (turnAbort?.signal.aborted) out(`${DIM}  approval cancelled with the turn${RESET}`)
            else gate.record(call.name, 'deny', call.args)
            return false
          }
          gate.record(call.name, outcome, call.args)
          if (outcome === 'allow_session') {
            out(
              call.name === 'bash'
                ? `${DIM}  this command allowed for the rest of the session${RESET}`
                : `${DIM}  ${call.name} allowed for the rest of this session${RESET}`,
            )
          }
          return outcome !== 'deny'
        },
        onEvent: ev => {
          if (ev.type === 'text') {
            // Streamed assistant prose. Without this the final answer was
            // produced but never rendered — the loop only emitted tool events.
            process.stdout.write(ev.delta)
            streamed = true
            trailingNewline = ev.delta.endsWith('\n')
            transcript.assistant(ev.delta)
          } else if (ev.type === 'tool_start') {
            transcript.toolCall(ev.name, ev.args)
            process.stdout.write(`\n${DIM}  ⎿ ${ev.name}(${JSON.stringify(ev.args).slice(0, 120)})${RESET}\n`)
          } else if (ev.type === 'tool_end') {
            transcript.toolResult(ev.name, ev.outcome.ok, ev.outcome.output || ev.outcome.error || '')
            const mark = ev.outcome.ok ? GREEN : RED
            const detail = ev.outcome.ok ? '' : ` ${ev.outcome.error ?? ev.outcome.output.slice(0, 120)}`
            process.stdout.write(`${DIM}    ${mark}${'└'}${RESET} ${ev.outcome.output.split('\n')[0]!.slice(0, 140)}${DIM}${detail}${RESET}\n`)
          } else if (ev.type === 'error') {
            process.stdout.write(`\n${RED}  error: ${ev.message}${RESET}\n`)
          }
        },
      })
      stopReason = res.stopReason
      history = toHistory(res.messages)
      if (streamed && !trailingNewline) process.stdout.write('\n')
      transcript.stop(stopReason, cfg.limits.maxSteps)
    } catch (err) {
      out(`${RED}${err instanceof Error ? err.message : String(err)}${RESET}`)
    }

    if (stopReason !== 'answered') {
      out(`${DIM}  [${describeStop(stopReason, cfg.limits.maxSteps)}]${RESET}`)
    }
    busy = false
    turnAbort = null
    interruptCount = 0
    // Do NOT return on rlClosed here: with piped input stdin closes the moment
    // the input is consumed, which is typically mid-turn. Finishing the turn
    // matters more than the prompt; the for-await below ends on its own.
    prompt()
  }
}

main().catch((err: unknown) => {
  out(`${RED}fatal: ${err instanceof Error ? err.stack : String(err)}${RESET}`)
  process.exitCode = 1
})
