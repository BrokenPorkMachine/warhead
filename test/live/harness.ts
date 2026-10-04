/**
 * Live regression suite.
 *
 * The unit suite runs against a fake Ollama: fast and deterministic, which is
 * exactly why it missed the bug where compaction was permanently inert (the
 * summarizer was handed an already-aborted signal — invisible to any test that
 * didn't drive the real REPL). This suite drives the REAL model so that class
 * of defect is caught.
 *
 * Design constraints, because the model is non-deterministic:
 *
 *  - Assert on TOOL USAGE and FILESYSTEM STATE, never on exact prose. Checking
 *    that a file contains `hi from agent` is stable; checking that the reply
 *    says "I created the file" is not.
 *  - Any assertion that depends on the model choosing a particular tool is
 *    marked `flaky` and reported separately rather than failing the run.
 *  - Each case gets an isolated temp cwd, so cases cannot contaminate each
 *    other or the real filesystem.
 *
 * Run:  node test/live/run.ts            (all cases)
 *       node test/live/run.ts read edit  (filter by name substring)
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { runTurn, type StopReason, type LoopEvent } from '../../src/agent/loop.ts'
import { Registry } from '../../src/tools/registry.ts'
import { createTodoStore } from '../../src/tools/todo.ts'
import { Gate } from '../../src/perm/gate.ts'
import { DEFAULT_CONFIG, type Config, type BashPolicy } from '../../src/config.ts'
import type { ToolCall, ToolContext, ChatMessage } from '../../src/types.ts'
import { ollamaHost } from '../../src/types.ts'

export type Expectations = {
  /** path -> exact expected file contents */
  files?: Record<string, string>
  /** paths that must exist */
  fileExists?: string[]
  /** paths that must NOT exist */
  fileAbsent?: string[]
  /** every one of these tools must have been called */
  toolsCalled?: string[]
  /** none of these tools may have been called */
  toolsNotCalled?: string[]
  /** regexes the final assistant text must match */
  answerMatches?: string[]
  stopReason?: StopReason[]
  /** Substrings that must appear in the concatenated tool output. */
  outputIncludes?: string[]
}

export type LiveCase = {
  name: string
  task: string
  setup?: (dir: string) => void
  bashPolicy?: BashPolicy
  toolPolicies?: Record<string, 'allow' | 'ask' | 'deny'>
  /** Answers for approval prompts, in order. 'y' allow, 'n' deny, 'a' always. */
  approvals?: string[]
  maxSteps?: number
  repeatCallLimit?: number
  expect: Expectations
  /** Tolerance for a case whose assertions depend on model tool choice. */
  flaky?: boolean
}

const results: Array<{ name: string; ok: boolean; failures: string[]; ms: number; flaky: boolean }> = []

function normalizeCfg(over: {
  bashPolicy?: BashPolicy
  toolPolicies?: Record<string, 'allow' | 'ask' | 'deny'>
  maxSteps?: number
  repeatCallLimit?: number
}): Config {
  const cfg = structuredClone(DEFAULT_CONFIG)
  if (over.bashPolicy) cfg.permissions.bash = over.bashPolicy
  if (over.toolPolicies) Object.assign(cfg.permissions.tools, over.toolPolicies)
  if (over.maxSteps) cfg.limits.maxSteps = over.maxSteps
  if (over.repeatCallLimit) cfg.limits.repeatCallLimit = over.repeatCallLimit
  return cfg
}

export async function runCase(model: string, c: LiveCase): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `live-${c.name}-`))
  const started = Date.now()
  const failures: string[] = []

  try {
    c.setup?.(dir)

    const cfg = normalizeCfg(c)
    const registry = new Registry()
    const gate = new Gate(() => cfg)
    const ctx: ToolContext = {
      cwd: dir,
      signal: new AbortController().signal,
      todos: createTodoStore(),
      config: () => cfg,
    }

    const calls: ToolCall[] = []
    const outputs: string[] = []
    let answer = ''
    const approvals = [...(c.approvals ?? [])]

    const res = await runTurn({
      model,
      registry,
      config: cfg,
      ctx,
      history: [],
      userText: c.task,
      signal: new AbortController().signal,
      onEvent: (ev: LoopEvent) => {
        if (ev.type === 'tool_start') calls.push({ id: ev.id, name: ev.name, args: ev.args })
        else if (ev.type === 'tool_end') outputs.push(ev.outcome.output || ev.outcome.error || '')
        else if (ev.type === 'text') answer += ev.delta
      },
      onToolStart: async call => {
        const tool = registry.get(call.name)
        if (!tool) return true
        const verdict = gate.evaluate(call, tool)
        if (verdict !== 'ask') return verdict === 'allow'
        const a = approvals.shift() ?? 'n'
        const outcome = a === 'y' ? 'allow' : a === 'a' ? 'allow_session' : 'deny'
        gate.record(call.name, outcome, call.args)
        return outcome !== 'deny'
      },
    })

    const last = res.messages.filter(m => m.role === 'assistant').at(-1)
    if (last && last.role === 'assistant') answer = last.content || answer

    // --- filesystem ---
    for (const [rel, want] of Object.entries(c.expect.files ?? {})) {
      const full = join(dir, rel)
      if (!existsSync(full)) {
        failures.push(`expected file ${rel} to exist`)
        continue
      }
      const got = readFileSync(full, 'utf8')
      if (got !== want) {
        failures.push(`file ${rel} mismatch\n      want: ${JSON.stringify(want)}\n      got:  ${JSON.stringify(got)}`)
      }
    }
    for (const rel of c.expect.fileExists ?? []) {
      if (!existsSync(join(dir, rel))) failures.push(`expected ${rel} to exist`)
    }
    for (const rel of c.expect.fileAbsent ?? []) {
      if (existsSync(join(dir, rel))) failures.push(`expected ${rel} NOT to exist`)
    }

    // --- tool usage ---
    const names = calls.map(x => x.name)
    for (const need of c.expect.toolsCalled ?? []) {
      if (!names.includes(need)) failures.push(`expected tool ${need} to be called; got [${names.join(', ')}]`)
    }
    for (const banned of c.expect.toolsNotCalled ?? []) {
      if (names.includes(banned)) failures.push(`tool ${banned} must not have been called`)
    }

    // --- output / answer ---
    const allOut = outputs.join('\n')
    for (const s of c.expect.outputIncludes ?? []) {
      if (!allOut.includes(s)) failures.push(`tool output missing ${JSON.stringify(s)}`)
    }
    for (const re of c.expect.answerMatches ?? []) {
      if (!new RegExp(re, 'i').test(answer)) {
        failures.push(`answer did not match /${re}/i — got: ${JSON.stringify(answer.slice(0, 200))}`)
      }
    }

    if (c.expect.stopReason && !c.expect.stopReason.includes(res.stopReason)) {
      failures.push(`stopReason ${res.stopReason}, expected one of ${c.expect.stopReason.join('|')}`)
    }

    // Appended last so it appears on every failure. Without the tool list AND the
    // output the model actually saw, a live failure is not debuggable.
    if (failures.length > 0) {
      failures.push(`tools called: [${names.join(', ') || 'none'}]`)
      const excerpt = allOut.trim().slice(0, 400)
      if (excerpt !== '') {
        failures.push(`tool output:\n      ${excerpt.replace(/\n/g, '\n      ')}`)
      }
      if (answer.trim() !== '') {
        failures.push(`answer: ${JSON.stringify(answer.trim().slice(0, 300))}`)
      }
    }
  } catch (err) {
    failures.push(`threw: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  results.push({ name: c.name, ok: failures.length === 0, failures, ms: Date.now() - started, flaky: !!c.flaky })
}

export function report(): number {
  const hard = results.filter(r => !r.flaky)
  const flaky = results.filter(r => r.flaky)

  const G = '\x1b[32m'
  const R = '\x1b[31m'
  const Y = '\x1b[33m'
  const D = '\x1b[2m'
  const X = '\x1b[0m'

  console.log(`\n${D}live suite — ${results.length} cases${X}`)
  for (const r of results) {
    const mark = r.ok ? `${G}✔${X}` : r.flaky ? `${Y}~${X}` : `${R}✖${X}`
    console.log(`  ${mark} ${r.name} ${D}(${r.ms}ms)${X}`)
    for (const f of r.failures) console.log(`      ${R}${f}${X}`)
  }

  const passHard = hard.filter(r => r.ok).length
  const passFlaky = flaky.filter(r => r.ok).length
  console.log(
    `\n  ${passHard}/${hard.length} strict passed` +
      (flaky.length > 0 ? `, ${passFlaky}/${flaky.length} flaky-model cases passed` : '') +
      `\n`,
  )
  return hard.every(r => r.ok) ? 0 : 1
}

/** Verify the daemon is reachable and the model actually resolves.
 *
 *  Deliberately a live probe rather than a /api/tags lookup: that endpoint lists
 *  only PULLED models, so cloud tags like `gpt-oss:120b-cloud` resolve on demand
 *  and are absent from it. Checking tags would reject a working model — which is
 *  exactly what this preflight did on its first run. */
export async function preflight(model: string): Promise<boolean> {
  const R = '\x1b[31m'
  const Y = '\x1b[33m'
  const X = '\x1b[0m'
  try {
    const res = await fetch(`${ollamaHost()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'reply with the single word ok' }],
        stream: false,
        options: { num_predict: 5 },
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (res.ok) return true

    const detail = await res.text().catch(() => '')
    console.log(`${R}live suite: ${model} is unavailable (HTTP ${res.status})${X}`)
    const trimmed = detail.trim().slice(0, 300)
    if (trimmed) console.log(`  ${Y}${trimmed}${X}`)
    return false
  } catch (err) {
    console.log(`${R}live suite: cannot reach Ollama at ${ollamaHost()}${X}`)
    console.log(`  ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// --- fixtures used by cases ---
export { mkdirSync, writeFileSync, readFileSync, existsSync, join, dirname }
export type { ChatMessage }