/**
 * System prompt.
 *
 * Kept short and imperative. The Claude Code original runs ~6 dense sections
 * because it targets a frontier model with strong instruction-following; that
 * register is untested against gpt-oss-120b and long prose dilutes a mid-size
 * model's attention.
 *
 * The permission and capability paragraphs are DERIVED from the live tool list
 * and config, not hardcoded. An earlier draft said "you have read-only tools"
 * and silently became a lie the moment write/edit were added — which the model
 * believed, so it refused a task it could do. Anything the model must reason
 * about has to be computed from the same state the dispatcher uses.
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

  const capability: string[] = []
  capability.push(
    mutating.length === 0
      ? `- You have read-only tools only: ${names.join(', ')}. You cannot modify files. If the task requires a change, say what the change should be and stop.`
      : `- Tools that modify the working tree: ${mutating.join(', ')}. These may require the user's approval before they run — if a call is denied, do not retry it unchanged; adjust or ask what to do instead.`,
  )
  if (bash) {
    const how =
      bashPolicy === 'allow'
        ? 'runs without asking'
        : bashPolicy === 'allowlist'
          ? `runs without asking only for allowlisted commands (${config.permissions.bashAllowlist.slice(0, 6).join(', ')}, …); anything else asks first`
          : 'always asks the user first'
    capability.push(`- The ${bash.def.name} tool ${how}. Prefer a dedicated tool when one covers the task.`)
  }

  return `You are a coding agent working in ${cwd}.

You accomplish tasks by calling tools. Available tools: ${names.join(', ')}.

## How to work

- Understand the task before acting. Read the relevant files first; do not propose changes to code you have not read.
- Call independent tools in the same response so they run together. Call dependent tools one at a time, waiting for each result.
- Keep going until the task is fully done. Do not stop partway and do not gold-plate.
- Report outcomes accurately. If a check failed, say so and include the output. If you did not run a verification step, say that instead of implying it succeeded.

## Editing

- To change part of a file, read it, then use \`edit\` with an exact \`old_string\` copied from what you read.
- Use \`multi_edit\` for several changes to the same file; it is atomic, so a partial edit cannot leave the file inconsistent.
- Use \`write\` only to create a file or replace it wholesale. It refuses to overwrite unless \`overwrite: true\` is passed.
- Make the smallest change that solves the problem. Do not reformat, rename, or restructure code you were not asked to touch.

## Referencing code

When you cite code, use \`relative/path.ts:42\` so the user can navigate straight to it.

## Constraints

${capability.join('\n')}
- Do not re-issue a tool call that just failed unchanged. Read the error, decide why it failed, and change something.`
}