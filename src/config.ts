/**
 * Config: load/save JSON at ~/.config/warhead/config.json.
 *
 * Live-editable at runtime (e.g. `/permissions bash allow`); read at call time
 * rather than captured at startup so changes take effect on the next tool call.
 */

import { chmodSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type BashPolicy = 'ask' | 'allow' | 'allowlist'

export type ToolPolicy = 'allow' | 'ask' | 'deny'

/** A named Ollama endpoint.
 *
 *  Every provider speaks the same `/api/chat` protocol, so this is a host plus
 *  credentials — not a pluggable backend. That is a deliberate limit: adding a
 *  non-Ollama vendor means a different wire format (OpenAI streams SSE
 *  `tool_calls` deltas, Ollama streams NDJSON frames) and belongs behind a real
 *  adapter, not behind this type. */
export type Provider = {
  /** Identifier used by `/provider use <name>`. */
  name: string
  /** Base URL. A bare `host:port` is accepted and normalized to http://. */
  host: string
  /** Env var holding the API key. Preferred over `apiKey`: it keeps the secret
   *  out of the config file, so a config that gets copied or committed cannot
   *  leak it. */
  apiKeyEnv?: string
  /** Inline key. Written to disk in plaintext — prefer `apiKeyEnv`. */
  apiKey?: string
}

export type Config = {
  model: {
    /** Probed in order; first `ok` wins. */
    candidates: string[]
    /** Offer an interactive picker of tool-capable installed models if all
     *  candidates fail. */
    scanInstalledOnFailure: boolean
    /** Recorded probe outcomes, keyed by model, to avoid re-probing known-bad. */
    known: Record<string, { status: string; detail: string }>
  }
  permissions: {
    bash: BashPolicy
    /** Commands auto-approved under the `allowlist` policy. */
    bashAllowlist: string[]
    /** Always allowed; never gated. */
    alwaysAllow: string[]
    /** Per-tool policy for non-bash tools. Anything unset falls back to the
     *  gate's default: alwaysAllow -> allow, mutating tool -> ask, otherwise
     *  allow. `bash` is governed by permissions.bash instead, because it has the
     *  richer ask|allow|allowlist policy; setting `tools.bash` only lets you
     *  hard-deny it. */
    tools: Record<string, ToolPolicy>
  }
  transcripts: {
    enabled: boolean
    /** LRU ceiling for the transcripts directory. */
    maxBytes: number
    /** Tool output stored per call before truncation. */
    maxToolResultBytes: number
  }
  limits: {
    /** Max tool-call round trips per user turn. */
    maxSteps: number
    /** Conversation size above which compaction runs, in chars (~4 per token).
     *  240k chars is roughly 60k tokens. */
    compactThresholdChars: number
    /** Trailing messages preserved verbatim by compaction. */
    compactKeepRecent: number
    /** Identical repeated tool calls suppressed after this count. */
    repeatCallLimit: number
    bashTimeoutMs: number
  }
  providers: {
    /** Name of the provider in `list` to use. `null` means the built-in default:
     *  $OLLAMA_HOST if set, else http://localhost:11434. */
    active: string | null
    list: Provider[]
  }
}

export const DEFAULT_CONFIG: Config = {
  model: {
    // Discover local Ollama-store models when no explicit model was selected.
    candidates: [],
    scanInstalledOnFailure: true,
    known: {},
  },
  permissions: {
    bash: 'ask',
    // Allowlist prefixes match any further arguments, so each entry should be a
    // command whose argument space is harmless. `cat` was removed: with no
    // restriction it also permits `cat ~/.ssh/id_rsa`. Use `head`/`tail`, which
    // take an explicit file and default to bounded output.
    bashAllowlist: [
      'git status', 'git diff', 'git log', 'git show', 'git branch',
      'ls', 'pwd', 'wc', 'head', 'tail', 'which',
      'npm test', 'npm run', 'pytest', 'cargo test', 'go test',
    ],
    alwaysAllow: ['read_file', 'glob', 'grep', 'todo'],
    tools: {
      // Mutating tools default to `ask`; set explicitly so the policy is
      // visible in the config file rather than implied by tool metadata.
      write: 'ask',
      edit: 'ask',
      multi_edit: 'ask',
    },
  },
  transcripts: {
    enabled: true,
    maxBytes: 256 * 1024 * 1024,
    maxToolResultBytes: 8 * 1024,
  },
  limits: {
    maxSteps: 40,
    repeatCallLimit: 3,
    bashTimeoutMs: 120_000,
    compactThresholdChars: 240_000,
    compactKeepRecent: 8,
  },
  providers: {
    active: null,
    list: [],
  },
}

export function configPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
  return join(base, 'warhead', 'config.json')
}

/** Keep only well-formed provider entries.
 *
 *  The config is hand-editable, and one malformed line used to be fatal: lookups
 *  call `name.trim()`, so a provider missing `name` threw a TypeError that
 *  stopped the tool from starting at all — a bad `host` would not have been
 *  caught here either, only later, at the first request. Dropping the entry is
 *  better than refusing to boot; `/provider` will simply not list it. */
function sanitizeProviders(raw: unknown): Provider[] {
  if (!Array.isArray(raw)) return []
  const out: Provider[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const name = typeof e['name'] === 'string' ? e['name'].trim() : ''
    const host = typeof e['host'] === 'string' ? e['host'].trim() : ''
    if (name === '' || host === '') continue
    out.push({
      name,
      host,
      ...(typeof e['apiKeyEnv'] === 'string' && e['apiKeyEnv'] !== '' ? { apiKeyEnv: e['apiKeyEnv'] } : {}),
      ...(typeof e['apiKey'] === 'string' && e['apiKey'] !== '' ? { apiKey: e['apiKey'] } : {}),
    })
  }
  return out
}

export function loadConfig(): Config {
  const p = configPath()
  if (!existsSync(p)) return structuredClone(DEFAULT_CONFIG)
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<Config>
    // Merge nested objects as well as top-level sections. A shallow merge meant a
    // file containing only `permissions.tools.bash` silently DROPPED the sibling
    // defaults, leaving `tools.write` undefined — the policy then fell through to
    // the gate's implicit default by accident rather than by configuration, so a
    // future non-default policy would be unprotected with no visible cause.
    const cfg: Config = {
      model: { ...DEFAULT_CONFIG.model, ...parsed.model },
      permissions: {
        ...DEFAULT_CONFIG.permissions,
        ...parsed.permissions,
        tools: { ...DEFAULT_CONFIG.permissions.tools, ...parsed.permissions?.tools },
      },
      transcripts: { ...DEFAULT_CONFIG.transcripts, ...parsed.transcripts },
      limits: { ...DEFAULT_CONFIG.limits, ...parsed.limits },
      providers: {
        active: typeof parsed.providers?.active === 'string' ? parsed.providers.active : null,
        list: sanitizeProviders(parsed.providers?.list),
      },
    }
    // A pointer to a provider that no longer exists would otherwise sit in the
    // config looking valid, and the tool would quietly fall back to localhost
    // with nothing on screen saying the configured endpoint was ignored.
    if (cfg.providers.active && !cfg.providers.list.some(p => p.name === cfg.providers.active)) {
      cfg.providers.active = null
    }
    return cfg
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`config at ${p} is unreadable: ${msg}`)
  }
}

export function saveConfig(cfg: Config): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  // The config can hold a provider API key inline, so it is written 0600. The
  // mode argument only applies when the file is created — an existing config
  // keeps whatever mode it had, which after this change could be 0644 from
  // before it. Hence the explicit chmod as well, which does apply either way.
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    // A filesystem that does not support POSIX modes (some network mounts) is
    // not a reason to fail the save — the content still landed.
  }
}

export function transcriptDir(): string {
  const base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state')
  return join(base, 'warhead', 'sessions')
}
