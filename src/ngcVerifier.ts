import { NvidiaApiError } from './nvidiaErrors'

/**
 * NGC capability check for an NVIDIA API key.
 *
 * The same `nvapi-…` key issued by build.nvidia.com doubles as the NGC API
 * key: `docker login nvcr.io -u '$oauthtoken' -p <key>` pulls NIM containers
 * with it. This module proves that capability with a single authenticated
 * request to the NGC API — a 200 means the key is NGC-linked and NIM images
 * can be pulled; 401/403 means it is not.
 *
 * Like ./keyVerifier, this module has no `vscode` dependency on purpose.
 *
 * NOTE: the exact NGC endpoint contract comes from NVIDIA's NGC API docs
 * rather than a live probe here — if NVIDIA ever moves it, this check degrades
 * to "not enabled" (never to a false positive) and the user can re-run it
 * from VIDIA: Re-check NVIDIA Setup.
 */
const NGC_API_BASE = 'https://api.ngc.nvidia.com/v2'

/** True when the key is accepted by the NGC API (NIM pulls will work). */
export async function checkNgc(key: string): Promise<{ ngc: boolean }> {
  const res = await fetch(`${NGC_API_BASE}/orgs`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`
    }
  })
  if (res.ok) return { ngc: true }
  if (res.status === 401 || res.status === 403) return { ngc: false }
  throw new NvidiaApiError(res.status,
    `NGC check inconclusive — api.ngc.nvidia.com answered ${res.status}.`)
}

// The verifier throws this type; callers need it to tell "definitively not
// NGC-enabled" (401/403) apart from "could not check" (network trouble, …).
export { NvidiaApiError } from './nvidiaErrors'
