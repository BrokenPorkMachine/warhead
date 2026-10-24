/**
 * Minimal agent framing — agentic behavior is enforced in loop.ts,
 * gate.ts, and compact.ts, not requested in the prompt.
 * Purpose: give the model basic orientation (cwd, available tools,
 * mutation policy) without suppressing its native Modelfile reasoning
 * or injecting a brand/persona layer.
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

  const capLines: string[] = []
  capLines.push(mutating.length === 0
    ? `Available tools (read-only): ${names.join(', ')}.`
    : `Available tools: ${names.join(', ')}. Mutating: ${mutating.join(', ')}.`)
  if (bash) {
    const policy = config.permissions.bash
    capLines.push(`Bash policy: ${policy}${policy === 'allowlist' ? ' (allowlisted commands only)' : ''}.`)
  }
  capLines.push('Agent constraints (enforced by code, not prompt): do not retry identical tool calls; use read coverage to avoid re-reading; stop at max_steps; respect permission gate.')

  return `Working directory: ${cwd}.\n${capLines.join(' ')}\n` +
    `Answer greetings and ordinary conversation directly. Use tools when the request needs information or action. Call independent calls together; wait between dependent ones. Read files before editing. Report results. Use \`web_search\` for externally verifiable facts.`
}
