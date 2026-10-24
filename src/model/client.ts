/**
 * Ollama chat client.
 *
 * Plain HTTP + JSON against the local Ollama daemon — no SDK. Streams NDJSON
 * from /api/chat and assembles tool calls across events, since a single
 * tool call may be split across several stream frames.
 */

import type { ChatMessage, ToolCall, ToolDef } from '../types.ts'
import { providerForModel, authHeaders } from './provider.ts'

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; evalCount: number; promptEvalCount: number }

export type ChatOptions = {
  /** Flat definitions; wrapped into the /api/chat envelope here. */
  tools?: ToolDef[]
  /** Hard ceiling on generated tokens. */
  numPredict?: number
  /** Context window to allocate for this request, in tokens. Ollama otherwise
   *  uses its (often small) default, which is the source of "request exceeds
   *  the available context size" errors on long conversations. */
  numCtx?: number
  signal?: AbortSignal
  /** Ollama native generation controls. */
  keepAlive?: string | number
  format?: 'json' | Record<string, unknown>
  think?: boolean | 'low' | 'medium' | 'high'
}

export class OllamaError extends Error {
  // Declared explicitly: parameter properties are not erasable syntax and are
  // rejected by Node's type-stripping loader.
  override readonly cause: unknown
  /** HTTP status when the failure came from the daemon, else undefined. */
  readonly status: number | undefined
  /** True when retrying the same request could plausibly succeed. */
  readonly transient: boolean

  constructor(message: string, cause?: unknown, status?: number) {
    super(message)
    this.name = 'OllamaError'
    this.cause = cause
    this.status = status
    // 5xx and 429 are the daemon or an upstream proxy failing, not a bad
    // request. Observed in practice: Ollama's cloud path returns
    // "Internal Server Error (ref: ...)" mid-stream, which is worth one retry.
    this.transient = status === 429 || (status !== undefined && status >= 500)
  }
}

export function isTransient(err: unknown): boolean {
  if (err instanceof OllamaError) return err.transient
  // Connection-level failures (daemon restarting, network blip).
  if (err instanceof Error && (err.name === 'TypeError' || err.name === 'FetchError')) return true
  return false
}

/** Ollama emits `arguments` as an object for some models and a JSON string for
 *  others. Normalize to an object so tool code never branches on this. */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return {}
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : { value: parsed }
    } catch {
      return { _unparsed: raw }
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>
  return { value: raw }
}

/** Wrap flat definitions into the envelope /api/chat expects. */
function toWireTools(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

type StreamFrame = {
  message?: { content?: string; tool_calls?: unknown[] }
  done?: boolean
  eval_count?: number
  prompt_eval_count?: number
  error?: string
}

function normalizeToolCalls(raw: unknown[] | undefined, seq: () => string): ToolCall[] {
  if (!Array.isArray(raw)) return []
  const out: ToolCall[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const fn = (e['function'] ?? {}) as Record<string, unknown>
    const name = typeof fn['name'] === 'string' ? fn['name'] : undefined
    if (!name) continue
    out.push({
      id: typeof e['id'] === 'string' && e['id'] ? e['id'] : seq(),
      name,
      args: parseArgs(fn['arguments']),
    })
  }
  return out
}

/** Ollama expects `role:'tool'` results keyed to the originating call. Our
 *  ChatMessage keeps both halves so the request builder can shape them. */
function toWire(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_name: m.toolName ?? 'unknown',
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map(c => ({
          id: c.id,
          function: { name: c.name, arguments: c.args },
        })),
      }
    }
    return { role: m.role, content: m.content }
  })
}

export async function* streamChat(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = {
    model,
    messages: toWire(messages),
    stream: true,
    options: {
      ...(opts.numPredict != null ? { num_predict: opts.numPredict } : {}),
      ...(opts.numCtx != null ? { num_ctx: opts.numCtx } : {}),
      ...(opts.keepAlive != null ? { keep_alive: opts.keepAlive } : {}),
    },
  }
  if (opts.tools?.length) body['tools'] = toWireTools(opts.tools)
  if (opts.format != null) body['format'] = opts.format
  if (opts.think != null) body['think'] = opts.think

  // Resolved per call, not captured at module load, so switching provider
  // mid-session takes effect on the next turn and tests can point at a fake
  // server without import-order gymnastics.
  const provider = providerForModel(model)

  let res: Response
  try {
    res = await fetch(`${provider.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(provider) },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return
    throw new OllamaError(`cannot reach Ollama at ${provider.host}`, err)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new OllamaError(`HTTP ${res.status} from Ollama: ${detail.slice(0, 300)}`, undefined, res.status)
  }
  if (!res.body) throw new OllamaError('Ollama returned an empty response body')

  let counter = 0
  const seq = () => `call_${++counter}`
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value

      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line === '') continue

        let frame: StreamFrame
        try {
          frame = JSON.parse(line) as StreamFrame
        } catch {
          continue // tolerate a truncated final line
        }
        if (frame.error) throw new OllamaError(`model error: ${frame.error}`)

        const msg = frame.message
        if (msg?.content) yield { type: 'text', delta: msg.content }
        for (const call of normalizeToolCalls(msg?.tool_calls, seq)) {
          yield { type: 'tool_call', call }
        }
        if (frame.done) {
          yield {
            type: 'done',
            evalCount: frame.eval_count ?? 0,
            promptEvalCount: frame.prompt_eval_count ?? 0,
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Non-streaming single-turn call. Used by the capability probe, where we need
 *  a definitive answer rather than incremental output. */
export async function chatOnce(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const body: Record<string, unknown> = {
    model,
    messages: toWire(messages),
    stream: false,
    options: { num_predict: opts.numPredict ?? 256 },
  }
  if (opts.numCtx != null) (body['options'] as Record<string, unknown>)['num_ctx'] = opts.numCtx
  if (opts.keepAlive != null) (body['options'] as Record<string, unknown>)['keep_alive'] = opts.keepAlive
  if (opts.tools?.length) body['tools'] = toWireTools(opts.tools)
  if (opts.format != null) body['format'] = opts.format
  if (opts.think != null) body['think'] = opts.think

  const provider = providerForModel(model)

  let res: Response
  try {
    res = await fetch(`${provider.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(provider) },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { content: '', toolCalls: [] }
    throw new OllamaError(`cannot reach Ollama at ${provider.host}`, err)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new OllamaError(`HTTP ${res.status} from Ollama: ${detail.slice(0, 300)}`, undefined, res.status)
  }

  const frame = (await res.json()) as StreamFrame
  if (frame.error) throw new OllamaError(`model error: ${frame.error}`)

  let counter = 0
  const msg = frame.message
  return {
    content: msg?.content ?? '',
    toolCalls: normalizeToolCalls(msg?.tool_calls, () => `call_${++counter}`),
  }
}

export {
  fetchModelContextLength,
  fetchModelContextSize,
  fetchModelContextWindow,
  getModelContextLength,
  modelContextLength,
  contextLength,
  extractContextLength,
  clearModelContextCache,
} from './modelfile.ts'
