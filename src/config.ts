/**
 * Config: load/save JSON at ~/.config/agent/config.json.
 *
 * Live-editable at runtime (e.g. `/permissions bash allow`); read at call time
 * rather than captured at startup so changes take effect on the next tool call.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type BashPolicy = 'ask' | 'allow' | 'allowlist'

export type ToolPolicy = 'allow' | 'ask' | 'deny'

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
}

export const DEFAULT_CONFIG: Config = {
  model: {
    candidates: ['gpt-oss:120b-cloud', 'treyleo16/gpt-6-astra:latest'],
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
}

export function configPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
  return join(base, 'agent', 'config.json')
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
    return {
      model: { ...DEFAULT_CONFIG.model, ...parsed.model },
      permissions: {
        ...DEFAULT_CONFIG.permissions,
        ...parsed.permissions,
        tools: { ...DEFAULT_CONFIG.permissions.tools, ...parsed.permissions?.tools },
      },
      transcripts: { ...DEFAULT_CONFIG.transcripts, ...parsed.transcripts },
      limits: { ...DEFAULT_CONFIG.limits, ...parsed.limits },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`config at ${p} is unreadable: ${msg}`)
  }
}

export function saveConfig(cfg: Config): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

export function transcriptDir(): string {
  const base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state')
  return join(base, 'agent', 'sessions')
}