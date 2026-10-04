/**
 * todo — track multi-step work.
 *
 * The list is the agent's own scratch plan. It lives in ToolContext rather than
 * module scope so it resets with the session and stays inspectable by tests.
 * The tool is idempotent from the model's point of view: each call replaces the
 * list, which is what the model expects when it "updates the todo list".
 */

import type { TodoItem, TodoStore, Tool, ToolOutcome } from '../types.ts'
import { reqArray, optString, ArgError } from './args.ts'

export function createTodoStore(): TodoStore {
  let items: TodoItem[] = []
  let seq = 0
  return {
    list: () => items.map(i => ({ ...i })),
    nextId: () => `t${++seq}`,
    write(next) {
      const previous = items
      const built: TodoItem[] = next.map(n => {
        const existing = previous.find(p => p.content === n.content)
        return {
          id: existing?.id ?? `t${++seq}`,
          content: n.content,
          status: n.status ?? 'pending',
        }
      })
      items = built
      return items.map(i => ({ ...i }))
    },
  }
}

const MARK: Record<TodoItem['status'], string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
}

export const todo: Tool = {
  mutates: false, // in-memory agent state, not the user's filesystem
  def: {
    name: 'todo',
    description:
      'Create or update the task list for the current turn. Each call replaces the ' +
      'whole list, so send every task each time. Keep exactly one task in_progress ' +
      'while others are pending or completed. Mark a task completed as soon as it is ' +
      'done rather than batching at the end.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete task list for this turn.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Task description' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Task state',
              },
            },
            required: ['content'],
          },
        },
      },
      required: ['todos'],
    },
  },

  async run(args, ctx): Promise<ToolOutcome> {
    let raw: unknown[]
    try {
      raw = reqArray(args, 'todos')
    } catch (err) {
      return { ok: false, output: '', error: err instanceof ArgError ? err.message : String(err) }
    }

    const parsed: Array<{ content: string; status?: TodoItem['status'] }> = []
    for (const entry of raw) {
      if (typeof entry === 'string') {
        parsed.push({ content: entry })
        continue
      }
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const content = optString(e, 'content') ?? optString(e, 'task') ?? optString(e, 'description')
      if (!content) continue
      const st = optString(e, 'status')
      const status =
        st === 'completed' || st === 'in_progress' ? st : st === 'pending' || st == null ? 'pending' : undefined
      parsed.push(status ? { content, status } : { content })
    }

    if (parsed.length === 0) {
      return { ok: false, output: '', error: "parameter 'todos' contained no usable task entries" }
    }

    const stored = ctx.todos.write(parsed)
    return { ok: true, output: render(stored) }
  },
}

export function render(items: TodoItem[]): string {
  if (items.length === 0) return 'Task list is empty.'
  const done = items.filter(i => i.status === 'completed').length
  const lines = items.map(i => `${MARK[i.status]} ${i.content}`)
  lines.push(`(${done}/${items.length} complete)`)
  return lines.join('\n')
}