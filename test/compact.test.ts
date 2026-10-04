import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conversationChars, compactIfNeeded, approxTokens } from '../src/context/compact.ts'
import type { ChatMessage } from '../src/types.ts'

test('conversationChars counts text and tool arguments', () => {
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', args: { path: 'a' } }] },
  ]
  // 'hello' + name 'read_file' + JSON of {path:'a'}
  assert.equal(conversationChars(msgs), 5 + 'read_file'.length + JSON.stringify({ path: 'a' }).length)
  assert.equal(approxTokens(4000), 1000)
})

test('no compaction below the threshold', async () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]
  const r = await compactIfNeeded(msgs, { model: 'x', thresholdChars: 100_000, keepRecent: 4 })
  assert.equal(r.compacted, false)
  assert.deepEqual(r.messages, msgs)
})

test('refuses to compact when there is nothing older to compact', async () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a'.repeat(5000) },
    { role: 'assistant', content: 'b'.repeat(5000) },
  ]
  const r = await compactIfNeeded(msgs, { model: 'x', thresholdChars: 100, keepRecent: 8 })
  assert.equal(r.compacted, false)
  assert.match(r.error ?? '', /nothing left to compact/)
  assert.deepEqual(r.messages, msgs)
})

test('a summarizer failure leaves history untouched', async () => {
  // Port 1 is closed, so the summarizer call cannot connect.
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: `msg ${i} `.repeat(200) })),
    { role: 'assistant', content: 'recent' },
  ]
  const r = await compactIfNeeded(msgs, { model: 'x', thresholdChars: 100, keepRecent: 2 })
  assert.equal(r.compacted, false)
  assert.ok(r.error, 'reports why it could not compact')
  assert.deepEqual(r.messages, msgs, 'caller keeps the original history')
})
