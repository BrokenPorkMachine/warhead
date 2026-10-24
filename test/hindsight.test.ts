import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Registry } from '../src/tools/registry.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { createTodoStore } from '../src/tools/todo.ts'

test('HindSight exports preserve evidence and are explicitly snapshots; invalid or oversized exports fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'warhead-hindsight-'))
  const registry = new Registry()
  const ctx = { cwd: dir, config: () => structuredClone(DEFAULT_CONFIG), signal: new AbortController().signal, todos: createTodoStore() }
  try {
    const snapshot = { evidence: [{ id: 'e1', provenance: 'asserted', address_space: 'preferred_vm', address: '0x1234' }] }
    await writeFile(join(dir, 'context.json'), JSON.stringify(snapshot))
    const result = await registry.dispatch('hindsight_context', { path: 'context.json' }, ctx)
    assert.equal(result.ok, true)
    const parsed = JSON.parse(result.output)
    assert.equal(parsed.live, false)
    assert.deepEqual(parsed.snapshot, snapshot)
    await writeFile(join(dir, 'context.json'), '{broken')
    assert.equal((await registry.dispatch('hindsight_context', { path: 'context.json' }, ctx)).ok, false)
    await writeFile(join(dir, 'context.json'), 'x'.repeat(256 * 1024 + 1))
    assert.match((await registry.dispatch('hindsight_context', { path: 'context.json' }, ctx)).error!, /exceeds 256 KiB/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
