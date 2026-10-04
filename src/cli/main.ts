/**
 * Phase 0 entrypoint: verify streaming, tool-call assembly, and model
 * selection. No agent loop yet — this exists to prove the plumbing before any
 * agent logic is built on top of it.
 *
 *   node src/main.ts            # probe + one streamed reply
 *   node src/main.ts --tools    # also verify a streamed tool call
 *   node src/main.ts --scan     # probe every installed model
 */

import { loadConfig } from '../config.ts'
import { chatOnce, streamChat } from '../model/client.ts'
import { listInstalledModels, scanForToolCapable } from '../model/probe.ts'
import { applyConfiguredProvider, activeProvider } from '../model/provider.ts'
import { resolveModel } from '../model/select.ts'
import type { ChatMessage, ToolDef } from '../types.ts'

const READ_TOOL: ToolDef = {
  name: 'read_file',
  description: 'Read a file from the local filesystem',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'absolute path' } },
    required: ['path'],
  },
}

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'

const colorFor = (status: string) =>
  status === 'ok' ? GREEN : status === 'unsupported' ? YELLOW : RED

function log(msg = ''): void {
  process.stdout.write(msg + '\n')
}

async function demoText(model: string): Promise<void> {
  log(`\n${BOLD}— streamed reply —${RESET}`)
  const messages: ChatMessage[] = [{ role: 'user', content: 'In one sentence, what is a hash table?' }]
  const t0 = Date.now()
  let ttfb = 0
  for await (const ev of streamChat(model, messages)) {
    if (ev.type === 'text') {
      if (ttfb === 0) ttfb = Date.now() - t0
      process.stdout.write(ev.delta)
    } else if (ev.type === 'done') {
      log(`\n${DIM}  ttfb ${ttfb}ms · total ${Date.now() - t0}ms · ${ev.promptEvalCount} in / ${ev.evalCount} out${RESET}`)
    }
  }
}

async function demoTools(model: string): Promise<void> {
  log(`\n${BOLD}— streamed tool call —${RESET}`)
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Read /etc/hosts using the read_file tool. Use the tool.' },
  ]
  for await (const ev of streamChat(model, messages, { tools: [READ_TOOL] })) {
    if (ev.type === 'tool_call') {
      log(`  ${GREEN}tool_call${RESET} ${BOLD}${ev.call.name}${RESET} ${JSON.stringify(ev.call.args)}`)
    } else if (ev.type === 'done') {
      log(`  ${DIM}${ev.promptEvalCount} prompt tokens${RESET}`)
    }
  }

  // Non-streaming path, used by the probe — verify the two agree.
  const once = await chatOnce(model, messages, { tools: [READ_TOOL] })
  log(
    `  ${DIM}non-streaming: ${once.toolCalls.length} call(s) ` +
      `${once.toolCalls.map(c => `${c.name}${JSON.stringify(c.args)}`).join(', ')}${RESET}`,
  )
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cfg = loadConfig()
  // Adopt providers.active before anything touches the network. Without this the
  // diagnostic entrypoint ignored the configured provider entirely: `--scan`
  // listed the local daemon's models while the REPL was talking to something
  // else, which is exactly the confusion you consult a diagnostic to avoid.
  applyConfiguredProvider(cfg)

  if (args.includes('--scan')) {
    const provider = activeProvider()
    const installed = await listInstalledModels()
    log(`${BOLD}${provider.name}${RESET} ${DIM}${provider.host}${RESET}`)
    log(`${BOLD}${installed.length} installed model(s)${RESET}`)
    const { capable, rejected } = await scanForToolCapable(installed)
    for (const r of [...capable, ...rejected]) {
      log(`  ${colorFor(r.status)}${r.status.padEnd(12)}${RESET} ${r.model.padEnd(44)} ${DIM}${r.latencyMs}ms — ${r.detail}${RESET}`)
    }
    log(`\n  ${capable.length} tool-capable, ${rejected.length} not`)
    return
  }

  // Shared with the REPL so the fallback chain cannot drift between the two
  // entrypoints. Read-only here: a diagnostic run must not rewrite the user's
  // config, so `persist` is off.
  const { model } = await resolveModel(cfg, {
    persist: false,
    report: r => {
      const c = r.status === 'ok' ? GREEN : r.status === 'unsupported' ? YELLOW : RED
      log(`  ${c}${r.status.padEnd(12)}${RESET} ${r.model.padEnd(44)} ${DIM}${r.latencyMs}ms — ${r.detail}${RESET}`)
    },
  })
  await demoText(model)
  if (args.includes('--tools')) await demoTools(model)

  log(`\n${DIM}phase 0 verified — streaming, tool-call assembly, and model selection all work.${RESET}`)
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  log(`\n${RED}phase 0 FAILED${RESET}\n${msg}`)
  process.exitCode = 1
})