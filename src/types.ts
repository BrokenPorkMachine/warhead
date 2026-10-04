/**
 * Shared types. Erasable-syntax only (Node 26 type stripping):
 * no enums, no namespaces, no parameter properties.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type ToolCall = {
  id: string
  name: string
  /** Arguments as a plain object. Ollama usually returns these parsed, but some
   *  models emit a JSON string; `parseArgs` in the client normalizes both, so
   *  this is always an object by the time a tool sees it. */
  args: Record<string, unknown>
}

export type ChatMessage = {
  role: Role
  content: string
  toolCalls?: ToolCall[]
  /** Set on `role: 'tool'` messages to correlate the result with its call. */
  toolCallId?: string
  toolName?: string
}

export type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type ToolOutcome = {
  ok: boolean
  /** Text handed back to the model as the tool result. */
  output: string
  /** Set when the tool itself failed — surfaced to the user, not the model. */
  error?: string
}

/** Cross-call state a tool may need. Deliberately narrow: tools receive this
 *  rather than reaching for module-level singletons, which keeps them testable
 *  and makes the read-only / mutating split explicit. */
export type ToolContext = {
  cwd: string
  signal: AbortSignal
  todos: TodoStore
  config: () => Config
}

export type Tool = {
  def: ToolDef
  /** True if the tool can change the filesystem or run commands. Phase 1 ships
   *  only read-only tools; the gate keys off this. */
  mutates: boolean
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>
}

export type TodoItem = {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type TodoStore = {
  list(): TodoItem[]
  /** Replace the whole list. Returns the stored items. */
  write(items: Array<{ content: string; status?: TodoItem['status'] }>): TodoItem[]
  nextId(): string
}

export type ModelStatus = 'ok' | 'unsupported' | 'unreachable'

export type ProbeResult = {
  model: string
  status: ModelStatus
  /** Human-readable reason, especially for unsupported/unreachable. */
  detail: string
  latencyMs: number
}

import type { Config } from './config.ts'

/** Read per call rather than captured at module load, so tests can point at a
 *  fake server via OLLAMA_HOST without import-order gymnastics. */
export function ollamaHost(): string {
  return process.env['OLLAMA_HOST'] ?? 'http://localhost:11434'
}