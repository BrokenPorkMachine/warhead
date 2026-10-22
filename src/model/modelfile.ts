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
 * Compose the system message: the model's own defaults first, then the agent's
 * operating instructions.
 *
 * Order matters. The model default is its persona and reasoning protocol; the
 * agent block is the task. Putting the task last keeps it salient, and
 * separating them with explicit headings stops the agent block reading as a
 * replacement for the persona.
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

export function clearModelSystemPromptCache(): void {
  cache.clear()
}
