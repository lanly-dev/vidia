import * as vscode from 'vscode'
import { refreshEvents } from './events'
import { DEFAULT_BASE_URL } from './nvidiaClient'
import { NvidiaApiError } from './nvidiaErrors'
import { checkKey } from './keyVerifier'
import { checkNgc } from './ngcVerifier'
import type { SetupState } from './types'

const NVIDIA_KEY = 'vidia.nvapiKey'
const KEY_EXISTS_CONTEXT_KEY = 'vidia:setupKeyExists'
const SETUP_KEY = 'vidia.setupState'

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
    void vscode.commands.executeCommand('setContext', KEY_EXISTS_CONTEXT_KEY, exists)
  }

  async setNvidiaKey(): Promise<void> {
    // saveKey() syncs the context key and refreshes the tree on success;
    // nothing changed on cancel/reject, so there is nothing to sync here.
    await this.store(NVIDIA_KEY, 'Set NVIDIA API Key', 'https://build.nvidia.com/explore/discover')
  }

  private async store(name: string, prompt: string, link: string): Promise<void> {
    // NVIDIA has no OAuth login for its APIs, so the browser sign-in happens on the portal.
    // Users can paste their key directly into the input bar, test an existing key, or sign in via browser.
    const key = await this.context.secrets.get(name)

    type ActionItem = vscode.QuickPickItem & { test?: boolean, portal?: boolean, clear?: boolean }

    const baseItems: ActionItem[] = [
      { label: '$(globe) Sign in & generate key in browser', portal: true },
      ...(key ? [{ label: '$(check) Test current key', test: true }] : []),
      ...(key ? [{ label: '$(clear-all) Clear stored key…', clear: true }] : [])
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
      if (await this.saveKey(name, selectedOrKey, prompt)) return
      // Rejected — offer the input again instead of stranding the user.
      return this.store(name, prompt, link)
    }

    if (selectedOrKey.test) {
      // The "Test current key" item is only listed when a key is stored.
      const currentKey = key!
      try {
        const models = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Testing NVIDIA API key…' },
          () => this.testKey(currentKey))
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

    if (selectedOrKey.clear) {
      await this.clearApiKey()
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
      if (newKey) await this.saveKey(name, newKey, prompt)
    }
  }

  /** Persists a key only after the API has accepted it. Returns true when stored. */
  private async saveKey(name: string, key: string, prompt: string): Promise<boolean> {
    const trimmed = key.trim()

    // Never trust the catalog alone: /models is public and answers 200 for bogus keys.
    // Verify with an authenticated request before writing anything to SecretStorage.
    let failure: Error | undefined
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Verifying NVIDIA API key…' },
        () => this.testKey(trimmed))
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err))
    }

    if (failure) {
      const status = failure instanceof NvidiaApiError ? failure.status : undefined
      if (status === 401 || status === 403) {
        await vscode.window.showErrorMessage(
          `That NVIDIA API key was rejected: ${failure.message}`,
          {
            modal: true,
            detail: 'The key was not saved. Copy a fresh key from build.nvidia.com and paste it again.'
          })
        return false
      }
      // Offline, rate limited or endpoint trouble — the key itself may be fine.
      const choice = await vscode.window.showWarningMessage(
        `Could not verify the key: ${failure.message}`,
        { detail: 'Save it without checking?' }, 'Save Anyway', 'Discard')
      if (choice !== 'Save Anyway') return false
    }

    await this.context.secrets.delete(name)
    await this.context.secrets.store(name, trimmed)
    await this.syncKeyExistsContext()
    // Full setup: the cloud verdict is known from the check above; now prove
    // (or disprove) NGC pull access and persist both for the tree view.
    const ngcOk = await this.runNgcStep(trimmed)
    const setup = await this.writeSetupState(!failure, ngcOk)
    refreshEvents.fire()
    vscode.window.showInformationMessage(
      `${prompt} stored securely (SecretStorage). ${this.setupSummary(setup)}`)
    return true
  }

  /** Reads the last setup-check result, if the key was saved after this feature landed. */
  getSetupState(): SetupState | undefined {
    return this.context.globalState.get<SetupState>(SETUP_KEY)
  }

  /** Persists a setup-check result and refreshes the tree. */
  private async writeSetupState(cloudOk: boolean, ngcOk: boolean): Promise<SetupState> {
    const setup: SetupState = { cloudOk, ngcOk, checkedAt: Date.now() }
    await this.context.globalState.update(SETUP_KEY, setup)
    refreshEvents.fire()
    return setup
  }

  /**
   * NGC capability probe for a key. Never throws: an inconclusive answer
   * (offline, endpoint trouble) is reported as "not enabled" — a false
   * positive here would be worse than a re-check.
   */
  private async determineNgc(key: string): Promise<boolean> {
    try {
      return (await checkNgc(key)).ngc
    } catch {
      return false
    }
  }

  /** Runs the NGC probe behind a progress notification. */
  private async runNgcStep(key: string): Promise<boolean> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Checking NGC access…' },
      () => this.determineNgc(key))
  }

  private setupSummary(setup: SetupState): string {
    const cloud = setup.cloudOk ? 'Cloud endpoint: OK' : 'Cloud endpoint: key not verified'
    const ngc = setup.ngcOk ? 'NGC pull access: enabled' : 'NGC pull access: not enabled'
    return `NVIDIA setup — ${cloud}; ${ngc}.`
  }

  /**
   * Re-runs the full setup check for the currently stored key
   * (VIDIA: Re-check NIM Setup). Re-verifies cloud access and NGC pull
   * access, persists the result, and reports it.
   */
  async recheckSetup(): Promise<void> {
    const key = await this.context.secrets.get(NVIDIA_KEY)
    if (!key) {
      vscode.window.showWarningMessage('No NVIDIA API key stored yet — set one first.')
      return
    }
    const setup = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Checking NVIDIA setup…' },
      async () => {
        let cloudOk = false
        try {
          await this.testKey(key)
          cloudOk = true
        } catch {
          cloudOk = false
        }
        return this.writeSetupState(cloudOk, await this.determineNgc(key))
      })
    vscode.window.showInformationMessage(this.setupSummary(setup))
  }

  /**
   * Backfill for keys stored before the setup check existed: runs it once,
   * silently, the next time the extension activates.
   */
  async ensureSetupState(): Promise<void> {
    if (this.getSetupState()) return
    const key = await this.context.secrets.get(NVIDIA_KEY)
    if (!key) return
    try {
      let cloudOk = false
      try {
        await this.testKey(key)
        cloudOk = true
      } catch {
        cloudOk = false
      }
      await this.writeSetupState(cloudOk, await this.determineNgc(key))
    } catch {
      // Silent — the tree simply shows the pre-check state until re-run.
    }
  }

  /** Validates a cloud API key and returns the model catalog.
   *
   * The verdict itself lives in ./keyVerifier — a `vscode`-free module — so
   * `npm run key:check` exercises the exact same code path. This method only wires in the
   * configured base URL (the one the extension uses for chat).
   */
  private async testKey(key: string): Promise<{ id: string }[]> {
    const baseUrl = vscode.workspace.getConfiguration('vidia').get<string>('baseUrl', DEFAULT_BASE_URL)
    const { models } = await checkKey(baseUrl, key)
    return models
  }

  async changeNvidiaKey(): Promise<void> {
    await this.store(NVIDIA_KEY, 'Configure NVIDIA API Key', 'https://build.nvidia.com/explore/discover')
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
    await this.context.globalState.update(SETUP_KEY, undefined)
    await this.syncKeyExistsContext()
    refreshEvents.fire()
    vscode.window.showInformationMessage('Cleared NVIDIA API key from SecretStorage.', { modal: false })
  }
}
