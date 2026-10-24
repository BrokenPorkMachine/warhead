import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReadCoverage, callSignature } from '../src/agent/loop.ts'

test('ReadCoverage detects overlap correctly', () => {
  const r = new ReadCoverage()
  assert.equal(r.isRedundant('a', 1, 10), false)
  r.record('a', 1, 10)
  assert.ok(r.isRedundant('a', 1, 10))
  assert.ok(r.isRedundant('a', 2, 5))
  assert.equal(r.isRedundant('a', 100, 10), false)
})

test('callSignature ignores argument ordering noise', () => {
  assert.equal(callSignature({ name: 'read_file', args: { path: 'x' } } as any), 'read_file(path="x")')
})
