/** Persistent, Warhead-owned macOS inference runtime. Communication uses a
 * private newline-delimited JSON stream over stdio; no local HTTP listener is
 * opened and no Ollama process is required. */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatMessage, ToolCall, ToolDef } from '../types.ts'

type RuntimeEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; evalCount: number; promptEvalCount: number }

type WireEvent = { id: number; event: string; [key: string]: unknown }
type Waiter = { push(event: WireEvent): void; fail(error: Error): void }

class NativeRuntime {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly waiters = new Map<number, Waiter>()
  private loadedModel = ''
  private queue: Promise<void> = Promise.resolve()

  async *chat(model: string, messages: ChatMessage[], tools: ToolDef[], signal?: AbortSignal, numPredict?: number): AsyncGenerator<RuntimeEvent> {
    const release = await this.acquire()
    try {
      await this.load(model, signal)
      const body = {
        method: 'chat', model, messages: toWire(messages), tools: tools.map(tool => ({
          type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        numPredict: numPredict ?? 2048,
      }
      for await (const event of this.request(body, signal)) {
        if (event.event === 'text' && typeof event['delta'] === 'string') yield { type: 'text', delta: event['delta'] }
        else if (event.event === 'tool_call') {
          const call = event['call'] as ToolCall | undefined
          if (call && typeof call.name === 'string') yield { type: 'tool_call', call }
        } else if (event.event === 'done') {
          yield {
            type: 'done',
            evalCount: typeof event['evalCount'] === 'number' ? event['evalCount'] : 0,
            promptEvalCount: typeof event['promptEvalCount'] === 'number' ? event['promptEvalCount'] : 0,
          }
        } else if (event.event === 'error') {
          throw new Error(typeof event['message'] === 'string' ? event['message'] : 'native runtime failed')
        }
      }
    } finally {
      release()
    }
  }

  private async acquire(): Promise<() => void> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>(resolve => { release = resolve })
    await previous
    return release
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = null
    this.loadedModel = ''
    if (!child) return
    try { child.stdin.write('{"id":0,"method":"shutdown"}\n') } catch { /* process may have exited */ }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1_500)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
  }

  private async load(model: string, signal?: AbortSignal): Promise<void> {
    if (this.loadedModel === model) return
    for await (const event of this.request({ method: 'load', model }, signal)) {
      if (event.event === 'error') throw new Error(typeof event['message'] === 'string' ? event['message'] : 'model load failed')
    }
    this.loadedModel = model
  }

  private async *request(payload: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<WireEvent> {
    const child = await this.ensureProcess()
    if (signal?.aborted) throw new Error('native model request cancelled')
    const id = this.nextId++
    const queue: WireEvent[] = []
    let wake: (() => void) | undefined
    let error: Error | undefined
    let finished = false
    this.waiters.set(id, {
      push: event => { queue.push(event); if (event.event === 'done' || event.event === 'error') finished = true; wake?.(); wake = undefined },
      fail: value => { error = value; finished = true; wake?.(); wake = undefined },
    })
    const abort = () => {
      error = new Error('native model request cancelled')
      finished = true
      wake?.()
      wake = undefined
      // Generation runs inside the native process and cannot consume a second
      // request while busy. Retire it so cancellation stops compute and the next
      // turn starts a clean runtime.
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`)
    try {
      while (!finished || queue.length > 0) {
        const next = queue.shift()
        if (next) { yield next; continue }
        if (error) throw error
        await new Promise<void>(resolve => { wake = resolve })
      }
      if (error) throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      this.waiters.delete(id)
    }
  }

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null) return this.child
    const binary = await ensureRuntimeBuilt()
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      try {
        const event = JSON.parse(line) as WireEvent
        this.waiters.get(event.id)?.push(event)
      } catch { /* ignore non-protocol output */ }
    })
    child.stderr.on('data', chunk => process.stderr.write(chunk))
    // A child that dies between spawn and the first write surfaces as EPIPE on
    // stdin; without a listener Node treats it as an unhandled 'error' and takes
    // the whole CLI down instead of reporting the failed request.
    child.stdin.on('error', () => {})
    const exited = () => {
      if (this.child === child) this.child = null
      this.loadedModel = ''
      const error = new Error(`Warhead native runtime exited (${child.signalCode ?? child.exitCode ?? 'unknown'})`)
      for (const waiter of this.waiters.values()) waiter.fail(error)
    }
    child.on('error', exited)
    child.on('exit', exited)
    return child
  }
}

const runtimeRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const runtimePackage = join(runtimeRoot, 'native', 'warhead-runtime')

function runtimeBinaryCandidates(): string[] {
  return [
    join(runtimeRoot, 'dist', 'native', 'warhead-runtime'),
    // SwiftPM's native layout, used by current toolchains.
    join(runtimePackage, '.build', 'out', 'Products', 'Release', 'warhead-runtime'),
    // Older/CLI layouts, kept so an existing build is never rebuilt needlessly.
    join(runtimePackage, '.build', 'release', 'warhead-runtime'),
    join(runtimePackage, '.build', 'arm64-apple-macosx', 'release', 'warhead-runtime'),
    join(runtimePackage, '.build', 'x86_64-apple-macosx', 'release', 'warhead-runtime'),
  ]
}

function findRuntimeBinary(): string | null {
  return runtimeBinaryCandidates().find(path => existsSync(path)) ?? null
}

let buildPromise: Promise<string> | null = null

/** Build the Swift runtime once, before any request is issued.
 *
 *  This deliberately does not run under a probe timeout. MLX's first build can
 *  take minutes, and the per-request abort path kills its child to stop token
 *  generation — killing a half-finished SwiftPM build leaves a corrupt `.build`
 *  that fails every later request with missing-artifact errors. The build is
 *  shared by all callers and a failure is retried on the next attempt. */
function ensureRuntimeBuilt(): Promise<string> {
  buildPromise ??= buildRuntime().catch(error => {
    buildPromise = null
    throw error
  })
  return buildPromise
}

function buildRuntime(): Promise<string> {
  const existing = findRuntimeBinary()
  if (existing) return Promise.resolve(existing)
  if (process.platform !== 'darwin') {
    return Promise.reject(new Error('local MLX and GGUF models require macOS; set WARHEAD_MODEL to an Ollama provider for this host'))
  }
  if (!existsSync(join(runtimePackage, 'Package.swift'))) {
    return Promise.reject(new Error(`native runtime sources are missing: ${runtimePackage}`))
  }
  const swift = spawnSync('swift', ['--version'], { encoding: 'utf8' })
  if (swift.error || swift.status !== 0) {
    return Promise.reject(new Error('Swift toolchain not found. Install Xcode or the Swift toolchain, then retry.'))
  }
  // MLX compiles Metal shaders. A missing Metal component fails the build with
  // an opaque "CompileMetalFile failed"; name the fix here instead. `xcrun
  // --find` still succeeds on a broken install, so probe the compiler itself.
  const located = spawnSync('xcrun', ['--find', 'metal'], { encoding: 'utf8' })
  const metal = located.status === 0 ? located.stdout.trim() : ''
  const metalProbe = metal ? spawnSync(metal, ['--version'], { encoding: 'utf8' }) : null
  if (!metal || metalProbe?.status !== 0) {
    return Promise.reject(new Error(
      'Xcode\'s Metal Toolchain is not installed. Run:\n  xcodebuild -downloadComponent MetalToolchain',
    ))
  }
  process.stderr.write('building Warhead native runtime (first run only)…\n')
  const build = spawnSync('swift', ['build', '--configuration', 'release', '--package-path', runtimePackage], {
    stdio: 'inherit',
  })
  if (build.error) return Promise.reject(build.error)
  if (build.status !== 0) {
    return Promise.reject(new Error(
      `native runtime build failed (exit ${build.status ?? 'unknown'}). ` +
      'If the error names a missing Metal Toolchain, run: xcodebuild -downloadComponent MetalToolchain',
    ))
  }
  const built = findRuntimeBinary()
  if (!built) return Promise.reject(new Error('native runtime built successfully but no executable was found'))
  return Promise.resolve(built)
}

function toWire(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map(message => {
    if (message.role === 'tool') return {
      role: 'tool', content: message.content,
      tool_name: message.toolName ?? 'unknown',
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    }
    if (message.role === 'assistant' && message.toolCalls?.length) return {
      role: 'assistant', content: message.content,
      tool_calls: message.toolCalls.map(call => ({ id: call.id, function: { name: call.name, arguments: call.args } })),
    }
    return { role: message.role, content: message.content }
  })
}

const runtime = new NativeRuntime()

export function streamNativeChat(
  model: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; signal?: AbortSignal; numPredict?: number } = {},
): AsyncGenerator<RuntimeEvent> {
  return runtime.chat(model, messages, opts.tools ?? [], opts.signal, opts.numPredict)
}

/** Build/resolve the native runtime ahead of a caller's timeout window. The
 *  first Swift build can take minutes; a probe timer started before it would
 *  abort the first request immediately after a successful build. */
export const prepareNativeRuntime = (): Promise<string> => ensureRuntimeBuilt()

export const closeNativeRuntime = () => runtime.close()
