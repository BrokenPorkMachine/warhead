/** Resolve model references that Warhead can load without an Ollama daemon.
 * Ollama's local manifest is only used as an index: inference consumes the GGUF
 * blob directly through the native llama.cpp runtime. */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type LocalModelSource =
  | { engine: 'mlx'; id: string; path?: string }
  | { engine: 'gguf'; id: string; path: string; systemPrompt?: string }

export class LocalModelError extends Error {
  constructor(message: string) { super(message); this.name = 'LocalModelError' }
}

export function ollamaModelsRoot(): string {
  return process.env['OLLAMA_MODELS'] || join(homedir(), '.ollama', 'models')
}

function parseManifest(manifestPath: string): { modelBlob: string; system?: string } {
  let manifest: Record<string, unknown>
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> }
  catch (err) { throw new LocalModelError(`cannot read Ollama model manifest: ${err instanceof Error ? err.message : String(err)}`) }
  const root = ollamaModelsRoot()
  const layers = Array.isArray(manifest['layers']) ? manifest['layers'] as Array<Record<string, unknown>> : []
  const model = layers.find(layer => layer['mediaType'] === 'application/vnd.ollama.image.model')
  const digest = model?.['digest']
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new LocalModelError('Ollama manifest does not contain a valid model layer digest')
  }
  const modelBlob = join(root, 'blobs', digest.replace(':', '-'))
  if (!existsSync(modelBlob)) throw new LocalModelError(`Ollama model blob is missing: ${modelBlob}`)

  let system: string | undefined
  // Ollama stores a Modelfile's SYSTEM text as its own layer. Older layouts put
  // it in the config blob, so keep that as a fallback.
  const systemLayer = layers.find(layer => layer['mediaType'] === 'application/vnd.ollama.image.system')
  const systemDigest = systemLayer?.['digest']
  if (typeof systemDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(systemDigest)) {
    try {
      const text = readFileSync(join(root, 'blobs', systemDigest.replace(':', '-')), 'utf8').trim()
      if (text) system = text
    } catch { /* optional */ }
  }
  if (!system) {
    const config = manifest['config'] as Record<string, unknown> | undefined
    const configDigest = config?.['digest']
    if (typeof configDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(configDigest)) {
      const configPath = join(root, 'blobs', configDigest.replace(':', '-'))
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
        if (typeof parsed['system'] === 'string' && parsed['system'].trim()) system = parsed['system'].trim()
      } catch { /* Modelfile metadata is optional; GGUF still contains its template. */ }
    }
  }
  return { modelBlob, ...(system ? { system } : {}) }
}

function ollamaManifestPath(ref: string): string {
  const slash = ref.lastIndexOf('/')
  const colon = ref.lastIndexOf(':')
  const tag = colon > slash ? ref.slice(colon + 1) : 'latest'
  const name = colon > slash ? ref.slice(0, colon) : ref
  if (!name || name.split('/').some(part => !part || part === '.' || part === '..') || !/^[\w.-]+$/.test(tag)) {
    throw new LocalModelError(`invalid Ollama model reference: ${ref}`)
  }
  const repository = name.includes('/') ? name : `library/${name}`
  return join(ollamaModelsRoot(), 'manifests', 'registry.ollama.ai', repository, tag)
}

/** Supported references:
 *  - `mlx:<repo-id>` for a Hugging Face MLX checkpoint
 *  - `mlx:/absolute/path` for local MLX weights
 *  - `gguf:/absolute/model.gguf` for a GGUF file
 *  - `ollama:<name[:tag]>` for a blob already in Ollama's local store
 */
export function resolveLocalModel(ref: string): LocalModelSource | null {
  if (ref.startsWith('mlx:')) {
    const id = ref.slice(4).trim()
    if (!id) throw new LocalModelError('MLX model reference is empty')
    if (id.startsWith('/')) {
      const path = resolve(id)
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new LocalModelError(`MLX model directory not found: ${path}`)
      return { engine: 'mlx', id: path, path }
    }
    if (id.split('/').some(part => !part || part === '.' || part === '..')) throw new LocalModelError(`invalid Hugging Face model id: ${id}`)
    return { engine: 'mlx', id }
  }
  if (ref.startsWith('gguf:')) {
    const path = resolve(ref.slice(5).trim())
    if (!path.toLowerCase().endsWith('.gguf') || !existsSync(path) || !statSync(path).isFile()) {
      throw new LocalModelError(`GGUF model file not found: ${path}`)
    }
    return { engine: 'gguf', id: path, path }
  }
  if (ref.startsWith('ollama:')) {
    const name = ref.slice(7).trim()
    if (!name) throw new LocalModelError('Ollama model reference is empty')
    const manifest = ollamaManifestPath(name)
    if (!existsSync(manifest)) throw new LocalModelError(`Ollama model is not installed locally: ${name}`)
    const loaded = parseManifest(manifest)
    return { engine: 'gguf', id: `ollama:${name}`, path: loaded.modelBlob, ...(loaded.system ? { systemPrompt: loaded.system } : {}) }
  }
  return null
}

/** Enumerate model references without contacting an Ollama process.
 *
 *  Ollama stores a manifest at `<namespace>/<name>/<tag>`, one path segment per
 *  field. Rebuilding the reference from that path must turn the final segment
 *  back into a `:tag` — an earlier `ollama:name/tag` form parsed as a different
 *  repository and could not be loaded. Manifests without a readable model blob
 *  (cloud-only tags resolve to a manifest, not weights) are skipped: listing
 *  them would advertise a model Warhead cannot run offline. */
export function listLocalOllamaModels(): string[] {
  const root = join(ollamaModelsRoot(), 'manifests', 'registry.ollama.ai')
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (dir: string, segments: string[] = []): void => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const next = [...segments, entry.name]
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path, next)
        continue
      }
      if (!entry.isFile() || next.length < 2) continue
      const tag = next.at(-1)!
      const repository = next.slice(0, -1).join('/')
      if (!repository || !/^[\w.-]+$/.test(tag)) continue
      const name = repository.startsWith('library/') ? repository.slice('library/'.length) : repository
      if (!name) continue
      try {
        parseManifest(path)
      } catch {
        continue
      }
      found.push(`ollama:${name}:${tag}`)
    }
  }
  walk(root)
  return found.sort()
}
