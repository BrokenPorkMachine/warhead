/**
 * The agent loop.
 *
 * One user turn = stream assistant text, collect tool calls, execute them, feed
 * results back, repeat until the model answers without tools or a stop
 * condition fires.
 *
 * Stop conditions are enforced in code rather than requested in the prompt.
 * A model asked politely not to loop will still loop; a counter will not.
 */

import { streamChat, isTransient } from '../model/client.ts'
import type { Registry } from '../tools/registry.ts'
import type { ChatMessage, ToolCall, ToolContext, ToolOutcome } from '../types.ts'
import { systemPrompt } from '../prompt/system.ts'
import { fetchModelSystemPrompt, composeSystemPrompt, fetchModelContextLength } from '../model/modelfile.ts'
import type { Config } from '../config.ts'

export type LoopEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; name: string; outcome: ToolOutcome & { name: string } }
  | { type: 'stop'; reason: StopReason; steps: number }
  | { type: 'error'; message: string }

/** How many times to retry a transient upstream failure within one turn. */
const TRANSIENT_RETRIES = 2

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(res => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      res()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      res()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export type StopReason =
  | 'answered'
  | 'max_steps'
  | 'repeat_suppressed'
  | 'cancelled'
  | 'transport_error'

export type LoopResult = {
  stopReason: StopReason
  steps: number
  messages: ChatMessage[]
}

export type RunOptions = {
  model: string
  registry: Registry
  config: Config
  ctx: ToolContext
  history: ChatMessage[]
  userText: string
  signal: AbortSignal
  /** Called with each tool invocation so the caller can approve or deny. Absent
   *  means no gating — valid in Phase 1 where every tool is read-only. */
  onToolStart?: (call: ToolCall) => Promise<boolean>
  onEvent?: (ev: LoopEvent) => void
}

/** Stable identity for repeat-call suppression. Deliberately ignores argument
 *  ordering noise but not values, so `read(a)` twice is caught while
 *  `read(a)` then `read(b)` is not. */
function callSignature(call: ToolCall): string {
  const keys = Object.keys(call.args).sort()
  const norm = keys.map(k => `${k}=${JSON.stringify((call.args as Record<string, unknown>)[k])}`).join(',')
  return `${call.name}(${norm})`
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Tracks which line ranges of which files have already been read.
 *
 *  Byte-identical detection is not enough for reads. Observed against
 *  gpt-oss-120b: after a failed edit it re-read the same region of the same file
 *  with the offset jittered by a line or two each time — read(a,44,20),
 *  read(a,45,20), read(a,46,20) — which sailed past an exact-match check and
 *  burned a dozen steps. Overlap-based coverage catches the whole family. */
export class ReadCoverage {
  private seen = new Map<string, Array<[number, number]>>()

  /** True when the requested range is already (almost) entirely covered. */
  isRedundant(path: string, offset: number, limit: number): boolean {
    const ranges = this.seen.get(path)
    if (!ranges || ranges.length === 0) return false
    const start = offset
    const end = offset + Math.max(1, limit)
    const overlapping = ranges
      .map(([s, e]): [number, number] => [Math.max(start, s), Math.min(end, e)])
      .filter(([s, e]) => s < e)
      .sort(([a], [b]) => a - b)
    let covered = 0
    let through = start
    for (const [s, e] of overlapping) {
      covered += Math.max(0, e - Math.max(s, through))
      through = Math.max(through, e)
    }
    return covered >= Math.max(1, Math.ceil((end - start) * 0.8))
  }

  record(path: string, offset: number, limit: number): void {
    const ranges = this.seen.get(path) ?? []
    ranges.push([offset, offset + Math.max(1, limit)])
    // Keep the set bounded; only recent reads matter for loop detection.
    if (ranges.length > 40) ranges.splice(0, ranges.length - 40)
    this.seen.set(path, ranges)
  }

  reset(): void {
    this.seen.clear()
  }
}

function readWindow(call: ToolCall): { path: string; offset: number; limit: number } | null {
  if (call.name !== 'read_file') return null
  const path = call.args['path']
  if (typeof path !== 'string' || path === '') return null
  return {
    path,
    offset: asInt(call.args['offset']) ?? 1,
    limit: asInt(call.args['limit']) ?? 2000,
  }
}

export async function runTurn(opts: RunOptions): Promise<LoopResult> {
  const { model, registry, config, ctx, history, userText, signal } = opts
  const emit = opts.onEvent ?? (() => {})

  // The model's own default system prompt is preserved ahead of ours: sending a
  // system message replaces the Modelfile default, so omitting it would discard
  // behaviour the model was tuned with (for gpt-oss, its reasoning-depth loop).
  const modelDefault = await fetchModelSystemPrompt(model)
  const modelContextTokens = await fetchModelContextLength(model)

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: composeSystemPrompt(
        modelDefault,
        systemPrompt({ cwd: ctx.cwd, tools: registry.tools, config }),
      ),
    },
    ...history,
    { role: 'user', content: userText },
  ]

  const seen = new Map<string, number>()
  const coverage = new ReadCoverage()
  const maxSteps = Math.max(1, config.limits.maxSteps)

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) {
      emit({ type: 'stop', reason: 'cancelled', steps: step - 1 })
      return { stopReason: 'cancelled', steps: step - 1, messages }
    }

    // --- assistant turn -------------------------------------------------
    // A transient upstream failure (5xx, 429, dropped connection) is retried
    // rather than ending the turn: losing a half-finished multi-step task to a
    // proxy blip is far worse than a short wait. Fatal errors are not retried,
    // since a 400 will just fail again.
    let text = ''
    const calls: ToolCall[] = []
    let attempt = 0
    let lastErr: unknown

    while (true) {
      text = ''
      calls.length = 0
      try {
        for await (const ev of streamChat(model, messages, {
          tools: registry.definitions(),
          signal,
          ...(modelContextTokens != null ? { numCtx: modelContextTokens } : {}),
        })) {
          if (ev.type === 'text') {
            text += ev.delta
            emit({ type: 'text', delta: ev.delta })
          } else if (ev.type === 'tool_call') {
            // Ollama can repeat a name across frames while streaming; dedupe by id.
            if (!calls.some(c => c.id === ev.call.id)) calls.push(ev.call)
          }
        }
        lastErr = undefined
        break
      } catch (err) {
        if (signal.aborted) {
          emit({ type: 'stop', reason: 'cancelled', steps: step - 1 })
          return { stopReason: 'cancelled', steps: step - 1, messages }
        }
        lastErr = err
        if (isTransient(err) && attempt < TRANSIENT_RETRIES) {
          attempt++
          const backoff = 400 * 2 ** (attempt - 1)
          emit({
            type: 'error',
            message: `transient model error, retrying in ${backoff}ms (${attempt}/${TRANSIENT_RETRIES}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          })
          await sleep(backoff, signal)
          continue
        }
        break
      }
    }

    if (lastErr !== undefined) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr)
      emit({ type: 'error', message: msg })
      messages.push({ role: 'assistant', content: text || '(no output)' })
      emit({ type: 'stop', reason: 'transport_error', steps: step - 1 })
      return { stopReason: 'transport_error', steps: step - 1, messages }
    }

    if (calls.length === 0) {
      messages.push({ role: 'assistant', content: text })
      emit({ type: 'stop', reason: 'answered', steps: step - 1 })
      return { stopReason: 'answered', steps: step - 1, messages }
    }

    messages.push({ role: 'assistant', content: text, toolCalls: calls })

    // --- tool execution -------------------------------------------------
    // Sequential rather than parallel: a model may emit calls that depend on
    // each other's results, and correctness matters more than latency here.
    for (const call of calls) {
      if (signal.aborted) {
        emit({ type: 'stop', reason: 'cancelled', steps: step - 1 })
        return { stopReason: 'cancelled', steps: step - 1, messages }
      }

      const win = readWindow(call)

      // Check BEFORE recording. Recording first makes every read overlap itself
      // and flags even the first, legitimate read of a file.
      const redundantRead = win !== null && coverage.isRedundant(win.path, win.offset, win.limit)
      if (win) coverage.record(win.path, win.offset, win.limit)

      // A read the model has effectively already seen counts against the same
      // repeat budget as a byte-identical call, otherwise jittered offsets walk
      // straight past the check.
      const sig = redundantRead ? `read-coverage:${win!.path}` : callSignature(call)
      const prior = seen.get(sig) ?? 0
      seen.set(sig, prior + 1)
      if (prior + 1 > config.limits.repeatCallLimit) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: redundantRead
            ? `You have already read this region of ${win!.path} ${prior} time(s) with only the ` +
              `offset or limit changing slightly. The content is the same. Either you have what you ` +
              `need — use it — or you need something different: read a different file, read a much ` +
              `wider window, or ask the user what to do.`
            : `Refusing to repeat '${call.name}' with identical arguments — this exact call has ` +
              `already been attempted ${prior} time(s). Change the arguments, use a different tool, ` +
              `or explain to the user what is blocking you.`,
        })
        emit({ type: 'stop', reason: 'repeat_suppressed', steps: step - 1 })
        return { stopReason: 'repeat_suppressed', steps: step - 1, messages }
      }

      if (opts.onToolStart) {
        const allowed = await opts.onToolStart(call)
        if (!allowed) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: 'The user denied this tool call. Do not retry it unchanged; adjust or ask what to do instead.',
          })
          emit({
            type: 'tool_end',
            name: call.name,
            outcome: { name: call.name, ok: false, output: 'denied by user', error: 'denied by user' },
          })
          continue
        }
      }

      emit({ type: 'tool_start', id: call.id, name: call.name, args: call.args })
      const outcome = await registry.dispatch(call.name, call.args, ctx)
      emit({ type: 'tool_end', name: call.name, outcome })

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: outcome.output || outcome.error || '(no output)',
      })
    }
  }

  messages.push({
    role: 'user',
    content:
      `You have used all ${maxSteps} tool-call steps for this turn. Summarize what you found ` +
      `and what remains, and do not call more tools.`,
  })
  emit({ type: 'stop', reason: 'max_steps', steps: maxSteps })
  return { stopReason: 'max_steps', steps: maxSteps, messages }
}

/** Drop the system message and return the rest as persistable history. */
export function toHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(m => m.role !== 'system')
}

export function describeStop(r: StopReason, steps: number): string {
  switch (r) {
    case 'answered':
      return `answered after ${steps} tool step(s)`
    case 'max_steps':
      return `stopped at the ${steps}-step ceiling`
    case 'repeat_suppressed':
      // Also fires for overlap-detected re-reads, not only byte-identical calls.
      return `stopped: repeated tool call with no new information`
    case 'cancelled':
      return 'cancelled'
    case 'transport_error':
      return 'stopped: model transport error'
  }
}
