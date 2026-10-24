import test from 'node:test'
import assert from 'node:assert/strict'
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
  process.env['OLLAMA_HOST'] = a.url
  delete process.env['OLLAMA_API_KEY']
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.providers = { active: 'first', list: [{ name: 'first', host: a.url }, { name: 'second', host: b.url }] }
  applyConfiguredProvider(cfg)
  try {
    const resolved = await resolveModel(cfg, { persist: false, pick: async choices => {
      assert.equal(choices.filter(r => r.model.includes(a.url)).length, 2)
      assert.equal(choices.filter(r => r.model.includes(b.url)).length, 2)
      return choices.find(r => r.model.startsWith('fake:latest @ second'))!.model
    } })
    assert.equal(resolved.model, 'fake:latest')
    assert.equal(activeProvider().host, b.url)
    assert.deepEqual(cfg.model.candidates, [])
  } finally {
    globalThis.fetch = realFetch
    if (oldHost === undefined) delete process.env['OLLAMA_HOST']; else process.env['OLLAMA_HOST'] = oldHost
    if (oldKey === undefined) delete process.env['OLLAMA_API_KEY']; else process.env['OLLAMA_API_KEY'] = oldKey
    setActiveProvider(null)
    await Promise.all([a.close(), b.close()])
  }
})
