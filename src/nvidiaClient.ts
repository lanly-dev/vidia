import * as vscode from 'vscode'
import type { CatalogModel, ChatMessage, ChatTarget, StreamCallbacks } from './types'

export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'

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
export const NVIDIA_ACCOUNT_ENTITLEMENT_HINT =
  'This model is not available on your NVIDIA account. Your API key is valid, but the ' +
  '"Public API Endpoints" entitlement may not be enabled for your account/organization. ' +
  'Visit https://build.nvidia.com/explore/discover, sign in, and request access to ' +
  'Public API Endpoints. Alternatively, self-host the model via a NIM container or local runtime.'

export function friendlyHttpError(status: number, body: string): string {
  if (status === 401 || status === 403)
    return 'Authorization failed. Check your NVIDIA API key (NVIDIA: Set NVIDIA API Key).'

  if (status === 429)
  {return 'Rate limit reached on the free NVIDIA endpoint. Wait a moment and retry,' +
      ' or self-host the model via NIM/local runtime.'}

  if (status >= 500)
    return `NVIDIA server error (${status}). The endpoint may be busy; try again later.`

  if (status === 404 && isNvidiaAccountFunctionNotFoundError(body))
    return NVIDIA_ACCOUNT_ENTITLEMENT_HINT

  return `NVIDIA API request failed (${status}): ${body.slice(0, 300)}`
}

export class NvidiaClient {
  constructor(
		private readonly getApiKey: () => string | undefined | Thenable<string | undefined>,
		private readonly log: (msg: string) => void
  ) { }

  get baseUrl(): string {
    return vscode.workspace.getConfiguration('vidia').get<string>('baseUrl', DEFAULT_BASE_URL)
  }

  private async headers(apiKey?: string): Promise<Record<string, string>> {
    const key = apiKey ?? (await this.getApiKey())
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
    if (key)  h['Authorization'] = `Bearer ${key}`
    return h
  }

  /** Lists models available on the (free) cloud endpoint. */
  async listModels(apiKey?: string): Promise<CatalogModel[]> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: await this.headers(apiKey) })
    const body = await res.text()
    if (!res.ok)  throw new NvidiaApiError(res.status, friendlyHttpError(res.status, body))
    const json = JSON.parse(body) as { data?: Array<{ id?: string }> }
    const models: CatalogModel[] = (json.data ?? [])
      .filter(m => typeof m.id === 'string')
      .map(m => {
        const id = m.id as string
        const slash = id.indexOf('/')
        const publisher = slash > 0 ? id.slice(0, slash) : 'nvidia'
        const name = slash > 0 ? id.slice(slash + 1) : id
        return { id, publisher, name }
      })
      .sort((a, b) => a.publisher.localeCompare(b.publisher) || a.name.localeCompare(b.name))
    return models
  }

  /**
	 * Sends a chat request and streams deltas to the callback.
	 * Works against any OpenAI-compatible endpoint (cloud, NIM container, or local runtime).
	 */
  async chatStream(
    target: ChatTarget,
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<string> {
    const res = await fetch(`${target.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: await this.headers(target.apiKey),
      body: JSON.stringify({
        model: target.model,
        messages,
        stream: true,
        temperature: 0.7,
        top_p: 0.95,
        max_tokens: 4096
      }),
      signal
    })
    const status = res.status
    if (!res.ok || !res.body) {
      const body = res.body ? await res.text() : 'no response body'
      throw new NvidiaApiError(status, friendlyHttpError(status, body))
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done)  break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:'))  continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]')  return full
        try {
          const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
          const delta = json.choices?.[0]?.delta?.content
          if (delta) {
            full += delta
            callbacks.onDelta(delta)
          }
        } catch (e) {
          this.log(`Ignored unparseable SSE chunk: ${payload.slice(0, 120)}`)
        }
      }
    }
    return full
  }

  /** Quick non-streaming sanity test of a model. */
  async testModel(target: ChatTarget): Promise<string> {
    return this.chatStream(target, [{ role: 'user', content: 'Reply with exactly: OK' }], { onDelta: () => undefined })
  }

  /**
   * Probes a model with "Which model are you?" (non-streaming) and returns
   * the reply text together with the HTTP status. Throws NvidiaApiError
   * carrying `status` on transport/HTTP failure so callers can mark 404s.
   */
  async probeModel(target: ChatTarget): Promise<{ reply: string, httpStatus: number }> {
    const res = await fetch(`${target.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: await this.headers(target.apiKey),
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: 'user', content: 'Which model are you?' }],
        stream: false,
        temperature: 0,
        max_tokens: 256
      })
    })
    const body = await res.text()
    if (!res.ok)  throw new NvidiaApiError(res.status, friendlyHttpError(res.status, body))
    try {
      const json = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> }
      const reply = json.choices?.[0]?.message?.content?.trim() ?? ''
      return { reply, httpStatus: res.status }
    } catch {
      throw new NvidiaApiError(res.status, `Unparseable probe response (${res.status}).`)
    }
  }
}
