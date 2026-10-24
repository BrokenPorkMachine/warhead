/**
 * Local model resolution: `mlx:`, `gguf:`, and `ollama:` references.
 *
 * These paths let Warhead run without an Ollama daemon, so the parts worth
 * pinning down are the ones a daemon used to handle silently: turning a tag
 * into the right blob, understanding Ollama's on-disk manifest layout, and
 * refusing a reference that would escape the model store.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  listLocalOllamaModels,
  LocalModelError,
  ollamaModelsRoot,
  resolveLocalModel,
} from '../src/model/local-models.ts'
import { listInstalled } from '../src/model/probe.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function modelStore(): string {
  const root = mkdtempSync(join(tmpdir(), 'warhead-models-'))
  roots.push(root)
  return root
}

function withModels<T>(root: string, fn: () => T): T {
  const previous = process.env['OLLAMA_MODELS']
  process.env['OLLAMA_MODELS'] = root
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env['OLLAMA_MODELS']
    else process.env['OLLAMA_MODELS'] = previous
  }
}

function digest(fill: string): string {
  return `sha256:${fill.repeat(64).slice(0, 64)}`
}

/** Write an Ollama-shaped manifest and return the model blob path. */
function addOllamaModel(
  root: string,
  repository: string,
  tag: string,
  options: { blob?: boolean; system?: string; systemLayer?: boolean } = {},
): string {
  const modelDigest = digest('a')
  const blob = join(root, 'blobs', modelDigest.replace(':', '-'))
  mkdirSync(join(root, 'blobs'), { recursive: true })
  if (options.blob !== false) writeFileSync(blob, 'GGUF')

  const layers: Array<Record<string, string>> = [
    { mediaType: 'application/vnd.ollama.image.model', digest: modelDigest },
  ]
  const manifest: Record<string, unknown> = { layers }
  if (options.system !== undefined) {
    const systemDigest = digest(options.systemLayer ? 'c' : 'b')
    writeFileSync(
      join(root, 'blobs', systemDigest.replace(':', '-')),
      options.systemLayer ? options.system : JSON.stringify({ system: options.system }),
    )
    if (options.systemLayer) layers.push({ mediaType: 'application/vnd.ollama.image.system', digest: systemDigest })
    else manifest['config'] = { digest: systemDigest }
  }
  const path = join(root, 'manifests', 'registry.ollama.ai', repository, tag)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(manifest))
  return blob
}

// ------------------------------------------------------------------ discovery

test('installed tags are rebuilt as ollama:name:tag, not a file path', () => {
  const root = modelStore()
  addOllamaModel(root, join('library', 'qwen2.5-coder'), '7b')
  addOllamaModel(root, join('acme', 'tools', 'scanner'), 'latest')

  assert.deepEqual(withModels(root, () => listLocalOllamaModels()), [
    'ollama:acme/tools/scanner:latest',
    'ollama:qwen2.5-coder:7b',
  ])
})

test('a manifest without local weights is not advertised as installed', () => {
  const root = modelStore()
  addOllamaModel(root, join('library', 'cloud-only'), 'latest', { blob: false })
  assert.deepEqual(withModels(root, () => listLocalOllamaModels()), [])
})

test('a missing model store lists nothing instead of throwing', () => {
  const root = modelStore()
  assert.deepEqual(withModels(root, () => listLocalOllamaModels()), [])
})

test('listInstalled falls back to local manifests when the endpoint is down', async () => {
  const root = modelStore()
  addOllamaModel(root, join('library', 'local-model'), 'latest')
  const prevModels = process.env['OLLAMA_MODELS']
  const prevHost = process.env['OLLAMA_HOST']
  process.env['OLLAMA_MODELS'] = root
  process.env['OLLAMA_HOST'] = 'http://127.0.0.1:1'
  try {
    const models = await listInstalled()
    assert.deepEqual(models.map(m => m.name), ['ollama:local-model:latest'])
    assert.equal(models[0]!.family, 'gguf')
    assert.equal(models[0]!.remote, false)
  } finally {
    if (prevModels === undefined) delete process.env['OLLAMA_MODELS']
    else process.env['OLLAMA_MODELS'] = prevModels
    if (prevHost === undefined) delete process.env['OLLAMA_HOST']
    else process.env['OLLAMA_HOST'] = prevHost
  }
})

// ------------------------------------------------------------------ resolution

test('ollama: resolves the GGUF blob and defaults to the latest tag', () => {
  const root = modelStore()
  const blob = addOllamaModel(root, join('library', 'coder'), '7b', { system: 'You are terse.' })
  addOllamaModel(root, join('library', 'coder'), 'latest')

  const explicit = withModels(root, () => resolveLocalModel('ollama:coder:7b'))
  assert.equal(explicit?.engine, 'gguf')
  assert.equal(explicit?.path, blob)
  assert.equal(explicit?.systemPrompt, 'You are terse.')

  const implicit = withModels(root, () => resolveLocalModel('ollama:coder'))
  assert.equal(implicit?.path, blob)
})

test('ollama: reads the Modelfile system prompt from its own layer', () => {
  const root = modelStore()
  addOllamaModel(root, join('library', 'layered'), 'latest', {
    system: 'Answer in one line.',
    systemLayer: true,
  })
  const source = withModels(root, () => resolveLocalModel('ollama:layered'))
  assert.equal(source?.systemPrompt, 'Answer in one line.')
})

test('an unknown or malformed ollama: reference fails with a useful reason', () => {
  const root = modelStore()
  withModels(root, () => {
    assert.throws(() => resolveLocalModel('ollama:coder:7b'), /not installed locally/)
    assert.throws(() => resolveLocalModel('ollama:'), /empty/)
    assert.throws(() => resolveLocalModel('ollama:../../outside:latest'), LocalModelError)
    assert.throws(() => resolveLocalModel('ollama:coder:bad tag'), /invalid/)
  })
})

test('ollama root honours OLLAMA_MODELS', () => {
  const root = modelStore()
  withModels(root, () => assert.equal(ollamaModelsRoot(), root))
})

test('gguf: requires an existing .gguf file', () => {
  const root = modelStore()
  const file = join(root, 'model.gguf')
  writeFileSync(file, 'GGUF')

  const source = resolveLocalModel(`gguf:${file}`)
  assert.equal(source?.engine, 'gguf')
  assert.equal(source?.path, file)

  assert.throws(() => resolveLocalModel(join('gguf:', root, 'missing.gguf')), /not found/)
  const notGguf = join(root, 'weights.bin')
  writeFileSync(notGguf, 'x')
  assert.throws(() => resolveLocalModel(`gguf:${notGguf}`), /not found/)
})

test('mlx: accepts a Hugging Face id or an existing local directory', () => {
  const root = modelStore()
  const directory = join(root, 'checkpoint')
  mkdirSync(directory)

  assert.deepEqual(resolveLocalModel(`mlx:${directory}`), { engine: 'mlx', id: directory, path: directory })
  assert.deepEqual(resolveLocalModel('mlx:mlx-community/Qwen2.5-Coder-7B-Instruct-4bit'), {
    engine: 'mlx',
    id: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
  })
  assert.throws(() => resolveLocalModel('mlx:'), /empty/)
  assert.throws(() => resolveLocalModel('mlx:../escape'), /invalid/)
})

test('a plain Ollama tag is not silently treated as a local model', () => {
  const root = modelStore()
  addOllamaModel(root, join('library', 'coder'), '7b')
  // The plain tag belongs to the HTTP provider path. Treating it as local here
  // would make a remote-provider typo load an unrelated local blob.
  assert.equal(withModels(root, () => resolveLocalModel('coder:7b')), null)
})
