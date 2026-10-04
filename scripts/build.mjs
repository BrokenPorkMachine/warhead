#!/usr/bin/env node
/**
 * Build to dist/ — plain JavaScript, runnable on Node without type stripping.
 *
 * The source deliberately uses `./foo.ts` specifiers so `node src/cli/repl.ts`
 * runs with zero build steps (Node 22.6+ strips the types). That convenience has
 * two costs for packaging:
 *
 *   1. `allowImportingTsExtensions` may only be used with `noEmit`, so tsc
 *      refuses to emit at all.
 *   2. Even if it emitted, tsc does not rewrite specifiers, so the output would
 *      import './foo.ts' from a '.js' file.
 *
 * Rather than give up zero-build development, the build stages a copy of src/
 * with specifiers rewritten to '.js', then typechecks and emits that. The
 * developer's source tree is never modified.
 */

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const stageDir = join(root, '.build')
const outDir = join(root, 'dist')

function walk(dir, extensions, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out // directory may not exist yet
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, extensions, out)
    else if (extensions.includes(extname(entry.name)) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function rewriteSpecifiers(code) {
  // Relative and absolute-from-root specifiers only. Bare package specifiers must
  // be left alone: nothing legitimate ends in `.ts` there.
  return code.replace(
    /((?:from|import|require)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]*?)\.ts\2/g,
    (_m, pre, q, spec) => `${pre}${q}${spec}.js${q}`,
  )
}

console.log('· staging src/ with .js specifiers')
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
const files = walk(srcDir, ['.ts', '.tsx'])
for (const f of files) {
  const rel = relative(srcDir, f)
  const dest = join(stageDir, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, rewriteSpecifiers(readFileSync(f, 'utf8')))
}
console.log(`  ${files.length} file(s) staged`)

console.log('· typechecking staged sources')
const tsconfigPath = join(root, 'tsconfig.build.json')
const tsc = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'), '-p', tsconfigPath],
  { cwd: root, encoding: 'utf8' },
)
if (tsc.stdout?.trim()) console.log(tsc.stdout.trim())
if (tsc.stderr?.trim()) console.error(tsc.stderr.trim())
if (tsc.status !== 0) {
  console.error('\nbuild failed: type errors (above)')
  process.exit(tsc.status ?? 1)
}

console.log('· verifying no .ts specifiers survived')
const emitted = walk(outDir, ['.js'])
if (emitted.length === 0) {
  console.error('\nbuild failed: tsc reported success but emitted nothing')
  process.exit(1)
}
const stragglers = []
for (const f of emitted) {
  const code = readFileSync(f, 'utf8')
  if (/(?:from|import|require)\s*\(?\s*['"]\.{1,2}\/[^'"]*\.ts['"]/.test(code)) stragglers.push(f)
}
if (stragglers.length > 0) {
  console.error(`\nbuild failed: ${stragglers.length} file(s) still import .ts:`)
  for (const s of stragglers.slice(0, 10)) console.error(`  ${relative(root, s)}`)
  process.exit(1)
}

const totalBytes = emitted.reduce((n, f) => n + statSync(f).size, 0)
console.log(`\n✓ built ${emitted.length} file(s) -> dist/ (${(totalBytes / 1024).toFixed(0)} KB)`)
console.log('  run with: node dist/cli/repl.js')