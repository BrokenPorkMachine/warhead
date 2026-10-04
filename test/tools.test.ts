import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { globToRegExp } from '../src/tools/glob.ts'
import { writeFile, MAX_WRITE_BYTES } from '../src/tools/write.ts'
import { editFile } from '../src/tools/edit.ts'
import { multiEdit } from '../src/tools/multi_edit.ts'
import { readFile } from '../src/tools/read.ts'
import { grep } from '../src/tools/grep.ts'
import { glob } from '../src/tools/glob.ts'
import { createTodoStore, todo } from '../src/tools/todo.ts'
import { parseArgs } from '../src/model/client.ts'
import type { ToolContext } from '../src/types.ts'

function scratch(): { dir: string; ctx: ToolContext } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-'))
  const ctx: ToolContext = {
    cwd: dir,
    signal: new AbortController().signal,
    todos: createTodoStore(),
    config: () => ({}) as never,
  }
  return { dir, ctx }
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

// --- globToRegExp ---

test('globToRegExp handles ** across directories', () => {
  assert.ok(globToRegExp('**/*.ts').test('src/deep/nested/a.ts'))
  assert.ok(globToRegExp('**/*.ts').test('a.ts'), '**/ matches zero directories')
  assert.ok(!globToRegExp('**/*.ts').test('a.js'))
  assert.ok(!globToRegExp('src/*.ts').test('src/deep/a.ts'), 'single * does not cross /')
  assert.ok(globToRegExp('src/*/x.ts').test('src/y/x.ts'))
})

test('globToRegExp escapes regex metacharacters', () => {
  assert.ok(globToRegExp('a.b.ts').test('a.b.ts'))
  assert.ok(!globToRegExp('a.b.ts').test('axbxts'), 'dot is literal')
  assert.ok(globToRegExp('f(1).ts').test('f(1).ts'))
})

// --- parseArgs ---

test('parseArgs normalizes the shapes models actually emit', () => {
  assert.deepEqual(parseArgs({ a: 1 }), { a: 1 })
  assert.deepEqual(parseArgs('{"a":1}'), { a: 1 }, 'JSON string')
  assert.deepEqual(parseArgs(''), {}, 'empty string')
  assert.deepEqual(parseArgs(null), {})
  assert.deepEqual(parseArgs(undefined), {})
  assert.deepEqual(parseArgs('not json'), { _unparsed: 'not json' })
  assert.deepEqual(parseArgs(42), { value: 42 })
})

// --- write ---

test('write creates a file and its parent directories', async () => {
  const { dir, ctx } = scratch()
  const r = await writeFile.run({ path: 'a/b/c.txt', content: 'hi' }, ctx)
  assert.equal(r.ok, true)
  assert.equal(readFileSync(join(dir, 'a/b/c.txt'), 'utf8'), 'hi')
  cleanup(dir)
})

test('write refuses to overwrite without explicit consent', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'x.txt'), 'original')
  const r = await writeFile.run({ path: 'x.txt', content: 'replaced' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /already exists/)
  assert.equal(readFileSync(join(dir, 'x.txt'), 'utf8'), 'original', 'file untouched')
  cleanup(dir)
})

test('write overwrites when consent is explicit', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'x.txt'), 'original')
  const r = await writeFile.run({ path: 'x.txt', content: 'replaced', overwrite: true }, ctx)
  assert.equal(r.ok, true)
  assert.equal(readFileSync(join(dir, 'x.txt'), 'utf8'), 'replaced')
  cleanup(dir)
})

test('write enforces a size ceiling', async () => {
  const { dir, ctx } = scratch()
  const big = 'x'.repeat(MAX_WRITE_BYTES + 1)
  const r = await writeFile.run({ path: 'big.txt', content: big }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /Refusing to write/)
  cleanup(dir)
})

// --- edit ---

test('edit replaces a unique occurrence', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  const r = await editFile.run({ path: 'a.txt', old_string: 'two', new_string: 'TWO' }, ctx)
  assert.equal(r.ok, true)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n')
  cleanup(dir)
})

test('edit refuses an ambiguous match and shows the candidates', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.txt'), 'x\nfoo\ny\nfoo\n')
  const r = await editFile.run({ path: 'a.txt', old_string: 'foo', new_string: 'bar' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /appears 2 times/)
  assert.match(r.error ?? '', /line \d+/, 'error names the candidate lines')
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'x\nfoo\ny\nfoo\n', 'untouched')
  cleanup(dir)
})

test('edit with replace_all handles every occurrence', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.txt'), 'foo\nfoo\nfoo\n')
  const r = await editFile.run({ path: 'a.txt', old_string: 'foo', new_string: 'bar', replace_all: true }, ctx)
  assert.equal(r.ok, true)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'bar\nbar\nbar\n')
  cleanup(dir)
})

test('edit distinguishes a missing match from whitespace drift', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.txt'), 'function f() {\n  return 1\n}\n')
  const missing = await editFile.run({ path: 'a.txt', old_string: 'nope', new_string: 'x' }, ctx)
  assert.equal(missing.ok, false)
  assert.doesNotMatch(missing.error ?? '', /whitespace is collapsed/)

  // Same words, different indentation -> the actionable hint.
  const drifted = await editFile.run(
    { path: 'a.txt', old_string: 'function f() { return 1 }', new_string: 'x' },
    ctx,
  )
  assert.equal(drifted.ok, false)
  assert.match(drifted.error ?? '', /whitespace is collapsed/)
  cleanup(dir)
})

test('edit rejects a no-op and an empty old_string', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.txt'), 'x')
  assert.equal((await editFile.run({ path: 'a.txt', old_string: 'x', new_string: 'x' }, ctx)).ok, false)
  assert.equal((await editFile.run({ path: 'a.txt', old_string: '', new_string: 'y' }, ctx)).ok, false)
  cleanup(dir)
})

// --- multi_edit atomicity ---

test('multi_edit applies all edits or none', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n')

  const good = await multiEdit.run(
    { path: 'a.txt', edits: [{ old_string: 'alpha', new_string: 'A' }, { old_string: 'gamma', new_string: 'G' }] },
    ctx,
  )
  assert.equal(good.ok, true)
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A\nbeta\nG\n')

  // Second edit is invalid -> the first must NOT be applied either.
  writeFileSync(join(dir, 'b.txt'), 'one\ntwo\n')
  const bad = await multiEdit.run(
    { path: 'b.txt', edits: [{ old_string: 'one', new_string: '1' }, { old_string: 'absent', new_string: 'x' }] },
    ctx,
  )
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /No edits applied/)
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'one\ntwo\n', 'atomic: file unchanged')
  cleanup(dir)
})

// --- read ---

test('read numbers lines and reports truncation', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.txt'), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n')

  const head = await readFile.run({ path: 'a.txt', offset: 1, limit: 3 }, ctx)
  assert.equal(head.ok, true)
  assert.match(head.output, /^1\tline1\n2\tline2\n3\tline3/)

  const paged = await readFile.run({ path: 'a.txt', offset: 8, limit: 5 }, ctx)
  assert.match(paged.output, /showing from line 8/)
  assert.match(paged.output, /8\tline8/)

  const past = await readFile.run({ path: 'a.txt', offset: 99 }, ctx)
  assert.equal(past.ok, true)
  assert.match(past.output, /past the end/)

  cleanup(dir)
})

test('read rejects directories and missing files with actionable messages', async () => {
  const { dir, ctx } = scratch()
  mkdirSync(join(dir, 'sub'))
  assert.match((await readFile.run({ path: 'sub' }, ctx)).error ?? '', /is a directory/)
  assert.match((await readFile.run({ path: 'nope.txt' }, ctx)).error ?? '', /File not found/)
  cleanup(dir)
})

// --- grep include semantics ---

test('grep matches a rooted include against the relative path', async () => {
  const { dir, ctx } = scratch()
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), 'const bash = 1\n')
  writeFileSync(join(dir, 'other.ts'), 'const bash = 2\n')

  const rooted = await grep.run({ pattern: 'bash', include: 'src/a.ts' }, ctx)
  assert.equal(rooted.ok, true)
  assert.match(rooted.output, /src\/a\.ts:1/)
  assert.doesNotMatch(rooted.output, /other\.ts/)

  const byExt = await grep.run({ pattern: 'bash', include: '*.ts', path: 'src' }, ctx)
  assert.match(byExt.output, /src\/a\.ts:1/)
  assert.doesNotMatch(byExt.output, /other\.ts/, 'path scoping is respected')
  cleanup(dir)
})

test('grep reports an invalid regex instead of throwing', async () => {
  const { ctx, dir } = scratch()
  const r = await grep.run({ pattern: '[' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /Invalid regular expression/)
  cleanup(dir)
})

// --- glob ---

test('glob finds files and skips noise directories', async () => {
  const { dir, ctx } = scratch()
  mkdirSync(join(dir, 'src/deep'), { recursive: true })
  mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), '')
  writeFileSync(join(dir, 'src/deep/b.ts'), '')
  writeFileSync(join(dir, 'node_modules/pkg/c.ts'), '')
  writeFileSync(join(dir, 'README.md'), '')

  const r = await glob.run({ pattern: '**/*.ts' }, ctx)
  assert.equal(r.ok, true)
  assert.match(r.output, /src\/a\.ts/)
  assert.match(r.output, /src\/deep\/b\.ts/)
  assert.doesNotMatch(r.output, /node_modules/)
  cleanup(dir)
})

// --- todo ---

test('todo replaces the list and keeps ids stable for unchanged items', async () => {
  const ctx = scratch().ctx
  const first = await todo.run(
    { todos: [{ content: 'one', status: 'in_progress' }, { content: 'two', status: 'pending' }] },
    ctx,
  )
  assert.equal(first.ok, true)
  assert.match(first.output, /\[~\] one/)
  assert.match(first.output, /\[ \] two/)
  assert.match(first.output, /\(0\/2 complete\)/)
  const idOne = ctx.todos.list()[0]!.id

  const second = await todo.run(
    { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }] },
    ctx,
  )
  assert.match(second.output, /\[x\] one/)
  assert.equal(ctx.todos.list().length, 2, 'list is replaced, not appended')
  assert.equal(ctx.todos.list()[0]!.id, idOne, 'id is stable for the same content')
  assert.match(second.output, /\(1\/2 complete\)/)
})

test('todo accepts plain strings and rejects an empty list', async () => {
  const ctx = scratch().ctx
  assert.equal((await todo.run({ todos: ['alpha', 'beta'] }, ctx)).ok, true)
  assert.equal(ctx.todos.list().length, 2)
  assert.equal((await todo.run({ todos: [] }, ctx)).ok, false)
})
test('a gutter-contaminated old_string is diagnosed explicitly', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.ts'), 'export const x = 1\n  indented: string\n')
  // Simulates the model copying read_file's "2\t" gutter into old_string.
  const r = await editFile.run({ path: 'a.ts', old_string: '2\t  indented: string', new_string: '  y: number' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /line-number gutter/, 'names the actual mistake')
  cleanup(dir)
})

test('a near miss points at the closest real line', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.ts'), 'const alphaBeta = 1\nconst gamma = 2\n')
  // Semicolon present here but absent in the file: a plausible near miss.
  const r = await editFile.run({ path: 'a.ts', old_string: 'const alphaBeta = 1;', new_string: 'x' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /Closest line/)
  assert.match(r.error ?? '', /line 1/)
  cleanup(dir)
})

test('edit and multi_edit accept the key aliases models actually emit', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.ts'), 'alpha\nbeta\n')

  // gpt-oss-120b reliably emits old/new rather than old_string/new_string.
  const single = await editFile.run({ path: 'a.ts', old: 'beta', new: 'BETA' }, ctx)
  assert.equal(single.ok, true, 'edit tolerates old/new')
  assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'alpha\nBETA\n')

  const multi = await multiEdit.run(
    { path: 'a.ts', edits: [{ old: 'alpha', new: 'A' }, { oldStr: 'BETA', newStr: 'B' }] },
    ctx,
  )
  assert.equal(multi.ok, true, 'multi_edit tolerates old/oldStr variants')
  assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'A\nB\n')
  cleanup(dir)
})

test('a malformed edit names the accepted keys and what it received', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.ts'), 'x\n')

  const multi = await multiEdit.run({ path: 'a.ts', edits: [{ find: 'x', replace: 'y' }] }, ctx)
  assert.equal(multi.ok, false)
  assert.match(multi.error ?? '', /old_string/)
  assert.match(multi.error ?? '', /find, replace/, 'reports the keys it actually saw')

  const single = await editFile.run({ path: 'a.ts', find: 'x', replace: 'y' }, ctx)
  assert.equal(single.ok, false)
  assert.match(single.error ?? '', /Accepted key names/)
  cleanup(dir)
})

test('multi_edit refuses the whole batch when any entry is malformed', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'a.ts'), 'alpha\nbeta\n')
  // Entry 1 is valid, entry 2 uses unknown keys. Applying only the first would
  // leave a state the model never described while claiming success.
  const r = await multiEdit.run(
    { path: 'a.ts', edits: [{ old: 'alpha', new: 'A' }, { find: 'beta', replace: 'B' }] },
    ctx,
  )
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /1 of 2/)
  assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'alpha\nbeta\n', 'nothing applied')
  cleanup(dir)
})

test('a single enormous line is clipped instead of exhausting memory', async () => {
  // Regression: the streaming reader was O(n^2) on a file with no newlines and
  // never terminated. A minified bundle would hang the agent.
  const { dir, ctx } = scratch()
  const p = join(dir, 'min.js')
  writeFileSync(p, 'x'.repeat(5 * 1024 * 1024)) // 5MB, one line, no newline
  const t0 = Date.now()
  const r = await readFile.run({ path: 'min.js' }, ctx)
  const ms = Date.now() - t0
  assert.equal(r.ok, true)
  assert.ok(ms < 5000, `took ${ms}ms; expected well under 5s`)
  assert.match(r.output, /truncated, line continues/)
  assert.ok(r.output.length < 4000, `output was ${r.output.length} chars`)
  cleanup(dir)
})

test('a large multi-line file windows correctly and quickly', async () => {
  const { dir, ctx } = scratch()
  const p = join(dir, 'big.txt')
  const rows: string[] = []
  for (let i = 0; i < 200_000; i++) rows.push(`line ${i}`)
  writeFileSync(p, rows.join('\n') + '\n')
  const t0 = Date.now()
  const head = await readFile.run({ path: 'big.txt', limit: 2 }, ctx)
  const mid = await readFile.run({ path: 'big.txt', offset: 100_000, limit: 2 }, ctx)
  const ms = Date.now() - t0
  assert.ok(ms < 5000, `took ${ms}ms`)
  assert.match(head.output, /^1\tline 0\n2\tline 1/)
  assert.match(head.output, /more content follows/)
  assert.match(mid.output, /100000\tline 99999/)
  assert.match(mid.output, /100001\tline 100000/)
  cleanup(dir)
})

test('a trailing line without a newline is still returned', async () => {
  const { dir, ctx } = scratch()
  writeFileSync(join(dir, 'nonl.txt'), 'a\nb\nc')
  const r = await readFile.run({ path: 'nonl.txt' }, ctx)
  assert.match(r.output, /3\tc/)
  cleanup(dir)
})
