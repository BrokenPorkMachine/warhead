/**
 * Session transcripts.
 *
 * JSONL, one event per line, so a session can be `grep`'d and `tail`'ed without
 * loading it. The transcript is for reconstructing and inspecting what the agent
 * did — not a byte-exact log — so large tool results are truncated on the way in.
 *
 * Eviction is LRU over the whole directory by total size. Per-file caps were
 * rejected because a single enormous session would then be un-evictable.
 */

import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
  createWriteStream,
  type WriteStream,
} from 'node:fs'
import { join } from 'node:path'
import { transcriptDir } from '../config.ts'

export type TranscriptEvent =
  | { kind: 'session_start'; ts: string; cwd: string; model: string; pid: number }
  | { kind: 'turn'; ts: string; user: string }
  | { kind: 'assistant'; ts: string; text: string }
  | { kind: 'tool_call'; ts: string; name: string; args: unknown }
  | { kind: 'tool_result'; ts: string; name: string; ok: boolean; output: string }
  | { kind: 'stop'; ts: string; reason: string; steps: number }
  | { kind: 'note'; ts: string; text: string }

function stamp(): string {
  return new Date().toISOString()
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session'
}

export class Transcript {
  private stream: WriteStream | null = null
  private path = ''
  readonly enabled: boolean
  private readonly maxResultBytes: number

  constructor(enabled: boolean, maxResultBytes: number) {
    this.enabled = enabled
    this.maxResultBytes = maxResultBytes
  }

  get file(): string {
    return this.path
  }

  start(info: { cwd: string; model: string }): void {
    if (!this.enabled) return
    const dir = transcriptDir()
    mkdirSync(dir, { recursive: true })
    const name = `${stamp().replace(/[:.]/g, '-')}_${slug(info.cwd.split('/').pop() ?? 'session')}.jsonl`
    this.path = join(dir, name)
    this.stream = createWriteStream(this.path, { flags: 'a' })
    this.write({ kind: 'session_start', ts: stamp(), cwd: info.cwd, model: info.model, pid: process.pid })
  }

  private write(ev: TranscriptEvent): void {
    if (!this.stream) return
    try {
      this.stream.write(JSON.stringify(ev) + '\n')
    } catch {
      /* never let logging break the session */
    }
  }

  turn(user: string): void {
    this.write({ kind: 'turn', ts: stamp(), user })
  }

  assistant(text: string): void {
    this.write({ kind: 'assistant', ts: stamp(), text })
  }

  toolCall(name: string, args: unknown): void {
    this.write({ kind: 'tool_call', ts: stamp(), name, args })
  }

  toolResult(name: string, ok: boolean, output: string): void {
    const clipped =
      output.length > this.maxResultBytes
        ? `${output.slice(0, this.maxResultBytes)} …[truncated ${output.length - this.maxResultBytes} chars]`
        : output
    this.write({ kind: 'tool_result', ts: stamp(), name, ok, output: clipped })
  }

  stop(reason: string, steps: number): void {
    this.write({ kind: 'stop', ts: stamp(), reason, steps })
  }

  note(text: string): void {
    this.write({ kind: 'note', ts: stamp(), text })
  }

  close(): void {
    this.stream?.end()
    this.stream = null
  }
}

/** Total bytes of all transcripts. Missing/unreadable files count as zero. */
export function transcriptBytes(dir = transcriptDir()): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    try {
      total += statSync(join(dir, f)).size
    } catch {
      /* raced with eviction */
    }
  }
  return total
}

export type EvictionReport = {
  removed: string[]
  freedBytes: number
  bytesAfter: number
}

/** Delete oldest transcripts until the directory fits `maxBytes`. The current
 *  session's file is never evicted — losing the log of a live session would be
 *  the wrong trade. */
export function evictTranscripts(maxBytes: number, keepPath?: string): EvictionReport {
  const dir = transcriptDir()
  if (!existsSync(dir)) return { removed: [], freedBytes: 0, bytesAfter: 0 }

  const entries: Array<{ file: string; size: number; mtime: number }> = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    const full = join(dir, f)
    try {
      const st = statSync(full)
      entries.push({ file: full, size: st.size, mtime: st.mtimeMs })
    } catch {
      /* skip */
    }
  }

  entries.sort((a, b) => a.mtime - b.mtime)
  let total = entries.reduce((n, e) => n + e.size, 0)
  const removed: string[] = []
  let freed = 0

  for (const e of entries) {
    if (total <= maxBytes) break
    if (keepPath && e.file === keepPath) continue
    try {
      unlinkSync(e.file)
      removed.push(e.file)
      freed += e.size
      total -= e.size
    } catch {
      /* skip */
    }
  }

  return { removed, freedBytes: freed, bytesAfter: total }
}

export function clearTranscripts(): number {
  const dir = transcriptDir()
  if (!existsSync(dir)) return 0
  let n = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    try {
      unlinkSync(join(dir, f))
      n++
    } catch {
      /* skip */
    }
  }
  return n
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}