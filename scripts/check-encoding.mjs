#!/usr/bin/env node
/**
 * Guard against binary corruption in text sources.
 *
 * A NUL byte in a source file is invisible to review, passes `tsc --noEmit`, and
 * passes the whole test suite — it was found here only because `file` reported
 * the module as "data" while grep had started calling it binary. It had been
 * sitting in a template literal, where it happened to still work as a string
 * separator, so nothing failed. That is the worst failure mode: silently
 * tolerated, and one keystroke away from being a real bug.
 *
 * Checks tracked text files for NUL bytes and invalid UTF-8. Cheap, and it turns
 * a class of invisible corruption into a build failure.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sh', '.md', '.yml', '.yaml', '.txt',
])

// Extensions that are legitimately binary even under a text-ish name.
const SKIP = new Set(['package-lock.json'])

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter(Boolean)
}

const problems = []
let checked = 0

for (const file of trackedFiles()) {
  if (SKIP.has(file)) continue
  if (!TEXT_EXT.has(extname(file))) continue
  let bytes
  try {
    if (statSync(file).size > 8 * 1024 * 1024) continue
    bytes = readFileSync(file)
  } catch {
    continue // deleted or unreadable between ls-files and read
  }
  checked++

  const nul = bytes.indexOf(0)
  if (nul !== -1) {
    // Show the surrounding text with the NUL made visible, since a raw dump of
    // it is indistinguishable from the bytes either side of it.
    const ctx = bytes.subarray(Math.max(0, nul - 30), nul + 15).toString('utf8')
    problems.push(`${file}: NUL byte at offset ${nul} — near ${JSON.stringify(ctx)}`)
    continue
  }

  // A lone surrogate or a bad continuation byte survives as invalid UTF-8. Round
  // tripping through TextDecoder is the same check editors and git use.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (err) {
    problems.push(`${file}: not valid UTF-8 — ${err instanceof Error ? err.message : String(err)}`)
  }
}

if (problems.length > 0) {
  console.error(`encoding check failed (${problems.length} problem(s)):`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

console.log(`✓ ${checked} text file(s) clean of NUL bytes and valid UTF-8`)
