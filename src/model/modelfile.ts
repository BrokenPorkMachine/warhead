/**
 * Model metadata.
 *
 * A model can carry its own default system prompt in its Modelfile — for
 * gpt-oss that is the adaptive quality loop which governs how it chooses
 * reasoning depth. Sending our own `system` message REPLACES the Modelfile
 * default, so silently dropping it discards tuned behaviour the model was
 * shipped with.
 *
 * Availability is uneven: pulled models expose it via /api/show, while cloud tags
 * (`gpt-oss:120b-cloud`) return an empty string because the prompt lives
 * server-side. So this is best-effort — callers must handle null.
 *
 * Cached per model: this is metadata, not conversation state, and it costs an
 * HTTP round trip.
 */

import { providerForModel, authHeaders } from './provider.ts'
import { resolveLocalModel } from './local-models.ts'

type ShowResponse = {
  system?: string
  template?: string
  remote_model?: string
  remote_host?: string
  parameters?: string
  model_info?: Record<string, unknown>
  context_length?: number
}

/** Keyed by host *and* model, not model alone.
 *
 *  The same tag can resolve to different builds on different endpoints, and a
 *  cloud gateway may serve different default parameters than a local daemon.
 *  Keyed by model alone, switching provider with `/provider use` would keep
 *  serving the previous host's system prompt for the rest of the session — a
 *  stale cache entry is worse than a missing one, because nothing reports it. */
const cache = new Map<string, string | null>()

/** The model's own default system prompt, or null when it has none/is hidden. */
export async function fetchModelSystemPrompt(model: string): Promise<string | null> {
  const local = resolveLocalModel(model)
  if (local) return local.engine === 'gguf' ? local.systemPrompt ?? null : null
  const provider = providerForModel(model)
  const key = `${provider.host}::${model}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  let result: string | null = null
  try {
    const res = await fetch(`${provider.host}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(provider) },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) {
      const body = (await res.json()) as ShowResponse
      const sys = body.system?.trim()
      result = sys && sys.length > 0 ? sys : null
    }
  } catch {
    result = null // metadata is optional; never fail a turn over it
  }

  cache.set(key, result)
  return result
}

/**
 * Compose the system message: model defaults FIRST (preserved from Modelfile),
 * then minimal agent framing. Design goal: model behaves as pure Ollama
 * (reasoning protocols intact), with agent behaviors (max_steps, repetition
 * suppression, gate, compaction) enforced by code — not embedded as
 * instruction prose in the prompt.
 *
 * The agent block is kept to cwd, tool names, mutation policy, and the
 * code-enforced constraint note. No brand/personal framing; no hidden
 * reasoning instructions. Tool usage rules live in loop.ts, not here.
 */
export function composeSystemPrompt(modelDefault: string | null, agentPrompt: string): string {
  const base = modelDefault?.trim()
  if (!base) return agentPrompt
  return [
    '# Model defaults',
    '',
    base,
    '',
    '# Agent instructions',
    '',
    'The above are your built-in defaults and remain in effect. The following '
      + 'define your role for this session and take precedence where they conflict.',
    '',
    agentPrompt,
  ].join('\n')
}

/** Extract a model's context window (in tokens) from an /api/show body.
 *
 *  Ollama reports the maximum context length in `model_info` under an
 *  architecture-specific key (e.g. `llama.context_length`), and a configured
 *  `num_ctx` may also appear in the `parameters` block. Cloud tags expose the
 *  same metadata, so this works for both local and remote models. */
export function extractContextLength(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>

  if (typeof b['context_length'] === 'number' && Number.isFinite(b['context_length'])) {
    return Math.trunc(b['context_length'] as number)
  }

  const info = b['model_info']
  if (typeof info === 'object' && info !== null) {
    for (const [k, v] of Object.entries(info as Record<string, unknown>)) {
      if (k.endsWith('.context_length') || k === 'context_length') {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.trunc(v)
      }
    }
  }

  // Modelfile `PARAMETER num_ctx N` surfaces in the parameters string.
  const params = b['parameters']
  if (typeof params === 'string') {
    const m = params.match(/(^|\s)num_ctx\s+(\d+)/m)
    if (m) return Number.parseInt(m[2]!, 10)
  }

  // Some builds nest it under details.
  const details = b['details']
  if (typeof details === 'object' && details !== null) {
    const d = details as Record<string, unknown>
    if (typeof d['context_length'] === 'number') return Math.trunc(d['context_length'] as number)
  }

  return null
}

const contextCache = new Map<string, number | null>()

/** The model's context window in tokens, or null when it cannot be determined. */
export async function fetchModelContextLength(model: string): Promise<number | null> {
  const provider = providerForModel(model)
  const key = `${provider.host}::${model}`
  if (contextCache.has(key)) return contextCache.get(key) ?? null

  let result: number | null = null
  try {
    const res = await fetch(`${provider.host}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(provider) },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) {
      const body = await res.json()
      result = extractContextLength(body)
    }
  } catch {
    result = null
  }

  contextCache.set(key, result)
  return result
}

// Aliases covering the names callers and tests are likely to use.
export const fetchModelContextSize = fetchModelContextLength
export const fetchModelContextWindow = fetchModelContextLength
export const getModelContextLength = fetchModelContextLength
export const modelContextLength = fetchModelContextLength
export const contextLength = fetchModelContextLength

export function clearModelSystemPromptCache(): void {
  cache.clear()
  contextCache.clear()
}

export function clearModelContextCache(): void {
  contextCache.clear()
}
