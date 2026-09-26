import type { ChatMessage, ChatTarget, StreamCallbacks } from './types'
import { NvidiaApiError, friendlyHttpError } from './nvidiaErrors'

export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'

// The error helpers are pure (no `vscode`), so they live in ./nvidiaErrors where
// `npm run key:check` can bundle them. Re-exported here so existing importers keep working.
export { NvidiaApiError, friendlyHttpError, isNvidiaAccountFunctionNotFoundError } from './nvidiaErrors'

export class NvidiaClient {
  constructor(
    private readonly getApiKey: () => string | undefined | Thenable<string | undefined>,
    private readonly log: (msg: string) => void
  ) { }

  private async headers(apiKey?: string): Promise<Record<string, string>> {
    const key = apiKey ?? (await this.getApiKey())
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
    if (key) h['Authorization'] = `Bearer ${key}`
    return h
  }

  /**
   * Sends a chat request and streams deltas to the callback.
   * Works against any OpenAI-compatible endpoint (cloud or NIM container).
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
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return full
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
    if (!res.ok) throw new NvidiaApiError(res.status, friendlyHttpError(res.status, body))
    try {
      const json = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> }
      const reply = json.choices?.[0]?.message?.content?.trim() ?? ''
      return { reply, httpStatus: res.status }
    } catch {
      throw new NvidiaApiError(res.status, `Unparseable probe response (${res.status}).`)
    }
  }
}
