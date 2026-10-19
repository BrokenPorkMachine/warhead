/** Direct access to Ollama's model-management API. */
import { providerForModel, authHeaders } from './provider.ts'

async function request(path: string, body: Record<string, unknown> | undefined, model = '', method = 'POST'): Promise<unknown> {
  const provider = providerForModel(model)
  const res = await fetch(`${provider.host}/api/${path}`, {
    method,
    headers: { ...authHeaders(provider), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const text = await res.text()
  if (!text.trim()) return {}
  try { return JSON.parse(text) }
  catch {
    // /api/pull and /api/create stream newline-delimited JSON. Preserve the
    // final status for the CLI without requiring a second transport path.
    const lines = text.trim().split('\n').reverse()
    for (const line of lines) {
      try {
        const frame = JSON.parse(line) as Record<string, unknown>
        if (typeof frame.error === 'string' && frame.error) throw new Error(`Ollama: ${frame.error}`)
        return frame
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Ollama:')) throw err
        /* inspect the next frame */
      }
    }
    return { output: text.slice(-2000) }
  }
}

export const showModel = (model: string) => request('show', { name: model }, model)
export const pullModel = (model: string) => request('pull', { model }, model)
export const deleteModel = (model: string) => request('delete', { model }, model, 'DELETE')
export const copyModel = (source: string, destination: string) => request('copy', { source, destination }, source)
export const createModel = (name: string, modelfile: string) => request('create', { model: name, modelfile }, name)

/** Ollama's non-chat generation and embedding endpoints, kept here so callers
 * can use the native API without bypassing provider routing or auth. */
export const generate = (model: string, prompt: string, options?: Record<string, unknown>) =>
  request('generate', { model, prompt, stream: false, ...(options ? { options } : {}) }, model)

export const embed = (model: string, input: string | string[]) =>
  request('embed', { model, input }, model)
