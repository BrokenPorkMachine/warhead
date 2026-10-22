/**
 * Providers: named Ollama endpoints, credential resolution, and the model
 * selection they feed.
 *
 * The precedence rules are the part worth pinning down. They decide which
 * machine the agent's file-read and shell tools run against, so a silent
 * fallback to localhost when a named provider was asked for is a correctness
 * problem, not a cosmetic one.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_HOST,
  ProviderError,
  activeProvider,
  addProvider,
  applyConfiguredProvider,
  authHeaders,
  builtinProvider,
  describeProvider,
  findProvider,
  normalizeHost,
  providerForModel,
  removeProvider,
  resolveProvider,
  setActiveProvider,
} from '../src/model/provider.ts'
import { checkReachable, filterModels, listInstalled } from '../src/model/probe.ts'
import { clearModelSystemPromptCache, fetchModelSystemPrompt } from '../src/model/modelfile.ts'
import { chatOnce } from '../src/model/client.ts'
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/config.ts'
import { startFakeOllama } from './helpers/fakeOllama.ts'

function freshConfig() {
  return structuredClone(DEFAULT_CONFIG)
}

/** Hermetic local model store for tests. `listInstalled` also reads Ollama's
 *  on-disk manifests, so without this a developer's real models leak into
 *  assertions that are about a fake provider. */
const EMPTY_OLLAMA_MODELS = mkdtempSync(join(tmpdir(), 'warhead-empty-models-'))
after(() => rmSync(EMPTY_OLLAMA_MODELS, { recursive: true, force: true }))

/** Run with a clean provider override and no ambient host, then restore.
 *
 *  `await fn()` rather than `return fn()`: in an async function a bare return
 *  of a promise runs the finally block immediately, before the body settles —
 *  which reset the active provider out from under an in-flight request. */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): Promise<T> {
  const prevHost = process.env['OLLAMA_HOST']
  const prevKey = process.env['OLLAMA_API_KEY']
  const prevModels = process.env['OLLAMA_MODELS']
  if (!Object.hasOwn(env, 'OLLAMA_MODELS')) env = { ...env, OLLAMA_MODELS: EMPTY_OLLAMA_MODELS }
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  setActiveProvider(null)
  try {
    return await fn()
  } finally {
    if (prevHost === undefined) delete process.env['OLLAMA_HOST']
    else process.env['OLLAMA_HOST'] = prevHost
    if (prevKey === undefined) delete process.env['OLLAMA_API_KEY']
    else process.env['OLLAMA_API_KEY'] = prevKey
    if (prevModels === undefined) delete process.env['OLLAMA_MODELS']
    else process.env['OLLAMA_MODELS'] = prevModels
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    setActiveProvider(null)
  }
}

// --------------------------------------------------------------- normalizeHost

test('a bare host:port is accepted, which is the form OLLAMA_HOST uses', () => {
  assert.equal(normalizeHost('localhost:11434'), 'http://localhost:11434')
  assert.equal(normalizeHost('  10.0.0.5:11434  '), 'http://10.0.0.5:11434')
  assert.equal(normalizeHost('ollama.internal'), 'http://ollama.internal')
})

test('an explicit scheme and a trailing slash survive normalization', () => {
  assert.equal(normalizeHost('https://ollama.example.com'), 'https://ollama.example.com')
  assert.equal(normalizeHost('http://localhost:11434/'), 'http://localhost:11434')
  // The trailing slash is stripped because callers append `/api/chat`, and a
  // doubled slash is a 404 on some hosts.
  assert.equal(normalizeHost('http://localhost:11434///'), 'http://localhost:11434')
})

test('a bad host is rejected with a reason rather than passed to fetch', () => {
  // fetch() rejects an unparseable URL with an opaque "Failed to parse URL",
  // which tells a user nothing about which part they typed wrong.
  assert.throws(() => normalizeHost(''), ProviderError)
  assert.throws(() => normalizeHost('   '), /empty/)
  assert.throws(() => normalizeHost('ftp://example.com'), /http or https/)
})

// --------------------------------------------------------------- credentials

test('an env-var key wins over an inline one and is reported as such', async () => {
  await withEnv({ TEST_KEY: 'from-env' }, () => {
    const r = resolveProvider({ name: 'p', host: 'h:1', apiKeyEnv: 'TEST_KEY', apiKey: 'inline' })
    assert.equal(r.apiKey, 'from-env')
    assert.equal(r.keySource, 'env')
  })
})

test('authenticated cloud tags use Ollama Cloud through the built-in provider', async () => {
  await withEnv({ OLLAMA_HOST: undefined, OLLAMA_API_KEY: 'cloud-key', OLLAMA_CLOUD_HOST: undefined }, () => {
    const p = providerForModel('llama3.3:70b-cloud')
    assert.equal(p.host, 'https://ollama.com')
    assert.equal(p.apiKey, 'cloud-key')
  })
})

test('local models remain local and explicit providers win cloud routing', async () => {
  await withEnv({ OLLAMA_HOST: 'http://local:11434', OLLAMA_API_KEY: 'cloud-key' }, () => {
    assert.equal(providerForModel('qwen2.5:7b').host, 'http://local:11434')
    setActiveProvider(resolveProvider({ name: 'router', host: 'http://router:4000' }))
    assert.equal(providerForModel('llama3:cloud').host, 'http://router:4000')
  })
})

test('an inline key is used when the env var is unset, and flagged', async () => {
  await withEnv({ TEST_KEY: undefined }, () => {
    const r = resolveProvider({ name: 'p', host: 'h:1', apiKeyEnv: 'TEST_KEY', apiKey: 'inline' })
    assert.equal(r.apiKey, 'inline')
    assert.equal(r.keySource, 'inline')
  })
})

test('an unset env var does not shadow an inline key with a crash', async () => {
  await withEnv({ TEST_KEY: undefined }, () => {
    // A provider configured for a key you have not exported yet must still be
    // usable against a local daemon rather than failing to resolve.
    const r = resolveProvider({ name: 'p', host: 'h:1', apiKeyEnv: 'TEST_KEY' })
    assert.equal(r.apiKey, undefined)
    assert.equal(r.keySource, 'none')
  })
})

test('the env var is read per call, not captured at load', async () => {
  await withEnv({ LATE_KEY: undefined }, () => {
    assert.equal(resolveProvider({ name: 'p', host: 'h:1', apiKeyEnv: 'LATE_KEY' }).apiKey, undefined)
    process.env['LATE_KEY'] = 'exported-later'
    assert.equal(resolveProvider({ name: 'p', host: 'h:1', apiKeyEnv: 'LATE_KEY' }).apiKey, 'exported-later')
  })
})

test('auth headers carry a bearer token only when there is a key', () => {
  assert.deepEqual(authHeaders(resolveProvider({ name: 'p', host: 'h:1' })), {})
  assert.deepEqual(
    authHeaders(resolveProvider({ name: 'p', host: 'h:1', apiKey: 'k' })),
    { authorization: 'Bearer k' },
  )
})

test('the key is never rendered in the description', () => {
  const d = describeProvider(resolveProvider({ name: 'p', host: 'h:1', apiKey: 'super-secret' }))
  assert.ok(!d.includes('super-secret'), `description leaked the key: ${d}`)
  assert.match(d, /plaintext/)
})

// ---------------------------------------------------------------- precedence

test('precedence: configured provider beats OLLAMA_HOST beats the default', async () => {
  await withEnv({ OLLAMA_HOST: 'http://env-host:11434' }, () => {
    // env only
    assert.equal(builtinProvider().host, 'http://env-host:11434')

    const cfg = freshConfig()
    cfg.providers.list = [{ name: 'lan', host: 'http://lan-host:11434' }]
    cfg.providers.active = 'lan'
    const active = applyConfiguredProvider(cfg)
    assert.equal(active.host, 'http://lan-host:11434', 'config wins over env')
    assert.equal(active.name, 'lan')
  })
})

test('precedence: with no active provider, OLLAMA_HOST still applies', async () => {
  // This is what keeps `OLLAMA_HOST=<fake> npm test` and ordinary shell
  // overrides working without registering a provider.
  await withEnv({ OLLAMA_HOST: 'http://env-host:11434' }, () => {
    const cfg = freshConfig()
    const p = applyConfiguredProvider(cfg)
    assert.equal(p.host, 'http://env-host:11434')
    assert.equal(p.builtin, true)
  })
})

test('precedence: nothing set falls back to localhost', async () => {
  await withEnv({ OLLAMA_HOST: undefined, OLLAMA_API_KEY: undefined }, () => {
    assert.equal(activeProvider().host, DEFAULT_HOST)
  })
})

test('OLLAMA_API_KEY authenticates the built-in provider', async () => {
  // Cloud tags should work without first registering a provider.
  await withEnv({ OLLAMA_API_KEY: 'cloud-key' }, () => {
    assert.equal(builtinProvider().apiKey, 'cloud-key')
    assert.deepEqual(authHeaders(builtinProvider()), { authorization: 'Bearer cloud-key' })
  })
})

test('an active name with no matching entry falls back instead of throwing', async () => {
  // A hand-edited config must not leave the tool unable to start.
  await withEnv({ OLLAMA_HOST: undefined }, () => {
    const cfg = freshConfig()
    cfg.providers.active = 'deleted-long-ago'
    const p = applyConfiguredProvider(cfg)
    assert.equal(p.builtin, true)
    assert.equal(p.host, DEFAULT_HOST)
  })
})

// ------------------------------------------------------------- list mutation

test('providers are found and removed case-insensitively', () => {
  const cfg = freshConfig()
  cfg.providers.list = [{ name: 'Home-Lab', host: 'http://a:1' }]
  assert.ok(findProvider(cfg, 'home-lab'))
  assert.ok(findProvider(cfg, 'HOME-LAB'))
  assert.equal(findProvider(cfg, 'nope'), undefined)
  assert.equal(removeProvider(cfg, 'HOME-lab'), true)
  assert.equal(cfg.providers.list.length, 0)
})

test('adding an existing name replaces rather than duplicating', () => {
  const cfg = freshConfig()
  const first = addProvider(cfg, { name: 'p', host: 'http://a:1' })
  assert.deepEqual(first, { added: true, replaced: false })
  const second = addProvider(cfg, { name: 'P', host: 'http://b:2' })
  assert.deepEqual(second, { added: false, replaced: true })
  assert.equal(cfg.providers.list.length, 1, 'no duplicate')
  assert.equal(cfg.providers.list[0]!.host, 'http://b:2')
})

test('removing the active provider clears the pointer', () => {
  // Leaving `active` naming a deleted entry is how a config ends up silently
  // falling back with nothing on screen saying so.
  const cfg = freshConfig()
  addProvider(cfg, { name: 'p', host: 'http://a:1' })
  cfg.providers.active = 'p'
  removeProvider(cfg, 'p')
  assert.equal(cfg.providers.active, null)
})

// ----------------------------------------------------------------- filtering

test('model filtering is a case-insensitive substring match on any term', () => {
  const models = ['gpt-oss:120b-cloud', 'llama3.1:8b', 'qwen2.5-coder:7b', 'deepseek-v3']
  assert.deepEqual(filterModels(models, ['oss']), ['gpt-oss:120b-cloud'])
  assert.deepEqual(filterModels(models, ['OSS']), ['gpt-oss:120b-cloud'])
  assert.deepEqual(filterModels(models, ['llama', 'qwen']), ['llama3.1:8b', 'qwen2.5-coder:7b'])
  assert.deepEqual(filterModels(models, []), models, 'no terms keeps everything')
  assert.deepEqual(filterModels(models, ['nope']), [])
  assert.deepEqual(filterModels(models, ['  ']), models, 'blank terms are not a filter')
})

// --------------------------------------------------------------------- config

test('providers survive a config round trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-prov-'))
  const prev = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = dir
  try {
    const cfg = freshConfig()
    cfg.providers.list = [{ name: 'lan', host: 'http://lan:11434', apiKeyEnv: 'LAN_KEY' }]
    cfg.providers.active = 'lan'
    saveConfig(cfg)

    const back = loadConfig()
    assert.equal(back.providers.active, 'lan')
    assert.equal(back.providers.list.length, 1)
    assert.equal(back.providers.list[0]!.apiKeyEnv, 'LAN_KEY')
    assert.deepEqual(back.permissions, cfg.permissions, 'other sections untouched')
  } finally {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = prev
  }
})

test('a config with no providers key loads with the defaults', () => {
  // Regression shape: the section was added after the file was written, so an
  // older config has no `providers` at all. Spreading undefined would throw.
  const dir = mkdtempSync(join(tmpdir(), 'agent-prov-'))
  const prev = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = dir
  try {
    mkdirSync(join(dir, 'warhead'), { recursive: true })
    writeFileSync(join(dir, 'warhead', 'config.json'), JSON.stringify({ limits: { maxSteps: 9 } }))
    const c = loadConfig()
    assert.equal(c.providers.active, null)
    assert.deepEqual(c.providers.list, [])
    assert.equal(c.limits.maxSteps, 9)
  } finally {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = prev
  }
})

test('a malformed provider entry is dropped, not fatal', () => {
  // The config is hand-editable. One bad line used to stop the tool starting at
  // all, because lookups call name.trim() on every entry.
  const dir = mkdtempSync(join(tmpdir(), 'agent-prov-'))
  const prev = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = dir
  try {
    mkdirSync(join(dir, 'warhead'), { recursive: true })
    writeFileSync(
      join(dir, 'warhead', 'config.json'),
      JSON.stringify({
        providers: {
          active: 'good',
          list: [
            { name: 'good', host: 'http://good:11434' },
            { host: 'http://nameless:11434' },      // no name
            { name: '   ', host: 'http://blank:1' },  // blank name
            { name: 'nohost' },                       // no host
            { name: 42, host: 'http://wrongtype:1' }, // wrong types
            null,
            'garbage',
          ],
        },
      }),
    )
    const c = loadConfig()
    assert.deepEqual(c.providers.list.map(p => p.name), ['good'], 'only the well-formed entry survives')
    assert.equal(c.providers.active, 'good')
    // The surviving entry must survive a lookup without throwing.
    assert.ok(findProvider(c, 'good'))
  } finally {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = prev
  }
})

test('providers.list of the wrong shape falls back to empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-prov-'))
  const prev = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = dir
  try {
    mkdirSync(join(dir, 'warhead'), { recursive: true })
    for (const bad of [{ providers: { list: 'nope' } }, { providers: { list: 7 } }, { providers: 5 }]) {
      writeFileSync(join(dir, 'warhead', 'config.json'), JSON.stringify(bad))
      const c = loadConfig()
      assert.deepEqual(c.providers.list, [], `survived ${JSON.stringify(bad)}`)
      assert.equal(c.providers.active, null)
    }
  } finally {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = prev
  }
})

test('an active pointer to a deleted provider is cleared on load', () => {
  // Otherwise the config looks valid while the tool quietly talks to localhost
  // with nothing on screen saying the configured endpoint was ignored.
  const dir = mkdtempSync(join(tmpdir(), 'agent-prov-'))
  const prev = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = dir
  try {
    mkdirSync(join(dir, 'warhead'), { recursive: true })
    writeFileSync(
      join(dir, 'warhead', 'config.json'),
      JSON.stringify({ providers: { active: 'ghost', list: [{ name: 'other', host: 'http://o:1' }] } }),
    )
    assert.equal(loadConfig().providers.active, null)
  } finally {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = prev
  }
})

test('a config that can hold an API key is written 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-prov-'))
  const prev = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = dir
  try {
    saveConfig(freshConfig())
    const mode = statSync(join(dir, 'warhead', 'config.json')).mode & 0o777
    assert.equal(mode, 0o600, `config is ${mode.toString(8)}, expected 600`)
  } finally {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = prev
  }
})

test('an existing world-readable config is tightened on the next save', () => {
  // The mode argument to writeFileSync only applies at creation, so a config
  // written before this change would have stayed 0644 forever without the
  // explicit chmod.
  const dir = mkdtempSync(join(tmpdir(), 'agent-prov-'))
  const prev = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = dir
  try {
    mkdirSync(join(dir, 'warhead'), { recursive: true })
    const p = join(dir, 'warhead', 'config.json')
    writeFileSync(p, JSON.stringify({}), { mode: 0o644 })
    chmodIfSupported(p)
    saveConfig(freshConfig())
    assert.equal(statSync(p).mode & 0o777, 0o600)
  } finally {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = prev
  }
})

function chmodIfSupported(p: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chmodSync } = require('node:fs') as typeof import('node:fs')
    chmodSync(p, 0o644)
  } catch {
    // A filesystem without POSIX modes cannot be asserted on; the other test
    // covers the normal case.
  }
}

// ----------------------------------------------------------------- on the wire

test('the provider key is actually sent as a bearer token', async () => {
  // The only way to prove auth is transmitted is for the server to see it.
  const fake = await startFakeOllama([{ kind: 'text', text: 'ok' }])
  try {
    await withEnv({ OLLAMA_HOST: undefined }, () => {
      setActiveProvider(resolveProvider({ name: 'p', host: fake.url, apiKey: 'wire-key' }))
      return chatOnce('m', [{ role: 'user', content: 'hi' }])
    })
    const authed = fake.headers.filter(h => h['authorization'] !== undefined)
    assert.equal(authed.length, 1, 'exactly the chat request carried auth')
    assert.equal(authed[0]!['authorization'], 'Bearer wire-key')
  } finally {
    setActiveProvider(null)
    await fake.close()
  }
})

test('a keyless provider sends no authorization header at all', async () => {
  // An empty `authorization: ''` is worse than none — some hosts reject it.
  const fake = await startFakeOllama([{ kind: 'text', text: 'ok' }])
  try {
    await withEnv({ OLLAMA_HOST: fake.url, OLLAMA_API_KEY: undefined }, () => {
      setActiveProvider(null)
      return chatOnce('m', [{ role: 'user', content: 'hi' }])
    })
    assert.ok(
      fake.headers.every(h => h['authorization'] === undefined),
      'no authorization header was sent',
    )
  } finally {
    setActiveProvider(null)
    await fake.close()
  }
})

test('requests follow the active provider host, not the default', async () => {
  const fake = await startFakeOllama([{ kind: 'text', text: 'ok' }])
  try {
    // OLLAMA_HOST deliberately points somewhere else; a configured provider
    // must win, or file and shell tools would run against the wrong machine.
    await withEnv({ OLLAMA_HOST: 'http://127.0.0.1:1' }, async () => {
      setActiveProvider(resolveProvider({ name: 'p', host: fake.url }))
      await chatOnce('m', [{ role: 'user', content: 'hi' }])
      const tags = await listInstalled()
      // These came from the fake on purpose: OLLAMA_HOST pointed at a dead port,
      // so anything else would mean the configured provider was ignored — and
      // the tools would then run against the wrong machine.
      assert.ok(
        tags.some(t => t.name === 'fake:latest'),
        `expected the fake host's models, got ${JSON.stringify(tags.map(t => t.name))}`,
      )
    })
  } finally {
    setActiveProvider(null)
    await fake.close()
  }
})

test('listInstalled separates pulled weights from remote manifests', async () => {
  const fake = await startFakeOllama([{ kind: 'text', text: 'ok' }])
  try {
    await withEnv({ OLLAMA_HOST: fake.url, OLLAMA_API_KEY: undefined }, async () => {
      setActiveProvider(null)
      const models = await listInstalled()
      assert.deepEqual(models.map(m => m.name), ['fake:latest', 'someone/remote:8b'])

      const local = models.find(m => m.name === 'fake:latest')!
      assert.equal(local.remote, false, 'a 4.2GB local model is not flagged remote')
      assert.equal(local.parameterSize, '120B')

      // Ollama reports a few KB for a tag it has resolved but not pulled: that
      // is the manifest, not the weights. Calling it local would tell the user a
      // model is on disk when it is not.
      const remote = models.find(m => m.name === 'someone/remote:8b')!
      assert.equal(remote.remote, true, 'a manifest-sized entry is flagged remote')
    })
  } finally {
    setActiveProvider(null)
    await fake.close()
  }
})

// ------------------------------------------------------------- reachability

test('checkReachable succeeds against a live endpoint that 404s the probe', async () => {
  const fake = await startFakeOllama([{ kind: 'text', text: 'ok' }])
  try {
    // The fake serves no /api/version and answers 404. That still proves the
    // host is up, which is the only thing this precheck is for — scoring a 404
    // as unreachable would refuse to switch to a working endpoint.
    const r = await checkReachable({ name: 'p', host: fake.url, keySource: 'none', builtin: false })
    assert.equal(r.ok, true, `expected reachable, got ${JSON.stringify(r)}`)
  } finally {
    await fake.close()
  }
})

test('checkReachable reports a closed port instead of hanging', async () => {
  // Port 1 is reserved and refuses immediately on loopback, so this is fast and
  // deterministic. The point is that it returns a verdict at all.
  const r = await checkReachable({ name: 'p', host: 'http://127.0.0.1:1', keySource: 'none', builtin: false }, 2000)
  assert.equal(r.ok, false)
  assert.ok(r.ok === false && r.detail.length > 0, 'a reason is given')
})

// ------------------------------------------------- cache scoped to the host

test('the system-prompt cache does not leak across providers', async () => {
  // Same tag on two endpoints, different model defaults. Keyed by model alone,
  // the second host kept serving the first host's prompt for the rest of the
  // session — and nothing reported it.
  const one = await startFakeOllama([{ kind: 'text', text: 'x' }], { systemPrompt: 'PROMPT-ONE' })
  const two = await startFakeOllama([{ kind: 'text', text: 'x' }], { systemPrompt: 'PROMPT-TWO' })
  clearModelSystemPromptCache()
  try {
    setActiveProvider(resolveProvider({ name: 'p', host: one.url }))
    assert.equal(await fetchModelSystemPrompt('shared:latest'), 'PROMPT-ONE')

    setActiveProvider(resolveProvider({ name: 'p', host: two.url }))
    assert.equal(
      await fetchModelSystemPrompt('shared:latest'),
      'PROMPT-TWO',
      'the second host must not be served the first host prompt',
    )

    setActiveProvider(resolveProvider({ name: 'p', host: one.url }))
    assert.equal(await fetchModelSystemPrompt('shared:latest'), 'PROMPT-ONE')
    assert.equal(one.showRequests.length, 1, 'the first host was fetched once, then cached')
    assert.equal(two.showRequests.length, 1, 'the second host was fetched once')
  } finally {
    clearModelSystemPromptCache()
    setActiveProvider(null)
    await Promise.all([one.close(), two.close()])
  }
})

test('a cached null is a hit, not a miss', async () => {
  // The original used cache.has(). Switching to cache.get() without testing for
  // undefined would re-request forever on a model with no system prompt, which
  // is the common case for most models.
  const fake = await startFakeOllama([{ kind: 'text', text: 'x' }], { systemPrompt: '' })
  clearModelSystemPromptCache()
  try {
    setActiveProvider(resolveProvider({ name: 'p', host: fake.url }))
    assert.equal(await fetchModelSystemPrompt('bare:latest'), null)
    assert.equal(await fetchModelSystemPrompt('bare:latest'), null)
    assert.equal(fake.showRequests.length, 1, 'the null was cached, not re-fetched')
  } finally {
    clearModelSystemPromptCache()
    setActiveProvider(null)
    await fake.close()
  }
})
