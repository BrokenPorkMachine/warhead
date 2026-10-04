import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bash } from '../src/tools/bash.ts'
import { createTodoStore } from '../src/tools/todo.ts'
import type { ToolContext } from '../src/types.ts'

function scratch(signal?: AbortSignal): { dir: string; ctx: ToolContext } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bash-'))
  const ctx: ToolContext = {
    cwd: dir,
    signal: signal ?? new AbortController().signal,
    todos: createTodoStore(),
    config: () => ({ limits: { bashTimeoutMs: 5000 } }) as never,
  }
  return { dir, ctx }
}

test('captures stdout and reports a zero exit', async () => {
  const { dir, ctx } = scratch()
  const r = await bash.run({ command: 'echo hello' }, ctx)
  assert.equal(r.ok, true)
  assert.match(r.output, /^hello/)
  assert.match(r.output, /exit 0/)
  cleanup(dir)
})

test('a failing command is not ok and reports the exit code', async () => {
  const { dir, ctx } = scratch()
  const r = await bash.run({ command: 'echo oops >&2; exit 3' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.output, /\[stderr\]/)
  assert.match(r.output, /oops/)
  assert.match(r.output, /exit 3/)
  cleanup(dir)
})

test('runs in the working directory', async () => {
  const { dir, ctx } = scratch()
  const r = await bash.run({ command: 'pwd' }, ctx)
  assert.match(r.output, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  cleanup(dir)
})

test('truncates long output but keeps both the head and the tail', async () => {
  const { dir, ctx } = scratch()
  // Marker at the very start and the very end; the middle is filler.
  const r = await bash.run(
    { command: 'echo HEADMARK; for i in $(seq 1 60000); do echo "filler line $i aaaaaaaaaaaaaaaaaaaa"; done; echo TAILMARK' },
    ctx,
  )
  assert.equal(r.ok, true)
  assert.match(r.output, /HEADMARK/, 'head survives')
  assert.match(r.output, /TAILMARK/, 'tail survives')
  assert.match(r.output, /characters omitted/)
  assert.match(r.output, /output truncated/)
  cleanup(dir)
})

test('kills the whole process group on timeout', async () => {
  const { dir, ctx } = scratch()
  const marker = join(dir, 'grandchild-alive')
  const r = await bash.run(
    {
      // The inner sleep is a grandchild. If only the direct child were signalled
      // it would survive and the marker file would still appear.
      command: `(sleep 3; touch ${marker}) & echo started; sleep 10`,
      timeout_ms: 400,
    },
    ctx,
  )
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /timed out/)
  assert.match(r.output, /started/, 'output produced before the timeout is kept')

  await new Promise(r => setTimeout(r, 4000))
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(marker), false, 'grandchild was killed with the group')
  cleanup(dir)
})

test('honours cancellation via the context signal', async () => {
  const ac = new AbortController()
  const { dir, ctx } = scratch(ac.signal)
  setTimeout(() => ac.abort(), 300)
  const r = await bash.run({ command: 'sleep 10' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.output + (r.error ?? ''), /cancelled|timed out/)
  cleanup(dir)
})

test('refuses to run at all once already cancelled', async () => {
  const ac = new AbortController()
  ac.abort()
  const { dir, ctx } = scratch(ac.signal)
  const r = await bash.run({ command: 'echo should-not-run' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /Cancelled before/)
  cleanup(dir)
})

test('reports a missing binary instead of hanging', async () => {
  const { dir, ctx } = scratch()
  const r = await bash.run({ command: 'definitely-not-a-real-command-xyz' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.output + (r.error ?? ''), /exit 127|not found/)
  cleanup(dir)
})

test('a command writing a lot to stderr is still captured', async () => {
  const { dir, ctx } = scratch()
  const r = await bash.run({ command: 'for i in $(seq 1 200); do echo "err $i" >&2; done; exit 1' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.output, /\[stderr\]/)
  assert.match(r.output, /err 200/)
  cleanup(dir)
})

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
