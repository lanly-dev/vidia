import * as vscode from 'vscode'
import { refreshEvents } from './events'
import { friendlyHttpError } from './nvidiaClient'

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
  }

  /**
   * Removes stored API key(s) from SecretStorage after confirmation.
   * When both the NVIDIA and NGC keys exist, a quick pick asks which one to
   * drop (with a "Clear all stored keys" option). Afterwards the
   * `vidia:setupKeyExists` context key is re-synced (hiding the Change/Clear
   * buttons) and the tree is refreshed so the setup row reappears.
   */
  async clearApiKey(): Promise<void> {
    const entries: { label: string, description: string, id: 'nvidia' | 'ngc' }[] = []
    if (await this.context.secrets.get(NVIDIA_KEY))
      entries.push({ label: '$(key) NVIDIA API key', description: 'nvapi-… · build.nvidia.com', id: 'nvidia' })
    if (await this.context.secrets.get(NGC_KEY))
      entries.push({ label: '$(key) NGC API key', description: 'ngc-… · org.ngc.nvidia.com', id: 'ngc' })
    if (entries.length === 0) {
      vscode.window.showInformationMessage('No API key is stored — nothing to clear.', { modal: false })
      return
    }

    // Only one key stored → clear it directly; otherwise ask which one.
    let ids: Array<'nvidia' | 'ngc'> = [entries[0].id]
    if (entries.length > 1) {
      const pick = await vscode.window.showQuickPick(
        [...entries, { label: '$(trash) Clear all stored keys', description: 'NVIDIA + NGC', id: 'all' as const }],
        { placeHolder: 'Select the API key to clear (removed from VS Code SecretStorage)' })
      if (!pick) return
      ids = pick.id === 'all' ? ['nvidia', 'ngc'] : [pick.id]
    }

    const what = ids.length > 1
      ? 'both stored API keys'
      : ids[0] === 'nvidia' ? 'the NVIDIA API key' : 'the NGC API key'
    const confirm = await vscode.window.showWarningMessage(
      `Clear ${what}?`,
      {
        modal: true,
        detail: 'The key is deleted from VS Code SecretStorage. VIDIA will ask for it again the next time it needs one.'
      },
      'Clear Key')
    if (!confirm) return

    for (const id of ids)
      await this.context.secrets.delete(id === 'nvidia' ? NVIDIA_KEY : NGC_KEY)
    await this.syncKeyExistsContext()
    refreshEvents.fire()
    vscode.window.showInformationMessage(
      `Cleared ${what} from SecretStorage.`, { modal: false })
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
