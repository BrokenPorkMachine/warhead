#!/usr/bin/env node
/**
 * warhead-cli — launcher.
 *
 * Prefers the built output (plain JS, no type-stripping requirement). Falls back
 * to running the TypeScript sources directly, which needs Node >= 22.6. That
 * keeps `npm link` / a global install useful straight after clone, before anyone
 * has run the build.
 *
 * `--version` and `--help` are answered here rather than in the REPL so they stay
 * instant and work with no model reachable — an installer verifies the install
 * with `--version`, and that check must not depend on Ollama being up. The
 * version is read from package.json so there is no second copy to drift.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

const args = process.argv.slice(2)

if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
  process.stdout.write(`${readVersion()}\n`)
  process.exit(0)
}

if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  process.stdout.write(
    `warhead-cli ${readVersion()} — a private agentic coding tool for Ollama-hosted models

Usage
  warhead-cli            start the interactive REPL (reads stdin, so it can be piped)
  warhead-cli --version  print the version
  warhead-cli --help     this message

The REPL takes no arguments of its own; it is driven by slash commands, which
\`warhead-cli --help\` cannot enumerate without booting it. Type /help at the
prompt for that list.

Requires Node >= 22.6 (or a build in dist/) and an Ollama model that emits tool
calls. See README.md.
`,
  )
  process.exit(0)
}

// The child runs in this process's group with inherited stdio, so a terminal's
// Ctrl-C reaches both. The REPL implements a deliberate two-stage handler
// (first interrupt cancels the turn, second exits); if this launcher kept the
// default SIGINT disposition it would die immediately and take the session with
// it, and the child would be orphaned mid-turn. Staying out of the way lets the
// child own the signal.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {})
}

const built = join(root, 'dist', 'cli', 'repl.js')
const source = join(root, 'src', 'cli', 'repl.ts')
const entry = existsSync(built) ? built : source

const res = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' })
process.exit(res.status ?? 0)
