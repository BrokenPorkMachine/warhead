/**
 * Tool registry — declaration, dispatch, and result shaping.
 *
 * Dispatch never throws. A failing tool returns its error text *to the model*
 * so it can adapt, while the user sees the error separately. The distinction
 * matters: a crash teaches the model nothing, an error string lets it retry
 * with different arguments.
 */

import type { Tool, ToolContext, ToolDef, ToolOutcome } from '../types.ts'
import { readFile } from './read.ts'
import { glob } from './glob.ts'
import { grep } from './grep.ts'
import { todo } from './todo.ts'
import { writeFile } from './write.ts'
import { editFile } from './edit.ts'
import { multiEdit } from './multi_edit.ts'
import { bash } from './bash.ts'
import { hindsightContext } from './hindsight.ts'
import { webSearch } from './web_search.ts'

/** Every tool the agent knows about. Availability is NOT decided here — the
 *  permission gate authorizes each call. This list is the capability surface;
 *  the gate is the policy surface, and keeping them separate means adding a tool
 *  can never silently widen access. */
const ENABLED: Tool[] = [
  readFile,
  glob,
  grep,
  todo,
  writeFile,
  editFile,
  multiEdit,
  bash,
  webSearch,
  hindsightContext,
]

export class Registry {
  readonly tools: Tool[]

  constructor(tools: Tool[] = ENABLED) {
    this.tools = [...tools]
  }

  /** Add a runtime-provided capability (for example a tool discovered from a
   * managed MCP server). Name collisions are rejected rather than silently
   * replacing a built-in tool with a different implementation. */
  register(tool: Tool): void {
    if (this.get(tool.def.name)) throw new Error(`tool already registered: ${tool.def.name}`)
    this.tools.push(tool)
  }

  names(): string[] {
    return this.tools.map(t => t.def.name)
  }

  /** Flat tool definitions. The client wraps these into the {type:'function'}
   *  envelope that /api/chat expects, so the wire shape lives in one place. */
  definitions(): ToolDef[] {
    return this.tools.map(t => t.def)
  }

  get(name: string): Tool | undefined {
    return this.tools.find(t => t.def.name === name)
  }

  async dispatch(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutcome & { name: string }> {
    const tool = this.get(name)
    if (!tool) {
      const known = this.names().join(', ')
      return {
        name,
        ok: false,
        output: `Unknown tool '${name}'. Available tools: ${known}.`,
        error: `unknown tool: ${name}`,
      }
    }
    if (ctx.signal.aborted) {
      return { name, ok: false, output: 'Cancelled before the tool ran.', error: 'cancelled' }
    }
    try {
      const r = await tool.run(args, ctx)
      return { ...r, name }
    } catch (err) {
      // A throw here is a bug in the tool, not a model error. Report it as a
      // tool result so the loop continues, and keep the message for the user.
      const msg = err instanceof Error ? err.message : String(err)
      return { name, ok: false, output: `Tool '${name}' failed: ${msg}`, error: msg }
    }
  }
}

export const registry = new Registry()
