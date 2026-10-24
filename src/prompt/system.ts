/**
 * Minimal agent context — preserves the model's native Modelfile/default
 * behavior and avoids suppressing reasoning with long prose.
 * Agentic behavior (loop, permission gate, coverage, concurrency)
 * is enforced in code, not requested in the prompt.
 */

import type { Config } from '../config.ts'
import type { Tool } from '../types.ts'

export type PromptFacts = {
  cwd: string
  tools: Tool[]
  config: Config
}

function toolNames(tools: Tool[]): string[] {
  return tools.map(t => t.def.name)
}

export function systemPrompt({ cwd, tools, config }: PromptFacts): string {
  const names = toolNames(tools)
  const mutating = tools.filter(t => t.mutates).map(t => t.def.name)
  const bash = tools.find(t => t.def.name === 'bash')
  const bashPolicy = config.permissions.bash
  const hasMcp = names.includes('mcp_search_tools') && names.includes('mcp_call_tool')

  const mutatingLine = mutating.length
    ? `Mutating tools: ${mutating.join(', ')}.`
    : 'All tools are read-only.'

  const bashLine = bash
    ? `Bash policy: ${bashPolicy}${bashPolicy === 'allowlist' ? ' (allowlisted commands only)' : ''}.`
    : ''

  return [
    `Working directory: ${cwd}.`,
    `Available tools: ${names.join(', ')}.`,
    mutatingLine,
    bashLine,
    hasMcp ? 'MCP servers connected; discover with mcp_search_tools first.' : '',
    'Call tools to act. Call independent tools together. Read files before editing. Report results.',
  ].filter(Boolean).join(' ')
}
