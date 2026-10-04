#!/usr/bin/env node
/**
 * Launcher.
 *
 * Prefers the built output (plain JS, no type-stripping requirement). Falls back
 * to running the TypeScript sources directly, which needs Node >= 22.6. That
 * keeps `npm link` / a global install useful straight after clone, before anyone
 * has run the build.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const built = join(root, 'dist', 'cli', 'repl.js')
const source = join(root, 'src', 'cli', 'repl.ts')
const entry = existsSync(built) ? built : source

const res = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(res.status ?? 0)
