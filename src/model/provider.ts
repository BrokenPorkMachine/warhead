/**
 * Providers: named Ollama endpoints.
 *
 * A provider is a host plus credentials, not a pluggable backend. Every Ollama
 * endpoint — a local daemon, a box on the LAN, a cloud gateway — speaks the same
 * `/api/chat` protocol, so switching between them needs no new streaming or
 * tool-call code. That is the whole reason this is a small type rather than an
 * interface: a genuinely different vendor (OpenAI streams SSE `tool_calls`
 * deltas, Anthropic a different message shape again) does not fit behind this
 * and would need a real adapter layer.
 *
 * Resolution order, most specific first:
 *
 *   1. the provider named by `providers.active` in config
 *   2. $OLLAMA_HOST
 *   3. http://localhost:11434
 *
 * Config wins over the environment because naming a provider is a deliberate act
 * and an ambient env var is not — but with no active provider configured, the
 * env var still applies, which is what keeps `OLLAMA_HOST=<fake> npm test` and
 * ordinary shell overrides working untouched.
 */

import type { Config, Provider } from '../config.ts'

export const DEFAULT_HOST = 'http://localhost:11434'
export const DEFAULT_CLOUD_HOST = 'https://ollama.com'

/** A provider with its credentials resolved and its host normalized. */
export type ResolvedProvider = {
  name: string
  host: string
  apiKey?: string
  /** Where the key came from, for display. Never prints the key itself. */
  keySource: 'env' | 'inline' | 'none'
  /** True for the built-in fallback rather than a configured entry. */
  builtin: boolean
}

export class ProviderError extends Error {}

/** Accept what a person would actually type.
 *
 *  `localhost:11434` has no scheme, and `fetch` rejects it outright with an
 *  opaque "Failed to parse URL". Ollama's own OLLAMA_HOST convention is a bare
 *  host:port, so requiring a scheme here would reject the form the tool's own
 *  documentation uses. */
export function normalizeHost(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new ProviderError('host is empty')
  // Detect *any* scheme, not just http/https. Testing for `^https?://` instead
  // meant `ftp://example.com` failed the test, got `http://` prepended, and
  // parsed as the host `ftp` — silently pointing at the wrong machine rather
  // than rejecting the input.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const withScheme = hasScheme ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new ProviderError(`not a usable host: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError(`host must be http or https, got ${url.protocol.replace(':', '')}`)
  }
  if (url.hostname === '') throw new ProviderError(`not a usable host: ${raw}`)
  // Trailing slash removed so `${host}/api/chat` cannot become `//api/chat`.
  return `${url.protocol}//${url.host}`
}

export function resolveProvider(p: Provider, builtin = false): ResolvedProvider {
  const host = normalizeHost(p.host)
  // An env var is consulted at call time, not at load time, so exporting a key
  // after startup works and a short-lived credential never has to be written
  // to disk at all.
  const fromEnv = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined
  if (fromEnv) {
    return { name: p.name, host, apiKey: fromEnv, keySource: 'env', builtin }
  }
  if (p.apiKey) {
    return { name: p.name, host, apiKey: p.apiKey, keySource: 'inline', builtin }
  }
  return { name: p.name, host, keySource: 'none', builtin }
}

/** The fallback used when no provider is configured. */
export function builtinProvider(): ResolvedProvider {
  const env = process.env['OLLAMA_HOST']
  const host = env ? normalizeHost(env) : DEFAULT_HOST
  // OLLAMA_API_KEY is the convention Ollama's own tooling uses, so honour it
  // here rather than requiring every cloud user to register a provider first.
  const key = process.env['OLLAMA_API_KEY']
  return {
    name: 'default',
    host,
    apiKey: key,
    keySource: key ? 'env' : 'none',
    builtin: true,
  }
}

// ---------------------------------------------------------------- active state

let override: ResolvedProvider | null = null

/** The provider every request goes to. */
export function activeProvider(): ResolvedProvider {
  return override ?? builtinProvider()
}

/** Resolve a model request. Explicitly selected providers always win. For the
 * built-in provider, authenticated `-cloud` tags use Ollama Cloud directly;
 * this keeps `OLLAMA_API_KEY=... warhead-cli` useful without requiring a
 * provider entry, while preserving local Ollama for local models. */
export function providerForModel(model: string): ResolvedProvider {
  const active = activeProvider()
  if (override || !active.builtin || !/-cloud(?::|$)/i.test(model) || !active.apiKey) return active
  const host = process.env['OLLAMA_CLOUD_HOST']
    ? normalizeHost(process.env['OLLAMA_CLOUD_HOST'] as string)
    : DEFAULT_CLOUD_HOST
  return { ...active, name: 'ollama-cloud', host }
}

/** Point the process at a provider. `null` restores the built-in fallback. */
export function setActiveProvider(p: ResolvedProvider | null): void {
  override = p
}

/** Adopt `providers.active` from config. Called once at startup and again after
 *  `/provider use`. A dangling name falls back rather than throwing, so a config
 *  edited by hand cannot leave the tool unable to start. */
export function applyConfiguredProvider(cfg: Config): ResolvedProvider {
  const name = cfg.providers.active
  if (!name) {
    setActiveProvider(null)
    return builtinProvider()
  }
  const found = findProvider(cfg, name)
  if (!found) {
    setActiveProvider(null)
    return builtinProvider()
  }
  const resolved = resolveProvider(found)
  setActiveProvider(resolved)
  return resolved
}

// ------------------------------------------------------------------- lookups

export function findProvider(cfg: Config, name: string): Provider | undefined {
  const want = name.trim().toLowerCase()
  return cfg.providers.list.find(p => p.name.trim().toLowerCase() === want)
}

export function addProvider(cfg: Config, p: Provider): { added: boolean; replaced: boolean } {
  const i = cfg.providers.list.findIndex(
    x => x.name.trim().toLowerCase() === p.name.trim().toLowerCase(),
  )
  if (i === -1) {
    cfg.providers.list.push(p)
    return { added: true, replaced: false }
  }
  cfg.providers.list[i] = p
  return { added: false, replaced: true }
}

export function removeProvider(cfg: Config, name: string): boolean {
  const want = name.trim().toLowerCase()
  const i = cfg.providers.list.findIndex(p => p.name.trim().toLowerCase() === want)
  if (i === -1) return false
  cfg.providers.list.splice(i, 1)
  // Clearing the pointer matters: leaving `active` naming a deleted provider is
  // how a config ends up silently falling back with nothing on screen saying so.
  if (cfg.providers.active?.trim().toLowerCase() === want) cfg.providers.active = null
  return true
}

/** Auth headers for a provider. Ollama cloud takes a bearer token; a local
 *  daemon takes nothing, and sending an empty header would be worse than none. */
export function authHeaders(p: ResolvedProvider = activeProvider()): Record<string, string> {
  return p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}
}

/** One-line description for display. Never includes the key. */
export function describeProvider(p: ResolvedProvider): string {
  const key =
    p.keySource === 'none'
      ? 'no key'
      : p.keySource === 'env'
        ? 'key from env'
        : 'key inline (plaintext)'
  return `${p.name}  ${p.host}  [${key}${p.builtin ? ', built-in' : ''}]`
}
