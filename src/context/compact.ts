/**
 * Context compaction.
 *
 * Only ever runs at a TURN BOUNDARY, never mid-turn. Mid-turn compaction would
 * have to drop or synthesize tool results, and an orphaned `tool` message — one
 * whose preceding assistant `tool_calls` entry was removed — makes the next
 * request malformed. Between turns the last message is always assistant prose,
 * so any contiguous slice is safe to replace.
 *
 * The summary is injected as a user-role message rather than a system one. It is
 * a record of what happened, not an instruction, and keeping it in the user role
 * avoids competing with the real system prompt for authority.
 */

import { chatOnce } from '../model/client.ts'
import type { ChatMessage } from '../types.ts'

export type CompactionOptions = {
  model: string
  /** Rough char budget for the whole conversation. ~4 chars per token. */
  thresholdChars: number
  /** How many trailing messages to preserve verbatim. */
  keepRecent: number
  signal?: AbortSignal
  /** Context window to allocate for the summarizer request. */
  numCtx?: number
}

export type CompactionResult = {
  messages: ChatMessage[]
  compacted: boolean
  summary?: string
  /** Set when compaction was attempted but failed; caller keeps the original. */
  error?: string
  charsBefore: number
  charsAfter: number
}

export function approxTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

export function conversationChars(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    n += m.content.length
    for (const c of m.toolCalls ?? []) n += JSON.stringify(c.args).length + c.name.length
  }
  return n
}

const SUMMARY_INSTRUCTIONS = `You are compacting an ongoing coding session so it can continue with less history.

Write a dense factual summary covering, in this order:
1. The user's goal and any explicit constraints they stated.
2. What has been established: files read, files changed, commands run and their outcomes.
3. Current state: what works, what is unfinished, what failed and why.
4. The immediate next step.

Rules:
- Be specific. Cite file paths and identifiers. Never write "the code" or "some files".
- Preserve exact error messages and command output that still matter.
- Do not invent anything. If something was not established, do not claim it.
- Do not address the reader. No preamble, no summary-of-summary. Plain factual notes.
- Aim for brevity over completeness, but do not drop a file path or an error string.`

/** Render messages compactly for the summarizer. */
function renderForSummary(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      lines.push(`USER: ${m.content}`)
    } else if (m.role === 'assistant') {
      if (m.content.trim() !== '') lines.push(`ASSISTANT: ${m.content}`)
      for (const c of m.toolCalls ?? []) {
        lines.push(`ASSISTANT called ${c.name}(${JSON.stringify(c.args).slice(0, 300)})`)
      }
    } else {
      const out = m.content.length > 1200 ? `${m.content.slice(0, 1200)} …[truncated]` : m.content
      lines.push(`RESULT ${m.toolName ?? ''}: ${out}`)
    }
  }
  return lines.join('\n')
}

export async function compactIfNeeded(
  messages: ChatMessage[],
  opts: CompactionOptions,
): Promise<CompactionResult> {
  const charsBefore = conversationChars(messages)
  if (charsBefore <= opts.thresholdChars) {
    return { messages, compacted: false, charsBefore, charsAfter: charsBefore }
  }

  const system = messages.find(m => m.role === 'system')
  const body = messages.filter(m => m.role !== 'system')

  if (body.length <= opts.keepRecent) {
    return {
      messages,
      compacted: false,
      charsBefore,
      charsAfter: charsBefore,
      error: 'nothing left to compact',
    }
  }

  const older = body.slice(0, body.length - opts.keepRecent)
  const recent = body.slice(body.length - opts.keepRecent)
  const transcript = renderForSummary(older)

  if (transcript.trim() === '') {
    return { messages, compacted: false, charsBefore, charsAfter: charsBefore }
  }

  let summary: string
  try {
    const { content } = await chatOnce(
      opts.model,
      [
        { role: 'system', content: SUMMARY_INSTRUCTIONS },
        { role: 'user', content: transcript },
      ],
      { numPredict: 1200, ...(opts.numCtx != null ? { numCtx: opts.numCtx } : {}), ...(opts.signal ? { signal: opts.signal } : {}) },
    )
    summary = content.trim()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { messages, compacted: false, charsBefore, charsAfter: charsBefore, error: msg }
  }

  if (summary === '') {
    return {
      messages,
      compacted: false,
      charsBefore,
      charsAfter: charsBefore,
      error: 'summarizer returned nothing',
    }
  }

  const note: ChatMessage = {
    role: 'user',
    content:
      `[compacted: ${older.length} earlier message(s) summarized to preserve context]\n\n${summary}`,
  }

  const rebuilt: ChatMessage[] = [...(system ? [system] : []), note, ...recent]
  const charsAfter = conversationChars(rebuilt)

  // A summary can be longer than what it replaced — short exchanges compress
  // badly. Keeping the original in that case is strictly better, since the point
  // of compaction is to reduce size, and the next turn will exceed the threshold
  // again anyway once more history accumulates.
  if (charsAfter >= charsBefore) {
    return {
      messages,
      compacted: false,
      charsBefore,
      charsAfter: charsBefore,
      error: `summary was not smaller (${charsBefore} -> ${charsAfter} chars); keeping full history`,
    }
  }

  return { messages: rebuilt, compacted: true, summary, charsBefore, charsAfter }
}