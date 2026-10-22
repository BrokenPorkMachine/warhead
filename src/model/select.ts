/**
 * Model selection.
 *
 * Single implementation of the fallback chain, shared by the REPL and the
 * diagnostic entrypoint. This previously existed twice with divergent behaviour
 * (only one of them persisted probe results, only one filtered known-bad
 * candidates) — a drift hazard on exactly the path that decides what the agent
 * is allowed to run on.
 *
 * Chain: configured candidates -> scan installed models -> hard failure with
 * per-model reasons. Never degrades silently to a model that cannot call tools.
 */

import { saveConfig, type Config } from '../config.ts'
import { listInstalledModels, scanForToolCapable, selectModel } from './probe.ts'
import type { ProbeResult } from '../types.ts'

export type ResolveDeps = {
  /** Prompt the user to choose. Omit for non-interactive use. */
  pick?: (capable: ProbeResult[]) => Promise<string>
  /** Receives one line per probe outcome, for display. */
  report?: (r: ProbeResult) => void
  /** Persist probe outcomes. Off for read-only diagnostics. */
  persist?: boolean
}

export type Resolved = {
  model: string
  results: ProbeResult[]
  /** How the model was chosen, for display. */
  via: 'candidate' | 'scan' | 'only-option'
}

function defaultPick(capable: ProbeResult[]): Promise<string> {
  const first = capable[0]!
  if (capable.length === 1) return Promise.resolve(first.model)
  return Promise.resolve(first.model)
}

export async function resolveModel(cfg: Config, deps: ResolveDeps = {}): Promise<Resolved> {
  const report = deps.report ?? (() => {})
  const pick = deps.pick ?? defaultPick
  const persist = deps.persist ?? true

  // Skip candidates already recorded as non-functional, unless that would leave
  // nothing to try — a stale "unsupported" must not permanently exclude a model.
  const explicit = process.env['WARHEAD_MODEL']?.trim()
  const candidates = explicit ? [explicit] : [...cfg.model.candidates]
  const viable = candidates.filter(m => cfg.model.known[m]?.status !== 'unsupported')
  const queue = viable.length > 0 ? viable : candidates

  const first = await selectModel(queue)
  first.results.forEach(report)

  if (first.chosen) {
    if (persist) {
      const last = first.results.at(-1)
      if (last) cfg.model.known[first.chosen] = { status: last.status, detail: last.detail }
      saveConfig(cfg)
    }
    return { model: first.chosen, results: first.results, via: 'candidate' }
  }

  // An explicit environment selection is authoritative. Scanning other models
  // here would make a typo or unsupported request silently choose a different
  // model than the operator configured.
  if (explicit) {
    throw new Error(
      [`WARHEAD_MODEL (${explicit}) cannot call tools:`,
        ...first.results.map(r => `  ${r.model} — ${r.status}: ${r.detail}`)].join('\n'),
    )
  }

  if (!cfg.model.scanInstalledOnFailure) {
    throw new Error(
      [
        'no configured model can call tools, and scanning installed models is disabled.',
        ...first.results.map(r => `  ${r.model} — ${r.status}: ${r.detail}`),
      ].join('\n'),
    )
  }

  const installed = await listInstalledModels()
  if (installed.length === 0) {
    throw new Error(
      [
        'no models are installed, and none of the configured candidates resolved.',
        ...first.results.map(r => `  ${r.model} — ${r.status}: ${r.detail}`),
      ].join('\n'),
    )
  }

  const { capable, rejected } = await scanForToolCapable(installed)
  rejected.forEach(report)
  if (persist) for (const r of rejected) cfg.model.known[r.model] = { status: r.status, detail: r.detail }

  if (capable.length === 0) {
    throw new Error(
      [
        'no available model can call tools.',
        '',
        'rejected:',
        ...first.results.map(r => `  ${r.model} — ${r.status}: ${r.detail}`),
        ...rejected.map(r => `  ${r.model} — ${r.status}: ${r.detail}`),
      ].join('\n'),
    )
  }

  if (persist) {
    for (const r of capable) cfg.model.known[r.model] = { status: 'ok', detail: r.detail }
    saveConfig(cfg)
  }

  const model = await pick(capable)
  return { model, results: [...first.results, ...capable, ...rejected], via: capable.length === 1 ? 'only-option' : 'scan' }
}
