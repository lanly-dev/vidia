import {
  friendlyHttpError, isNvidiaAccountFunctionNotFoundError, NvidiaApiError
} from './nvidiaErrors'

/**
 * Verdict logic for NVIDIA API keys.
 *
 * `GET /models` is a **public** catalog — it answers 200 even for a bogus key — so it only
 * supplies candidate probe models. The credential itself is proven by authenticated
 * `POST /chat/completions` probes: a bad key is rejected with 401/403 before the endpoint
 * does any model-level work, while a working key answers 2xx (or a "Not found for account"
 * 404, which is only reachable once authentication has already succeeded).
 *
 * This module has no `vscode` dependency on purpose: `scripts/key-check.mjs` bundles and
 * executes it directly, so `npm run key:check` exercises the very same code the extension
 * runs rather than a copy that could drift.
 */

/** Probe model used when the catalog is unavailable (custom base URL).
 * It is checked first because auth runs ahead of model resolution here: a bogus key gets a
 * definitive 401/403, instead of a model-level 404/410 that would reveal nothing. */
export const FALLBACK_PROBE_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'

/** Upper bound on authenticated POSTs spent proving or disproving a key. */
export const MAX_PROBE_ATTEMPTS = 8

/** What a single probe revealed about the key. */
export type ProbeOutcome = 'valid' | 'invalid' | 'inconclusive'

export interface ProbeReport {
  model: string
  status: number
  outcome: ProbeOutcome
  body: string
}

export interface KeyCheckResult {
  /** Catalog from `GET /models` — probe candidates and a count for the UI, never proof. */
  models: { id: string }[]
  /** How many authenticated POSTs the verdict took. */
  probes: number
}

type OnProbe = (report: ProbeReport) => void

const normalize = (baseUrl: string): string => baseUrl.replace(/\/+$/, '')

/** Model catalog for the current base URL. A custom endpoint without one yields []. */
export async function fetchCatalog(baseUrl: string, key: string): Promise<{ id: string }[]> {
  const res = await fetch(`${normalize(baseUrl)}/models`, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {})
    }
  })
  if (res.status === 404) return []
  const body = await res.text()
  if (!res.ok) throw new NvidiaApiError(res.status, friendlyHttpError(res.status, body))
  const json = JSON.parse(body) as { data?: Array<{ id?: string }> }
  return (json.data ?? []).filter((m): m is { id: string } => typeof m.id === 'string')
}

/** Probes a few catalog models until the key is proven good or bad.
 * 410 (model past end of life) and plain 404s reveal nothing about the key, so those
 * candidates are skipped instead of being reported as a failure or a success.
 * Returns the number of probes spent; throws `NvidiaApiError` when the key is rejected or
 * when no candidate produced a definitive answer.
 */
export async function verifyKey(
  baseUrl: string,
  key: string,
  models: { id: string }[],
  onProbe?: OnProbe
): Promise<number> {
  // Known-live NVIDIA chat model first, then catalog models as backups.
  const candidates = [...new Set([FALLBACK_PROBE_MODEL, ...models.map(m => m.id)])]
    .slice(0, MAX_PROBE_ATTEMPTS)

  let lastStatus = 0
  let lastBody = ''
  let probes = 0

  for (const model of candidates) {
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
      })
    })
    lastStatus = res.status
    lastBody = await res.text()
    probes++

    if (res.ok) {
      onProbe?.({ model, status: lastStatus, outcome: 'valid', body: lastBody })
      return probes
    }

    // Authentication runs ahead of model resolution, so this is definitive.
    if (res.status === 401 || res.status === 403) {
      onProbe?.({ model, status: lastStatus, outcome: 'invalid', body: lastBody })
      throw new NvidiaApiError(lastStatus, friendlyHttpError(lastStatus, lastBody))
    }

    // Account entitlement is only reported once the key authenticated successfully.
    if (res.status === 404 && isNvidiaAccountFunctionNotFoundError(lastBody)) {
      onProbe?.({ model, status: lastStatus, outcome: 'valid', body: lastBody })
      return probes
    }

    // Otherwise (gone, plain 404, other 4xx) the answer says nothing about the key.
    onProbe?.({ model, status: lastStatus, outcome: 'inconclusive', body: lastBody })
  }

  throw new NvidiaApiError(lastStatus,
    `Could not verify the API key — the endpoint answered ${lastStatus}: ${lastBody.slice(0, 200)}`)
}

/** Full check: catalog for probe candidates + authenticated probes for the verdict. */
export async function checkKey(baseUrl: string, key: string, onProbe?: OnProbe): Promise<KeyCheckResult> {
  const models = await fetchCatalog(baseUrl, key)
  const probes = await verifyKey(baseUrl, key, models, onProbe)
  return { models, probes }
}

// The verifier throws this type; callers need it to tell "definitively rejected" (401/403)
// apart from "could not verify" (offline, rate limited, endpoint trouble).
export { NvidiaApiError } from './nvidiaErrors'
