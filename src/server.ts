import { Disposable, ExtensionContext, LogOutputChannel, Uri, env, window, commands } from 'vscode'

import { ModelManager } from './modelManager'
import { NimManager } from './nimManager'
import { NvidiaClient } from './nvidiaClient'
import { registerChatParticipant } from './chatParticipant'
import { SecretManager } from './secretManager'
import { VidiaLmProvider } from './lmcProvider'
import ModelsTreeProvider from './modelTreeview'
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
      () => this.secrets.getNgcKey(),
      (arg) => this.manager.resolveModel(arg),
      (msg) => this.logs.appendLine(msg)
    )
    this.manager = new ModelManager(
      context,
      (source) => source === 'nim' ? this.secrets.getNgcKey() : this.secrets.getNvidiaKey()
    )
    this.manager.setClient(this.client)

    this.disposable.push(this.logs)
    this.disposable.push(this.manager)
  }

  /** Create a new Server instance */
  static create(context: ExtensionContext): Server {
    return new Server(context)
  }

  /** Helper function to get server instance (for backward compatibility) */
  static s(context: ExtensionContext): Server {
    return Server.create(context)
  }

  /** Get a deep copy of the services object */
  getServices(): Services {
    return { secrets: this.secrets, client: this.client, manager: this.manager, nim: this.nim }
  }

  /** Register the chat harness */
  registerChatHarness(context: ExtensionContext, _p: ModelsTreeProvider): Disposable[] {
    const { client, manager } = this.getServices()
    const provider = new VidiaLmProvider(manager, client, manager.onDidChange)
    return [provider.register(), registerChatParticipant(context, 'vidia')]
  }

  /**
   * Model operations. `arg` is the VidiaItem handed over for `view/item/context`
   * entries, or the model key passed by `TreeItem.command` (see `ModelArgument`).
   */
  async addModel(_p: ModelsTreeProvider, sourceArg?: string): Promise<void> {
    await this.manager.addModelFlow(sourceArg as never)
  }

  /** Inline "+" on the NIM group header: Docker/GPU preflight + catalog pick-list. */
  async addNim(_p: ModelsTreeProvider): Promise<void> {
    await this.manager.addNimFlow(this.nim)
  }

  async removeModel(_p: ModelsTreeProvider, arg?: ModelArgument): Promise<void> {
    await this.manager.removeModel(arg, this.nim)
  }

  async pickChatModel(_p: ModelsTreeProvider, arg?: ModelArgument): Promise<void> {
    await this.manager.selectChatModel(arg)
  }

  async testModel(_p: ModelsTreeProvider, arg?: ModelArgument): Promise<void> {
    await this.manager.testModel(arg)
  }

  /** NIM container operations */
  async startNim(_p: ModelsTreeProvider, arg?: ModelArgument): Promise<void> {
    await this.nim.startWithProgress(arg)
  }

  async stopNim(_p: ModelsTreeProvider, arg?: ModelArgument): Promise<void> {
    await this.nim.stopWithFeedback(arg)
  }

  async showNimLogs(_p: ModelsTreeProvider, arg?: ModelArgument): Promise<void> {
    await this.nim.showLogs(arg, this.logs)
  }

  /** Settings operations */
  async setNvidiaApiKey(_p: ModelsTreeProvider): Promise<void> {
    await this.secrets.setNvidiaKey()
  }

  async setNgcApiKey(_p: ModelsTreeProvider): Promise<void> {
    await this.secrets.setNgcKey()
  }

  async changeNvidiaApiKey(_p: ModelsTreeProvider): Promise<void> {
    await this.secrets.changeNvidiaKey()
  }

  /** Removes the stored API key(s) after confirmation (see SecretManager). */
  async clearApiKey(_p: ModelsTreeProvider): Promise<void> {
    await this.secrets.clearApiKey()
  }

  async openBuildNvidia(_p: ModelsTreeProvider): Promise<unknown> {
    return env.openExternal(Uri.parse('https://build.nvidia.com/models'))
  }

  /** Re-fetches `<baseUrl>/models` and persists it to globalState w/ timestamp. */
  async refreshCatalog(_p: ModelsTreeProvider): Promise<void> {
    await this.manager.refreshCatalogFlow()
  }

  openSettings(): Thenable<unknown> {
    return commands.executeCommand('workbench.action.openSettings', '@vidia')
  }
}
