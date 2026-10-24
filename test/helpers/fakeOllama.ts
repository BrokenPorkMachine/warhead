/**
 * Minimal fake Ollama for tests.
 *
 * The agent loop cannot be unit tested against a live model — it is
 * non-deterministic, costs latency, and (as observed) can loop. This serves the
 * /api/chat and /api/tags contracts with scripted responses so loop behaviour —
 * tool dispatch, repeat suppression, stop conditions, history shape — becomes
 * deterministic and instant.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ScriptedTurn =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; name: string; args: Record<string, unknown> }
  | { kind: 'raw_stream'; body: string }
  /** Fail with this HTTP status, to exercise the transient-retry path. */
  | { kind: 'http_error'; status: number }

export type FakeOllama = {
  url: string
  /** Requests received, for asserting on the conversation the model was sent. */
  requests: Array<{ model: string; messages: unknown[]; tools?: unknown[] }>
  /** Headers of every request received. Auth headers are otherwise unobservable
   *  from the client side — the only way to prove one is actually sent is for the
   *  server to see it. */
  headers: Array<Record<string, string | string[] | undefined>>
  /** Models asked about via /api/show, so cache behaviour is observable. */
  showRequests: Array<{ model: string }>
  /** Feed the next N turns. The last entry repeats once exhausted. */
  script: ScriptedTurn[]
  close: () => Promise<void>
}

export type FakeOllamaOptions = {
  /** Value returned as `system` by /api/show. Lets each fake instance stand in
   *  for a different endpoint with a different model default. */
  systemPrompt?: string
  /** Context length reported by /api/show, for exercising context handling. */
  contextLength?: number
}

export async function startFakeOllama(
  script: ScriptedTurn[],
  opts: FakeOllamaOptions = {},
): Promise<FakeOllama> {
  const requests: FakeOllama['requests'] = []
  const headers: FakeOllama['headers'] = []
  const showRequests: FakeOllama['showRequests'] = []
  let turn = 0

  const server: Server = createServer((req, res) => {
    headers.push({ ...req.headers })
    if (req.url === '/api/show') {
      let body = ''
      req.on('data', c => {
        body += c
      })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { model?: string }
        showRequests.push({ model: parsed.model ?? '' })
        const payload: Record<string, unknown> = { system: opts.systemPrompt ?? '' }
        if (opts.contextLength != null) {
          payload['model_info'] = { 'llama.context_length': opts.contextLength }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      })
      return
    }
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' })
      // Shaped like a real /api/tags: one genuinely pulled local model with a
      // weight-sized `size` and populated details, and one manifest-sized
      // remote entry. A bare `{name}` here would make the "is this pulled?"
      // heuristic untestable — everything would look remote.
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'fake:latest',
              size: 4_200_000_000,
              details: { family: 'gpt', parameter_size: '120B' },
            },
            { name: 'someone/remote:8b', size: 4200, details: { family: '', parameter_size: '' } },
          ],
        }),
      )
      return
    }
    if (req.url !== '/api/chat') {
      res.writeHead(404).end()
      return
    }

    let body = ''
    req.on('data', c => {
      body += c
    })
    req.on('end', () => {
      const parsed = JSON.parse(body) as FakeOllama['requests'][number]
      requests.push(parsed)

      const step = script[Math.min(turn, script.length - 1)] ?? { kind: 'text', text: 'done' }
      turn++
      const wantsStream = parsed.stream !== false

      if (step.kind === 'http_error') {
        res.writeHead(step.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `upstream failure ${step.status}` }))
        return
      }
      if (step.kind === 'raw_stream') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.end(step.body)
        return
      }

      const frames: string[] = []
      if (step.kind === 'text') {
        for (const chunk of step.text.match(/.{1,24}/gs) ?? ['']) {
          frames.push(JSON.stringify({ message: { role: 'assistant', content: chunk }, done: false }))
        }
      } else {
        frames.push(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: `call_${turn}`, function: { name: step.name, arguments: step.args } }],
            },
            done: false,
          }),
        )
      }
      frames.push(JSON.stringify({ done: true, eval_count: 10, prompt_eval_count: 20 }))

      if (!wantsStream) {
        // Non-streaming requests must get a single JSON object, not NDJSON.
        // The probe and compaction both use chatOnce; returning NDJSON here made
        // chatOnce throw a parse error that surfaced as a bogus transport failure.
        const last = step.kind === 'text' ? step.text : ''
        const toolCalls =
          step.kind === 'tool_call'
            ? [{ id: `call_${turn}`, function: { name: step.name, arguments: step.args } }]
            : undefined
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model: parsed.model,
            message: { role: 'assistant', content: last, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
            done: true,
            eval_count: 10,
            prompt_eval_count: 20,
          }),
        )
        return
      }

      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(frames.join('\n') + '\n')
    })
  })

  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    headers,
    showRequests,
    script,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}
