/**
 * glob — find files by name pattern.
 *
 * Results are sorted newest-first because the common question is "what changed"
 * or "what is new", and recency answers that faster than alphabetical order.
 */

import { readdirSync, statSync } from 'node:fs'
import { resolve, isAbsolute, join, basename } from 'node:path'
import type { Tool, ToolOutcome } from '../types.ts'
import { reqString, optString, optInt, ArgError } from './args.ts'

const DEFAULT_LIMIT = 200
const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'dist', 'build', '.next'])

/** Translate a glob to a RegExp. Supports **, *, ?, and character classes. */
export function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches all.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') out += '[^/]'
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end === -1) out += '\\['
      else {
        out += pattern.slice(i, end + 1)
        i = end
      }
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

function walk(root: string, depth: number, acc: string[]): void {
  if (depth > 12) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue
    if (ALWAYS_SKIP.has(e.name)) continue
    const full = join(root, e.name)
    if (e.isDirectory()) walk(full, depth + 1, acc)
    else if (e.isFile()) acc.push(full)
  }
}

export const glob: Tool = {
  mutates: false,
  def: {
    name: 'glob',
    description:
      'Find files whose path matches a glob pattern, sorted by modification time ' +
      '(newest first). Patterns are matched against the full path relative to the ' +
      'search directory. Use this to locate files by name; use grep to search contents.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "**/*.ts" or "src/**/index.ts"',
        },
        path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
        limit: { type: 'integer', description: `Maximum results. Defaults to ${DEFAULT_LIMIT}.` },
      },
      required: ['pattern'],
    },
  },

  async run(args, ctx): Promise<ToolOutcome> {
    let pattern: string
    let baseArg: string | undefined
    let limit: number
    try {
      pattern = reqString(args, 'pattern')
      baseArg = optString(args, 'path')
      limit = optInt(args, 'limit', 1) ?? DEFAULT_LIMIT
    } catch (err) {
      return { ok: false, output: '', error: err instanceof ArgError ? err.message : String(err) }
    }

    const base = isAbsolute(baseArg ?? '') ? baseArg! : resolve(ctx.cwd, baseArg ?? '.')
    try {
      if (!statSync(base).isDirectory()) {
        return { ok: false, output: '', error: `${base} is not a directory.` }
      }
    } catch {
      return { ok: false, output: '', error: `Directory not found: ${base}` }
    }

    const re = globToRegExp(pattern)
    const candidates: string[] = []
    walk(base, 0, candidates)

    const hits: Array<{ path: string; mtime: number }> = []
    for (const full of candidates) {
      const rel = full.startsWith(base + '/') ? full.slice(base.length + 1) : full
      if (re.test(rel) || re.test(basename(full))) {
        try {
          hits.push({ path: full, mtime: statSync(full).mtimeMs })
        } catch {
          /* raced with a delete; skip */
        }
      }
    }
    hits.sort((a, b) => b.mtime - a.mtime)

    if (hits.length === 0) {
      return { ok: true, output: `No files matched ${pattern} under ${base}.` }
    }

    const shown = hits.slice(0, limit)
    const lines = shown.map(h => h.path)
    if (hits.length > shown.length) {
      lines.push(`[${hits.length - shown.length} more match(es); raise 'limit' to see them]`)
    }
    return { ok: true, output: `${hits.length} match(es):\n${lines.join('\n')}` }
  },
}