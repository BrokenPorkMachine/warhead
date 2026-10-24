/**
 * Permission gate.
 *
 * The single choke point for every tool call. Nothing authorizes a tool except
 * this file, which matters because the model is remote and the content it reads
 * is untrusted: a prompt injection inside a source file can cause the model to
 * request a write or a shell command, and this is where that request is
 * evaluated.
 *
 * Two deliberate design choices:
 *
 * 1. Policies are read from config at call time, never captured at startup, so
 *    `/permissions` takes effect on the very next call.
 *
 * 2. "Always allow" is SESSION-scoped by default and is not persisted. Silently
 *    writing "always allow write" into a config file is a footgun that outlives
 *    the session that granted it. Persisting requires an explicit
 *    `/permissions` edit, which is itself a deliberate act.
 */

import type { BashPolicy, Config } from '../config.ts'
import type { Tool, ToolCall } from '../types.ts'

export type Verdict = 'allow' | 'ask' | 'deny'

export type ApprovalRequest = {
  toolName: string
  /** One line for the prompt. */
  summary: string
  /** Full detail: diff preview, command, absolute paths. */
  detail: string
  args: Record<string, unknown>
}

export type ApprovalOutcome = 'allow' | 'deny' | 'allow_session'

/** Shell metacharacters that chain or detach independent commands. A command
 *  containing any of these is split, and EVERY segment must independently
 *  satisfy the allowlist. Without this, `git status; rm -rf ~` would pass a
 *  prefix check.
 *
 *  `&` was MISSING from the first version, so `git status & rm -rf ~` was
 *  auto-approved in full: the whole string stayed one segment, it began with an
 *  allowlisted prefix, and a destructive command rode along in the background.
 *
 *  `&` is split on except after `>`, so ordinary descriptor duplication
 *  (`2>&1`) is not mistaken for a command separator. Mis-splitting only ever
 *  makes the check stricter, which is the safe direction. */
const SEGMENT_SPLIT = /(?:\|\||&&|(?<![><])&|\||;|\n|\r)/

/** Split a shell command into independently-authorized segments. */
export function splitCommand(command: string): string[] {
  return command
    .split(SEGMENT_SPLIT)
    .map(s => s.trim())
    .filter(s => s !== '')
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Does `segment` satisfy an allowlist entry? An entry matches when the segment
 *  equals it or starts with it followed by whitespace — so `git status` allows
 *  `git status --short` but never `git statusx`. */
export function allowlistMatch(segment: string, allowlist: string[]): boolean {
  const seg = normalize(segment)
  for (const raw of allowlist) {
    const entry = normalize(raw)
    if (entry === '') continue
    if (seg === entry) return true
    if (seg.startsWith(entry) && /\s/.test(seg[entry.length] ?? '')) return true
  }
  return false
}

export type BashAllowlistVerdict = { allowed: true } | { allowed: false; blockedSegment: string }

export function checkBashAllowlist(command: string, allowlist: string[]): BashAllowlistVerdict {
  const segments = splitCommand(command)
  if (segments.length === 0) return { allowed: false, blockedSegment: '(empty command)' }
  for (const seg of segments) {
    if (!allowlistMatch(seg, allowlist)) return { allowed: false, blockedSegment: seg }
  }
  return { allowed: true }
}

/** Shell constructs that make static allowlist reasoning unsound. If one is
 *  present the command can never be auto-approved, only explicitly allowed. */
const OBFUSCATION = [
  /`/, // command substitution
  /\$\(/, // command substitution
  /\$\(\(/, // nested/subshell substitution
  /\$\{/, // variable expansion
  /\$\([\w@*#?\-!$]/, // variable substitution
  /(^|\s)(\.\s*\/|source\s)/, // sourcing another script
  /(^|\s)eval\s/, // eval
  /(^|\s)eval\s+["']/, // eval with string args
  /\|\s*(sh|bash|zsh|fish|python\d?|node|perl|ruby)\b/, // piping into an interpreter
  /(^|\s)(sh|bash|zsh)\s+-c\b/,
  />/, // redirection can clobber files
  /</, // input redirection can inject files
]
]

export function hasObfuscation(command: string): boolean {
  return OBFUSCATION.some(re => re.test(command))
}

function describe(call: ToolCall, tool: Tool): ApprovalRequest {
  const a = call.args
  const path = typeof a['path'] === 'string' ? a['path'] : undefined

  if (tool.def.name === 'rea_run_task') {
    const task = typeof a['task'] === 'string' ? a['task'] : '(unknown task)'
    return {
      toolName: tool.def.name,
      summary: `run REA task ${task}`,
      detail: `task: ${task}\narguments:\n${JSON.stringify(a['arguments'] ?? {}, null, 2)}`,
      args: a,
    }
  }

  if (tool.def.name === 'mcp_call_tool') {
    const serverRaw = typeof a['server'] === 'string' ? a['server'] : ''
    const server = serverRaw === '' ? '(unknown server)' : serverRaw
    const serverSafe = /^[a-zA-Z0-9_\-\.]+$/.test(serverRaw)
    const toolNameRaw = typeof a['tool'] === 'string' ? a['tool'] : ''
    const toolName = toolNameRaw === '' ? '(unknown tool)' : toolNameRaw
    const toolSafe = /^[a-zA-Z0-9_\-\.]+$/.test(toolNameRaw)
    return {
      toolName: tool.def.name,
      summary: `call MCP tool ${server}.${toolName}`,
      detail: `server: ${server}${!serverSafe ? ' (UNSAFE NAME)' : ''}\ntool: ${toolName}${!toolSafe ? ' (UNSAFE NAME)' : ''}\narguments:\n${JSON.stringify(a['arguments'] ?? {}, null, 2)}`,
      args: a,
    }
  }

  switch (tool.def.name) {
    case 'write':
    case 'create': {
      const content = typeof a['content'] === 'string' ? a['content'] : ''
      const lines = content === '' ? 0 : content.split('\n').length
      const verb = path ? `write ${lines} line(s) to ${path}` : 'write a file'
      return {
        toolName: tool.def.name,
        summary: verb,
        detail: `--- ${path ?? '?'} (new or overwritten) ---\n${content}`,
        args: a,
      }
    }
    case 'edit':
    case 'str_replace': {
      const oldS = typeof a['old_string'] === 'string' ? a['old_string'] : ''
      const newS = typeof a['new_string'] === 'string' ? a['new_string'] : ''
      const all = a['replace_all'] === true
      return {
        toolName: tool.def.name,
        summary: `edit ${path ?? '?'}${all ? ' (all occurrences)' : ''}`,
        detail: `--- ${path ?? '?'}\n- ${oldS}\n+ ${newS}`,
        args: a,
      }
    }
    case 'bash': {
      const cmd = typeof a['command'] === 'string' ? a['command'] : ''
      return {
        toolName: 'bash',
        summary: `run: ${cmd}`,
        detail: `cwd: ${process.cwd()}\n$ ${cmd}`,
        args: a,
      }
    }
    default:
      return {
        toolName: tool.def.name,
        summary: `${tool.def.name}(${Object.keys(a).join(', ')})`,
        detail: JSON.stringify(a, null, 2),
        args: a,
      }
  }
}

export class Gate {
  /** Tool names the user chose to allow for the remainder of this session. */
  private sessionTools = new Set<string>()
  /** Individual bash commands allowed for this session. */
  private sessionCommands = new Set<string>()
  /** Tools the user has explicitly denied; a denial is sticky within a session
   *  so the model cannot simply re-ask the same thing repeatedly. */
  private sessionDenied = new Set<string>()

  // Declared explicitly rather than as a constructor parameter property, which
  // is not erasable syntax.
  private readonly getConfig: () => Config

  constructor(getConfig: () => Config) {
    this.getConfig = getConfig
  }

  /** Decided without asking the user. */
  evaluate(call: ToolCall, tool: Tool): Verdict {
    const cfg = this.getConfig()
    const name = tool.def.name
    const sessionScope = sessionScopeFor(name, call.args)

    if (this.sessionDenied.has(sessionScope)) return 'deny'
    if (this.sessionTools.has(sessionScope)) return 'allow'
    if (cfg.permissions.alwaysAllow.includes(name)) return 'allow'

    // bash is resolved BEFORE the generic per-tool table because it has its own
    // richer policy (ask | allow | allowlist). A default `tools.bash` entry would
    // otherwise shadow permissions.bash and silently disable the allowlist.
    // `deny` is honoured as an explicit override.
    if (name === 'bash') {
      if (cfg.permissions.tools[name] === 'deny') return 'deny'
      const cmd = typeof call.args['command'] === 'string' ? call.args['command'] : ''
      return this.evaluateBash(cmd, cfg.permissions.bash, cfg.permissions.bashAllowlist)
    }

    const policy = cfg.permissions.tools[name]
    if (policy === 'deny') return 'deny'
    if (policy === 'allow') return 'allow'
    if (policy === 'ask') return 'ask'

    // Mutating tools default to asking. Anything not explicitly allowlisted is
    // treated as needing consent.
    return tool.mutates ? 'ask' : 'allow'
  }

  private evaluateBash(cmd: string, policy: BashPolicy, allowlist: string[]): Verdict {
    if (policy === 'allow') return 'allow'
    if (policy === 'ask') return 'ask'
    // allowlist
    if (this.sessionCommands.has(normalize(cmd))) return 'allow'
    if (hasObfuscation(cmd)) return 'ask'
    return checkBashAllowlist(cmd, allowlist).allowed ? 'allow' : 'ask'
  }

  request(call: ToolCall, tool: Tool): ApprovalRequest {
    return describe(call, tool)
  }

  /** Record the user's answer. Session scope only — see the file header.
   *
   *  For bash, "always" grants THIS COMMAND, not the tool. Adding 'bash' to
   *  sessionTools would let a single grant on `git status` silently authorize
   *  every later command including `rm -rf`, because the tool-level check
   *  short-circuits ahead of the command-level one. */
  record(toolName: string, outcome: ApprovalOutcome, args: Record<string, unknown>): void {
    if (outcome === 'allow_session') {
      if (toolName === 'bash') {
        if (typeof args['command'] === 'string') {
          this.sessionCommands.add(normalize(args['command']))
        }
        return
      }
      this.sessionTools.add(sessionScopeFor(toolName, args))
      return
    }
    if (outcome === 'deny') this.sessionDenied.add(sessionScopeFor(toolName, args))
  }

  /** Forget session grants. Exposed as /permissions reset. */
  resetSession(): void {
    this.sessionTools.clear()
    this.sessionCommands.clear()
    this.sessionDenied.clear()
  }

  sessionState(): { allow: string[]; deny: string[] } {
    return { allow: [...this.sessionTools], deny: [...this.sessionDenied] }
  }
}

function sessionScopeFor(toolName: string, args: Record<string, unknown>): string {
  // The generic REA dispatcher represents hundreds of distinct operations.
  // An "always" decision for one should never authorize the entire catalog.
  if (toolName === 'rea_run_task' && typeof args['task'] === 'string') {
    return `${toolName}:${args['task']}`
  }
  if (toolName === 'mcp_call_tool' && typeof args['server'] === 'string' && typeof args['tool'] === 'string') {
    return `${toolName}:${args['server']}:${args['tool']}`
  }
  return toolName
}
