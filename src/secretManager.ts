import * as vscode from 'vscode'
import { refreshEvents } from './events'
import { friendlyHttpError } from './nvidiaClient'

const NVIDIA_KEY = 'vidia.nvapiKey'
const KEY_EXISTS_CONTEXT_KEY = 'vidia:setupKeyExists'

/**
 * Owns API keys stored in VS Code SecretStorage.
 * Keys are never written to settings.json or state.
 */
export class SecretManager {
  constructor(private readonly context: vscode.ExtensionContext) { }

  getNvidiaKey(): Thenable<string | undefined> { return this.context.secrets.get(NVIDIA_KEY) }

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
    await this.syncKeyExistsContext()
    refreshEvents.fire()
  }

  private async store(name: string, prompt: string, link: string): Promise<void> {
    // NVIDIA has no OAuth login for its APIs, so the browser sign-in happens on the portal.
    // Users can paste their key directly into the input bar, test an existing key, or sign in via browser.
    const key = await this.context.secrets.get(name)

    type ActionItem = vscode.QuickPickItem & { test?: boolean, portal?: boolean }

    const baseItems: ActionItem[] = [
      { label: '$(globe) Sign in & generate key in browser', portal: true },
      ...(key ? [{ label: '$(check) Test current key', test: true }] : [])
    ]

    const selectedOrKey = await new Promise<string | ActionItem | undefined>((resolve) => {
      const qp = vscode.window.createQuickPick<ActionItem>()
      qp.title = prompt
      qp.placeholder = 'Paste NVIDIA API key (nvapi-…) or select an option below'
      qp.ignoreFocusOut = true
      qp.items = baseItems

      qp.onDidAccept(() => {
        const val = qp.value.trim()
        if (val) {
          qp.hide()
          resolve(val)
          return
        }
        const selected = qp.selectedItems[0]
        qp.hide()
        resolve(selected)
      })

      qp.onDidHide(() => {
        qp.dispose()
        resolve(undefined)
      })

      qp.show()
    })

    if (!selectedOrKey) return

    // If a key string was pasted/typed directly into the quickpick
    if (typeof selectedOrKey === 'string') {
      await this.saveKey(name, selectedOrKey, prompt, link)
      return
    }

    if (selectedOrKey.test) {
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

    if (selectedOrKey.portal) {
      await vscode.env.openExternal(vscode.Uri.parse(link))
      const ok = await vscode.window.showInformationMessage(
        `Signing in at ${new URL(link).hostname}. After signing in, copy the generated API key.`,
        'I have the key')
      if (!ok) return

      const newKey = await vscode.window.showInputBox({
        prompt, password: true, ignoreFocusOut: true, placeHolder: 'nvapi-… key'
      })
      if (newKey) await this.saveKey(name, newKey, prompt, link)
    }
  }

  private async saveKey(name: string, key: string, prompt: string, link: string): Promise<void> {
    await this.context.secrets.delete(name)
    await this.context.secrets.store(name, key.trim())
    await this.syncKeyExistsContext()
    refreshEvents.fire()
    vscode.window.showInformationMessage(`${prompt} stored securely (SecretStorage). Get/refresh keys at ${link}`)
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
      // A missing model catalog (custom base URL, or a key that does not expose
      // /models) is verified with a tiny chat completion instead; that probe error
      // is more specific (bad key vs. model not entitled to this account).
      if (res.status === 404) return this.testKeyViaChat(baseUrl, key)
      throw new Error(friendlyHttpError(res.status, body))
    }
    const json = JSON.parse(body) as { data?: Array<{ id?: string }> }
    return (json.data ?? []).filter(m => typeof (m as any).id === 'string') as { id: string }[]
  }

  async changeNvidiaKey(): Promise<void> {
    await this.store(NVIDIA_KEY, 'Change NVIDIA API Key', 'https://build.nvidia.com/explore/discover')
    await this.syncKeyExistsContext()
    refreshEvents.fire()
  }

  /**
   * Removes stored NVIDIA API key from SecretStorage after confirmation.
   * Afterwards the `vidia:setupKeyExists` context key is re-synced and the tree is refreshed.
   */
  async clearApiKey(): Promise<void> {
    const key = await this.context.secrets.get(NVIDIA_KEY)
    if (!key) {
      vscode.window.showInformationMessage('No API key is stored — nothing to clear.', { modal: false })
      return
    }

    const confirm = await vscode.window.showWarningMessage(
      'Clear the stored NVIDIA API key?',
      {
        modal: true,
        detail: 'The key is deleted from VS Code SecretStorage. VIDIA will ask for it again the next time it needs one.'
      },
      'Clear Key')
    if (!confirm) return

    await this.context.secrets.delete(NVIDIA_KEY)
    await this.syncKeyExistsContext()
    refreshEvents.fire()
    vscode.window.showInformationMessage('Cleared NVIDIA API key from SecretStorage.', { modal: false })
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
      // 401/403 => bad key; 404 with 'Not found for account' => model not entitled.
      throw new Error(friendlyHttpError(res.status, body))
    }
    return [{ id: 'cloud:nvidia/llama-3.1-nemotron-70b-instruct' }]
  }
}
