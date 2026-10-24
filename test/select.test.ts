import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { resolveModel } from '../src/model/select.ts'
import { activeProvider, applyConfiguredProvider, setActiveProvider } from '../src/model/provider.ts'
import { startFakeOllama } from './helpers/fakeOllama.ts'

test('without a default, offers models from every configured surface and uses the selected host', async () => {
  const a = await startFakeOllama([{ kind: 'tool_call', name: 'read_file', args: { path: '/etc/hosts' } }])
  const b = await startFakeOllama([{ kind: 'tool_call', name: 'read_file', args: { path: '/etc/hosts' } }])
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input, init) => {
    const url = String(input)
    if (!url.startsWith(a.url + '/') && !url.startsWith(b.url + '/')) return Promise.reject(new Error('offline test surface'))
    return realFetch(input, init)
  }) as typeof fetch
  const oldHost = process.env['OLLAMA_HOST']
  const oldKey = process.env['OLLAMA_API_KEY']
  const oldModels = process.env['OLLAMA_MODELS']
  const emptyModels = mkdtempSync(join(tmpdir(), 'warhead-select-models-'))
  process.env['OLLAMA_HOST'] = a.url
  process.env['OLLAMA_MODELS'] = emptyModels
  delete process.env['OLLAMA_API_KEY']
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.model.candidates = []
  cfg.providers = { active: 'first', list: [{ name: 'first', host: a.url }, { name: 'second', host: b.url }] }
  applyConfiguredProvider(cfg)
  try {
    const resolved = await resolveModel(cfg, { persist: false, pick: async choices => {
      assert.ok(choices.some(r => r.model.includes(a.url)))
      assert.ok(choices.some(r => r.model.includes(b.url)))
      return choices.find(r => r.model.startsWith('fake:latest @ second'))!.model
    } })
    assert.equal(resolved.model, 'fake:latest')
    assert.equal(activeProvider().host, b.url)
    assert.deepEqual(cfg.model.candidates, [])
  } finally {
    globalThis.fetch = realFetch
    if (oldHost === undefined) delete process.env['OLLAMA_HOST']; else process.env['OLLAMA_HOST'] = oldHost
    if (oldKey === undefined) delete process.env['OLLAMA_API_KEY']; else process.env['OLLAMA_API_KEY'] = oldKey
    if (oldModels === undefined) delete process.env['OLLAMA_MODELS']; else process.env['OLLAMA_MODELS'] = oldModels
    rmSync(emptyModels, { recursive: true, force: true })
    setActiveProvider(null)
    await Promise.all([a.close(), b.close()])
  }
})
