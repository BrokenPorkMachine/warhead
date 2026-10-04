/**
 * write_file — create a file or replace its contents wholesale.
 *
 * Refuses to overwrite silently when the target exists and `overwrite` is not
 * set. The model must state intent to destroy existing work, which turns an
 * accidental clobber into something the user sees at the approval prompt.
 */

import { writeFileSync, existsSync, mkdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, isAbsolute, dirname } from 'node:path'
import type { Tool, ToolOutcome } from '../types.ts'
import { reqString, optBool, optInt, ArgError } from './args.ts'

export const MAX_WRITE_BYTES = 5 * 1024 * 1024

export const writeFile: Tool = {
  mutates: true,
  def: {
    name: 'write',
    description:
      'Write a file, creating it and any parent directories if needed. If the file ' +
      'already exists its contents are replaced, which requires `overwrite: true` — ' +
      'read the existing file first rather than guessing its contents. Prefer the ' +
      'edit tool when changing part of an existing file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Full new contents of the file' },
        overwrite: {
          type: 'boolean',
          description: 'Required to replace an existing file. Omit for new files.',
        },
      },
      required: ['path', 'content'],
    },
  },

  async run(args, ctx): Promise<ToolOutcome> {
    let path: string
    let content: string
    let overwrite: boolean
    try {
      path = reqString(args, 'path')
      const c = args['content']
      if (typeof c !== 'string') throw new ArgError("missing required parameter 'content'")
      content = c
      overwrite = optBool(args, 'overwrite') ?? false
    } catch (err) {
      return { ok: false, output: '', error: err instanceof ArgError ? err.message : String(err) }
    }

    const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path)
    const existed = existsSync(abs)

    if (existed) {
      let st
      try {
        st = statSync(abs)
      } catch {
        return { ok: false, output: '', error: `Cannot stat ${abs}` }
      }
      if (st.isDirectory()) return { ok: false, output: '', error: `${abs} is a directory` }
      if (!overwrite) {
        const prev = readFileSync(abs, 'utf8')
        const prevLines = prev === '' ? 0 : prev.split('\n').length
        return {
          ok: false,
          output: '',
          error:
            `${abs} already exists (${st.size} bytes, ${prevLines} lines) and overwrite was not set. ` +
            `Read it first if you intend to modify it, or use the edit tool for a partial change.`,
        }
      }
    }

    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_WRITE_BYTES) {
      return {
        ok: false,
        output: '',
        error: `Refusing to write ${bytes} bytes to ${abs}; limit is ${MAX_WRITE_BYTES}.`,
      }
    }

    try {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf8')
    } catch (err) {
      return { ok: false, output: '', error: `Cannot write ${abs}: ${(err as Error).message}` }
    }

    const lines = content === '' ? 0 : content.split('\n').length
    const verb = existed ? 'Overwrote' : 'Created'
    return {
      ok: true,
      output: `${verb} ${abs} (${lines} line(s), ${bytes} bytes).`,
    }
  },
}