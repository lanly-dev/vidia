/**
 * Batch verification of the cloud model catalog.
 *
 * NVIDIA's `/models` list is authoritative for ids, but it also contains
 * retired entries and models the caller's key is not entitled to — both feel
 * exactly like "this model doesn't exist" when picked. This module probes
 * every catalog id with the same tiny chat request the key check uses and
 * records a per-model verdict, so the Add Model pick-list can hide the dead.
 *
 * Like ./keyVerifier and ./ngcVerifier, this module has no `vscode`
 * dependency on purpose.
 */

import { NvidiaApiError } from './nvidiaErrors'

/** Per-model verdict: whether the key could actually call the model. */
export interface CatalogVerdict {
  ok: boolean
  checkedAt: number
}

export type CatalogVerdicts = Record<string, CatalogVerdict>

/** How long a verdict is trusted before a model is re-probed. */
export const VERDICT_TTL_MS = 5 * 24 * 60 * 60 * 1000

const PROBE_TIMEOUT_MS = 30_000
/** Workers probing in parallel. */
const CONCURRENCY = 2
/**
 * Minimum gap between request starts: 2s => ~30 RPM, comfortably under the
 * ~40 RPM free-tier ceiling. The limit counts requests, not tokens, so tiny
 * probes cost the same as real calls against it.
 */
const MIN_MS_BETWEEN_STARTS = 2000
/** Consecutive 429s before the run gives up instead of hammering the limit. */
const MAX_CONSECUTIVE_429 = 3

type ProbeResult = 'ok' | 'dead' | 'unknown' | 'rateLimited'

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const onAbort = (): void => {
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort)
  })
}

function normalize(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * One tiny chat request against a single model id.
 * - 2xx => the key can call it.
 * - 404/410 (incl. NVIDIA's per-account entitlement 404) => dead for this key.
 * - 401/403 => the key itself is rejected; throws to abort the whole run.
 * - 429 => rate limited; timeouts/network errors => unknown.
 */
async function probeOnce(
  baseUrl: string,
  key: string,
  model: string,
  signal?: AbortSignal
): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${normalize(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 4,
        temperature: 0
      }),
      signal: ctrl.signal
    })
    await res.text() // drain; body content is irrelevant here
    if (res.ok) return 'ok'
    if (res.status === 401 || res.status === 403)
      throw new NvidiaApiError(res.status, `API key rejected (${res.status}).`)
    if (res.status === 429) return 'rateLimited'
    if (res.status === 404 || res.status === 410) return 'dead'
    return 'unknown'
  } catch (e) {
    if (e instanceof NvidiaApiError) throw e
    return 'unknown'
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export interface VerifyBatchOptions {
  signal?: AbortSignal
  concurrency?: number
  minMsBetweenStarts?: number
  /** Previously stored verdicts; fresh ones are reused, not re-probed. */
  verdicts?: CatalogVerdicts
  verdictTtlMs?: number
  onProgress?: (done: number, total: number, dead: number) => void
}

export interface VerifyBatchResult {
  /** Old fresh verdicts merged with the new ones from this run. */
  verdicts: CatalogVerdicts
  ok: number
  dead: number
  unknown: number
  /** True when the key was rejected mid-run (401/403). */
  abortedForAuth: boolean
  /** True when consecutive 429s stopped the run early. */
  rateLimited: boolean
  cancelled: boolean
}

/**
 * Probes every model id with a tiny request, paced under the free-tier RPM
 * ceiling. Returns merged verdicts (fresh old ones kept) plus run stats.
 */
export async function probeCatalogModels(
  baseUrl: string,
  key: string,
  modelIds: string[],
  opts: VerifyBatchOptions = {}
): Promise<VerifyBatchResult> {
  const concurrency = Math.max(1, opts.concurrency ?? CONCURRENCY)
  const gap = opts.minMsBetweenStarts ?? MIN_MS_BETWEEN_STARTS
  const ttl = opts.verdictTtlMs ?? VERDICT_TTL_MS
  const now = Date.now()

  const merged: CatalogVerdicts = { ...(opts.verdicts ?? {}) }
  const todo = modelIds.filter(id => {
    const v = merged[id]
    return !(v && now - v.checkedAt < ttl)
  })

  let done = 0
  let ok = 0
  let dead = 0
  let unknown = 0
  let idx = 0
  let lastStart = 0
  let consecutive429 = 0
  let stop = false
  let authFailed = false
  const report = (): void => opts.onProgress?.(done, todo.length, dead)

  // Serializes start-slot claims so workers together never exceed the pace.
  let nextClaim = Promise.resolve()
  async function claimSlot(): Promise<boolean> {
    let release!: () => void
    const slot = new Promise<void>(r => { release = r })
    const prev = nextClaim
    nextClaim = slot
    await prev
    if (stop || opts.signal?.aborted) {
      release()
      return false
    }
    const wait = lastStart + gap - Date.now()
    if (wait > 0) await sleep(wait, opts.signal)
    if (stop || opts.signal?.aborted) {
      release()
      return false
    }
    lastStart = Date.now()
    release()
    return true
  }

  async function worker(): Promise<void> {
    while (!stop && !opts.signal?.aborted) {
      const i = idx++
      if (i >= todo.length) return
      if (!await claimSlot()) return
      const id = todo[i]
      let outcome: ProbeResult
      try {
        outcome = await probeOnce(baseUrl, key, id, opts.signal)
      } catch (e) {
        if (e instanceof NvidiaApiError) {
          authFailed = true
          stop = true
          return
        }
        outcome = 'unknown'
      }
      if (outcome === 'rateLimited') {
        consecutive429++
        unknown++
        done++
        report()
        if (consecutive429 >= MAX_CONSECUTIVE_429) {
          stop = true
          return
        }
        await sleep(15_000, opts.signal)
        continue
      }
      consecutive429 = 0
      const stamp = Date.now()
      if (outcome === 'ok') {
        ok++
        merged[id] = { ok: true, checkedAt: stamp }
      } else if (outcome === 'dead') {
        dead++
        merged[id] = { ok: false, checkedAt: stamp }
      } else unknown++
      done++
      report()
    }
  }

  report()
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, () => worker()))
  return {
    verdicts: merged,
    ok,
    dead,
    unknown,
    abortedForAuth: authFailed,
    rateLimited: stop && !authFailed,
    cancelled: !!opts.signal?.aborted
  }
}
