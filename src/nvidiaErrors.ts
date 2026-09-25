/**
 * Pure NVIDIA HTTP error helpers — deliberately free of any `vscode` import so they can be
 * bundled and executed outside the extension host (see `scripts/key-check.mjs`).
 */

export class NvidiaApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

/** True when `body` is the NVIDIA JSON error returned when a model's deployment is
 * not mapped to the caller's account. Two observed body shapes:
 *   {"status":404,"title":"Not Found","detail":"Function 'xxx': Not found for account 'yyy'"}
 *   {"errors":[{"message":"Function 'xxx': is not found"}]}
 */
export function isNvidiaAccountFunctionNotFoundError(body: string): boolean {
  try {
    const json = JSON.parse(body) as {
      detail?: string
      errors?: Array<{ message?: string }>
    }
    const msg = json.detail ?? json.errors?.[0]?.message ?? ''
    return msg.includes('Not found for account') || msg.includes('is not found')
  } catch {
    return false
  }
}

/** Actionable message shown when a model's deployment is not mapped to the caller's
 * NVIDIA account (i.e. "Public API Endpoints" is not enabled for the organization). */
export const NVIDIA_ACCOUNT_ENTITLEMENT_HINT = 'This model is not available on your NVIDIA account.'

export function friendlyHttpError(status: number, body: string): string {
  if (status === 401 || status === 403) return 'Authorization failed. Check your API key.'
  if (status === 429) return 'Rate limit reached on the free NVIDIA endpoint.'
  if (status >= 500) return `NVIDIA server error (${status}).`
  if (status === 404 && isNvidiaAccountFunctionNotFoundError(body)) return NVIDIA_ACCOUNT_ENTITLEMENT_HINT
  return `NVIDIA API request failed (${status}): ${body.slice(0, 300)}`
}
