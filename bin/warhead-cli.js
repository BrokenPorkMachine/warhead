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
 * version is read from package.json so there is no second copy to drift, and is
 * printed bare so it stays machine-parseable.
 */

import { existsSync, readFileSync } from 'node:fs'
import { constants as signalNumbers } from 'node:os'
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

// Exactly one argument, so `warhead-cli --version extra` still reaches the REPL
// rather than silently printing a version and dropping what the user meant.
const wantsVersion = args.length === 1 && (args[0] === '--version' || args[0] === '-v')
const wantsHelp = args.length === 1 && (args[0] === '--help' || args[0] === '-h')

// No process.exit() anywhere in this file. On a pipe stdout is async, so exiting
// immediately after a write can truncate it — and the one consumer that matters
// is the installer, which reads exactly this output. Setting exitCode and
// returning lets Node flush before the process ends.
if (wantsVersion) {
  process.stdout.write(`${readVersion()}\n`)
} else if (wantsHelp) {
  process.stdout.write(
    `warhead-cli ${readVersion()} — Warhead: MGCA (Military Grade Coding Agent) for HindSight Reverse Engineering Studio

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
} else {
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

  // A child killed by a signal reports status === null. Collapsing that to 0
  // with `?? 0` turns a crash into a success, which matters because CI and the
  // installer's verification both branch on this exit code. 128 + signum is what
  // a shell reports for the same death.
  process.exitCode = res.signal ? 128 + (signalNumbers.signals[res.signal] ?? 0) : (res.status ?? 0)
}
