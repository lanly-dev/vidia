import * as vscode from 'vscode'

const NVIDIA_KEY = 'vidia.nvapiKey'
const NGC_KEY = 'vidia.ngcApiKey'

/**
 * Owns API keys stored in VS Code SecretStorage.
 * Keys are never written to settings.json or state.
 */
export class SecretManager {
  constructor(private readonly context: vscode.ExtensionContext) { }

  getNvidiaKey(): Thenable<string | undefined> { return this.context.secrets.get(NVIDIA_KEY) }

  getNgcKey(): Thenable<string | undefined> { return this.context.secrets.get(NGC_KEY) }

  async setNvidiaKey(): Promise<void> {
    await this.store(NVIDIA_KEY, 'Set NVIDIA API Key', 'https://build.nvidia.com/explore/discover')
  }

  async setNgcKey(): Promise<void> {
    await this.store(NGC_KEY, 'Set NGC API Key', 'https://org.ngc.nvidia.com/setup/api-keys')
  }

  private async store(name: string, prompt: string, link: string): Promise<void> {
    const key = await vscode.window.showInputBox({
      prompt, password: true, ignoreFocusOut: true, placeHolder: 'nvapi-… key'
    })
    if (key) {
      await this.context.secrets.delete(name)
      await this.context.secrets.store(name, key.trim())
      vscode.window.showInformationMessage(`${prompt} stored securely (SecretStorage). Get/refresh keys at ${link}`)
    }
  }
}
