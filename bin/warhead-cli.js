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
// `rea` is a directly-executed subcommand, not a REPL prompt: the REPL takes no
// arguments, so routing it there would start a model session and ignore it.
const wantsRea = args[0] === 'rea' || args[0] === '--rea'

/** Run a Node entry with inherited stdio and propagate its exit status.
 *
 *  The child runs in this process's group, so a terminal's Ctrl-C reaches both.
 *  The REPL implements a deliberate two-stage handler (first interrupt cancels
 *  the turn, second exits); if this launcher kept the default SIGINT disposition
 *  it would die immediately and take the session with it, leaving the child
 *  orphaned mid-turn. Staying out of the way lets the child own the signal. */
function run(entry, childArgs) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {})
  }
  const res = spawnSync(process.execPath, [entry, ...childArgs], { stdio: 'inherit' })
  // A child killed by a signal reports status === null. Collapsing that to 0
  // with `?? 0` turns a crash into a success, which matters because CI and the
  // installer's verification both branch on this exit code. 128 + signum is what
  // a shell reports for the same death.
  process.exitCode = res.signal ? 128 + (signalNumbers.signals[res.signal] ?? 0) : (res.status ?? 0)
}

// No process.exit() anywhere in this file. On a pipe stdout is async, so exiting
// immediately after a write can truncate it — and the one consumer that matters
// is the installer, which reads exactly this output. Setting exitCode and
// returning lets Node flush before the process ends.
if (wantsVersion) {
  process.stdout.write(`${readVersion()}\n`)
} else if (wantsHelp) {
  process.stdout.write(
    `warhead-cli ${readVersion()} — a private coding agent for local MLX and GGUF models

Usage
  warhead-cli            start the interactive REPL (reads stdin, so it can be piped)
  warhead-cli rea ...    run the bundled reverse-engineer-anything CLI
  warhead-cli --version  print the version
  warhead-cli --help     this message

The REPL takes no arguments of its own; it is driven by slash commands, which
\`warhead-cli --help\` cannot enumerate without booting it. Type /help at the
prompt for that list.

Requires macOS 14+, Apple silicon, Node 22.19+, 24.11+, or 26+, and Xcode plus
its Metal Toolchain for the native runtime. Choose mlx:<HuggingFaceRepo>,
ollama:<local-tag>, or gguf:<path> in WARHEAD_MODEL or config. See README.md.
`,
  )
} else if (wantsRea) {
  const entry = join(root, 'rea', 'scripts', 'rea.mjs')
  if (!existsSync(entry)) {
    process.stderr.write(`warhead-cli: bundled REA is missing (${entry})\n`)
    process.exitCode = 1
  } else {
    run(entry, args.slice(1))
  }
} else {
  const built = join(root, 'dist', 'cli', 'repl.js')
  const source = join(root, 'src', 'cli', 'repl.ts')
  const entry = existsSync(built) ? built : source
  run(entry, args)
}
