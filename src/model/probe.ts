/**
 * Model capability probe.
 *
 * Tool support is NOT discoverable from Ollama's metadata, and a model without
 * it answers HTTP 200 with text and no tool_calls — indistinguishable from
 * success at the transport layer. So support has to be established by asking the
 * model to call a tool and checking that it did.
 *
 * Tri-state on purpose: `unsupported` (answered, but won't call tools) must be
 * distinguishable from `unreachable` (transport failure), because the first is
 * a permanent property of the model and the second may be transient.
 */

import { chatOnce, OllamaError } from './client.ts'
import { ollamaHost } from '../types.ts'
import type { ChatMessage, ProbeResult, ToolDef } from '../types.ts'

const PROBE_TOOL: ToolDef = {
  name: 'read_file',
  description: 'Read a file from the local filesystem',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'absolute path' } },
    required: ['path'],
  },
}

const PROBE_MESSAGES: ChatMessage[] = [
  {
    role: 'user',
    content: 'Use the read_file tool to read the file /etc/hosts. Call the tool now.',
  },
]

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_ATTEMPTS = 2
/**
 * Reasoning models (gpt-oss reports a `thinking` capability) spend generated
 * tokens on hidden reasoning before emitting content. With a small budget the
 * whole allowance can be consumed by reasoning, leaving empty content and no
 * tool call — which would be misreported as `unsupported`. Hence a budget with
 * room to spare, and a re-probe at a larger one before concluding anything.
 */
const PROBE_NUM_PREDICT = 800
const PROBE_NUM_PREDICT_RETRY = 2000

/** One probe attempt. Kept separate so the retry loop can classify a failure
 *  without conflating "flaky" with "unsupported". */
async function attempt(
  model: string,
  timeoutMs: number,
  numPredict: number,
): Promise<
  | { ok: true; calls: number }
  | { ok: false; status: 'unsupported' | 'unreachable'; detail: string }
  | { ok: false; status: 'retry'; detail: string }
> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { content, toolCalls } = await chatOnce(model, PROBE_MESSAGES, {
      tools: [PROBE_TOOL],
      numPredict,
      signal: controller.signal,
    })
    if (toolCalls.length > 0) return { ok: true, calls: toolCalls.length }
    // Empty output with no tool call is ambiguous: it is what a reasoning model
    // looks like when it runs out of budget mid-thought. Retry larger.
    if (content.trim() === '') return { ok: false, status: 'retry', detail: 'empty completion' }
    return { ok: false, status: 'unsupported', detail: 'answered without emitting a tool call' }
  } catch (err) {
    if (err instanceof OllamaError) {
      const text = err.message
      if (err.cause instanceof Error && err.cause.name === 'AbortError') {
        return { ok: false, status: 'unreachable', detail: `timed out after ${timeoutMs}ms` }
      }
      // A 404 means the tag does not resolve — permanent, so do not retry.
      if (/HTTP 404/.test(text)) {
        return { ok: false, status: 'unsupported', detail: 'model tag not found' }
      }
      return { ok: false, status: 'unreachable', detail: text.slice(0, 200) }
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, status: 'unreachable', detail: `timed out after ${timeoutMs}ms` }
    }
    return {
      ok: false,
      status: 'unreachable',
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe whether a model can call tools.
 *
 * Retries by default: tool-call emission is stochastic for some models, so a
 * single miss is not evidence of absence. Observed: `gpt-6-astra` produced a
 * valid call in one session and none in the next with an identical prompt,
 * which a single-shot probe would have misreported as unsupported.
 *
 * `unreachable` aborts immediately — a transport failure says nothing about
 * tool support and retrying only wastes the fallback budget.
 */
export async function probeModel(
  model: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  attempts: number = DEFAULT_ATTEMPTS,
): Promise<ProbeResult> {
  const started = Date.now()
  let last: { status: 'unsupported' | 'unreachable'; detail: string } = {
    status: 'unreachable',
    detail: 'no attempt completed',
  }

  for (let i = 0; i < Math.max(1, attempts); i++) {
    const r = await attempt(model, timeoutMs, PROBE_NUM_PREDICT)
    if (r.ok) {
      return {
        model,
        status: 'ok',
        detail: `emitted ${r.calls} tool call(s)${i > 0 ? ` (attempt ${i + 1})` : ''}`,
        latencyMs: Date.now() - started,
      }
    }
    if (r.status === 'retry') {
      const bigger = await attempt(model, timeoutMs, PROBE_NUM_PREDICT_RETRY)
      if (bigger.ok) {
        return {
          model,
          status: 'ok',
          detail: `emitted ${bigger.calls} tool call(s) (larger reasoning budget)`,
          latencyMs: Date.now() - started,
        }
      }
      last = { status: 'unsupported', detail: 'no tool call and no output at 2000 tokens' }
      break
    }
    last = { status: r.status, detail: r.detail }
    if (r.status === 'unreachable') break
  }

  return { model, status: last.status, detail: last.detail, latencyMs: Date.now() - started }
}

/** Probe candidates in order, returning the first that works plus the full
 *  audit trail so failures can be reported rather than silently swallowed. */
export async function selectModel(
  candidates: string[],
  timeoutMs?: number,
): Promise<{ chosen: string | null; results: ProbeResult[] }> {
  const results: ProbeResult[] = []
  for (const model of candidates) {
    const r = await probeModel(model, timeoutMs)
    results.push(r)
    if (r.status === 'ok') return { chosen: model, results }
  }
  return { chosen: null, results }
}

type TagEntry = { name?: string; model?: string }

/** Installed models per /api/tags. Note this lists only PULLED models — Ollama
 *  exposes no cloud catalog, so cloud candidates must be configured. */
export async function listInstalledModels(): Promise<string[]> {
  try {
    const res = await fetch(`${ollamaHost()}/api/tags`)
    if (!res.ok) return []
    const body = (await res.json()) as { models?: TagEntry[] }
    const names = (body.models ?? [])
      .map(m => m.name ?? m.model)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
    return [...new Set(names)].sort()
  } catch {
    return []
  }
}

/** Probe every installed model and return those that can actually call tools. */
export async function scanForToolCapable(
  models: string[],
  timeoutMs?: number,
): Promise<{ capable: ProbeResult[]; rejected: ProbeResult[] }> {
  const settled = await Promise.all(models.map(m => probeModel(m, timeoutMs)))
  return {
    capable: settled.filter(r => r.status === 'ok'),
    rejected: settled.filter(r => r.status !== 'ok'),
  }
}