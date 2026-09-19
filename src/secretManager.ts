import * as vscode from 'vscode'

const NVIDIA_KEY = 'vidia.nvapiKey'
const NGC_KEY = 'vidia.ngcApiKey'
const KEY_EXISTS_CONTEXT_KEY = 'vidia:setupKeyExists'

/**
 * Owns API keys stored in VS Code SecretStorage.
 * Keys are never written to settings.json or state.
 */
export class SecretManager {
  constructor(private readonly context: vscode.ExtensionContext) { }

  getNvidiaKey(): Thenable<string | undefined> { return this.context.secrets.get(NVIDIA_KEY) }

  getNgcKey(): Thenable<string | undefined> { return this.context.secrets.get(NGC_KEY) }

  async initKeyExistsContext(): Promise<void> {
    await this.syncKeyExistsContext()
  }

  private async syncKeyExistsContext(): Promise<void> {
    const exists = !!(await this.context.secrets.get(NVIDIA_KEY))
    void this.context.globalState.update(KEY_EXISTS_CONTEXT_KEY, exists)
    void vscode.commands.executeCommand('setContext', KEY_EXISTS_CONTEXT_KEY, exists)
  }

  async setNvidiaKey(): Promise<void> {
    await this.store(NVIDIA_KEY, 'Set NVIDIA API Key', 'https://build.nvidia.com/explore/discover')
    this.syncKeyExistsContext()
  }

  async setNgcKey(): Promise<void> {
    await this.store(NGC_KEY, 'Set NGC API Key', 'https://org.ngc.nvidia.com/setup/api-keys')
    this.syncKeyExistsContext()
  }

  private async store(name: string, prompt: string, link: string): Promise<void> {
    // "Login-like" flow: NVIDIA has no OAuth login for its APIs, so the browser
    // sign-in happens on the portal — the credential is always the generated key.
    // We also allow testing the already-stored key from the same entry point.
    const key = await this.context.secrets.get(name)
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(globe) Sign in & generate key in browser', portal: true },
        { label: '$(key) I already have a key — paste it', portal: false },
        ...(key
          ? [{ label: '$(check) Test current key', test: true }]
          : [])
      ],
      { placeHolder: `${prompt} (sign in on the portal, copy the key, paste it back here)` })
    if (!action) return

    if (action.test) {
      if (!key) {
        vscode.window.showWarningMessage(
          'No key is stored yet — paste one or sign in to generate one instead.',
          { modal: false })
        return
      }
      try {
        const models = await this.testKey(key)
        vscode.window.showInformationMessage(
          `Key is valid — ${models.length} model(s) available on the cloud endpoint.`,
          { modal: false })
      } catch (err) {
        vscode.window.showErrorMessage(
          `Key check failed: ${(err as Error).message}`,
          { modal: true })
      }
      return
    }

    if (action.portal) {
      await vscode.env.openExternal(vscode.Uri.parse(link))
      const ok = await vscode.window.showInformationMessage(
        `Signing in at ${new URL(link).hostname}. After signing in, copy the generated API key.`,
        'I have the key')
      if (!ok) return
    }
    const newKey = await vscode.window.showInputBox({
      prompt, password: true, ignoreFocusOut: true, placeHolder: 'nvapi-… key'
    })
    if (newKey) {
      await this.context.secrets.delete(name)
      await this.context.secrets.store(name, newKey.trim())
      vscode.window.showInformationMessage(`${prompt} stored securely (SecretStorage). Get/refresh keys at ${link}`)
    }
  }

  /** Validates a cloud API key by sending a tiny chat completion request.
   * A 401/403 means the key is bad; any 2xx means it's valid and usable.
   * Uses the same base URL the extension uses for chat (baseUrl setting or default).
   */
  private async testKey(key: string): Promise<{ id: string }[]> {
    const baseUrl = vscode.workspace.getConfiguration('vidia').get<string>('baseUrl',
      'https://integrate.api.nvidia.com/v1')
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      }
    })
    const body = await res.text()
    if (!res.ok) {
      let msg: string
      if (res.status === 401 || res.status === 403)
        msg = 'Authorization failed. Check your NVIDIA API key (NVIDIA: Set NVIDIA API Key).'
      else if (res.status === 429)
        msg = 'Rate limit reached on the free NVIDIA endpoint. Wait a moment and retry.'
      else if (res.status === 404) {
        msg = 'The /models endpoint was not found at this base URL ' +
              'check your VIDIA baseUrl setting or the key may not expose a model catalog.'
      }
      else if (res.status >= 500)
        msg = `NVIDIA server error (${res.status}). The endpoint may be busy; try again later.`
      else
        msg = `NVIDIA API request failed (${res.status}): ${body.slice(0, 300)}`
      const fallback = res.status === 404
        ? await this.testKeyViaChat(baseUrl, key)
        : null
      if (!fallback) throw new Error(msg)
      return fallback
    }
    const json = JSON.parse(body) as { data?: Array<{ id?: string }> }
    return (json.data ?? []).filter(m => typeof (m as any).id === 'string') as { id: string }[]
  }

  async changeNvidiaKey(): Promise<void> {
    await this.store(NVIDIA_KEY, 'Change NVIDIA API Key', 'https://build.nvidia.com/explore/discover')
  }

  /** Fallback: validate a key via a tiny chat completion when /models is unavailable. */
  private async testKeyViaChat(baseUrl: string, key: string): Promise<{ id: string }[]> {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      body: JSON.stringify({
        model: 'nvidia/llama-3.1-nemotron-70b-instruct',
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 4,
        temperature: 0
      })
    })
    if (!res.ok) {
      const body = await res.text()
      let msg: string
      if (res.status === 401 || res.status === 403)
        msg = 'Authorization failed. Check your NVIDIA API key (NVIDIA: Set NVIDIA API Key).'
      else if (res.status === 429)
        msg = 'Rate limit reached on the free NVIDIA endpoint. Wait a moment and retry.'
      else if (res.status >= 500)
        msg = `NVIDIA server error (${res.status}). The endpoint may be busy; try again later.`
      else
        msg = `NVIDIA API request failed (${res.status}): ${body.slice(0, 300)}`
      throw new Error(msg)
    }
    return [{ id: 'cloud:nvidia/llama-3.1-nemotron-70b-instruct' }]
  }
}
