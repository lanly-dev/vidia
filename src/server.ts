import { Disposable, ExtensionContext, LogOutputChannel, Uri, env, window, commands } from 'vscode'

import { ModelManager } from './modelManager'
import { NimManager } from './nimManager'
import { NvidiaClient } from './nvidiaClient'
import { registerChatParticipant } from './chatParticipant'
import { SecretManager } from './secretManager'
import { VidiaLmProvider } from './lmcProvider'
import type { ModelArgument, Services } from './types'

/** Main server class encapsulating all extension services */
export default class Server {
  public client: NvidiaClient
  public logs: LogOutputChannel
  public manager: ModelManager
  public nim: NimManager
  public secrets: SecretManager

  private disposable: Disposable[] = []

  constructor(context: ExtensionContext) {
    this.logs = window.createOutputChannel('VIDIA', { log: true })
    this.secrets = new SecretManager(context)
    this.client = new NvidiaClient(() => this.secrets.getNvidiaKey(),
      (msg) => this.logs.appendLine(msg)
    )
    this.nim = new NimManager(
      () => this.secrets.getNvidiaKey(),
      (arg) => this.manager.resolveModel(arg),
      (msg) => this.logs.appendLine(msg)
    )
    this.manager = new ModelManager(
      context,
      () => this.secrets.getNvidiaKey()
    )
    this.manager.setClient(this.client)

    this.disposable.push(this.logs)
    this.disposable.push(this.manager)
  }

  /** Read-only view of the services assembled in the constructor. */
  private getServices(): Services {
    return { secrets: this.secrets, client: this.client, manager: this.manager, nim: this.nim }
  }

  /** Register the chat harness */
  registerChatHarness(context: ExtensionContext): Disposable[] {
    const { client, manager } = this.getServices()
    const provider = new VidiaLmProvider(manager, client, manager.onDidChange)
    return [provider.register(), registerChatParticipant(context, 'vidia')]
  }

  /** Opens the add-model flow; `sourceArg` preselects the group when supplied. */
  async addModel(sourceArg?: string): Promise<void> {
    // The command system hands over an untrusted `string`, so narrow it here
    // rather than casting through `never` into `addModelFlow`.
    const source = sourceArg === 'cloud' || sourceArg === 'nim' ? sourceArg : undefined
    await this.manager.addModelFlow(source)
  }

  /** Inline "+" on the NIM group header: Docker/GPU preflight + catalog pick-list. */
  async addNim(): Promise<void> {
    await this.manager.addNimFlow(this.nim)
  }

  /**
   * Model operations. `arg` is the VidiaItem handed over for `view/item/context`
   * entries, or the model key passed by `TreeItem.command` (see `ModelArgument`).
   */
  async removeModel(arg?: ModelArgument): Promise<void> {
    await this.manager.removeModel(arg, this.nim)
  }

  async pickChatModel(arg?: ModelArgument): Promise<void> {
    await this.manager.selectChatModel(arg)
  }

  async testModel(arg?: ModelArgument): Promise<void> {
    await this.manager.testModel(arg)
  }

  /** NIM container operations */
  async startNim(arg?: ModelArgument): Promise<void> {
    await this.nim.startWithProgress(arg)
  }

  async stopNim(arg?: ModelArgument): Promise<void> {
    await this.nim.stopWithFeedback(arg)
  }

  async showNimLogs(arg?: ModelArgument): Promise<void> {
    await this.nim.showLogs(arg, this.logs)
  }

  /** Settings operations */
  async setNvidiaApiKey(): Promise<void> {
    await this.secrets.setNvidiaKey()
  }

  async changeNvidiaApiKey(): Promise<void> {
    await this.secrets.changeNvidiaKey()
  }

  /** Removes the stored API key(s) after confirmation (see SecretManager). */
  async clearApiKey(): Promise<void> {
    await this.secrets.clearApiKey()
  }

  async openBuildNvidia(): Promise<unknown> {
    return env.openExternal(Uri.parse('https://build.nvidia.com/models'))
  }

  /** Re-fetches `<baseUrl>/models` and persists it to globalState w/ timestamp. */
  async refreshCatalog(): Promise<void> {
    await this.manager.refreshCatalogFlow()
  }

  openSettings(): Thenable<unknown> {
    return commands.executeCommand('workbench.action.openSettings', '@vidia')
  }

  /** Releases the output channel and the model manager's event emitter. */
  dispose(): void {
    for (const d of this.disposable.splice(0)) d.dispose()
  }
}
