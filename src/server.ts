import { Disposable, ExtensionContext, OutputChannel, TreeItem, Uri, env, window, commands } from 'vscode'

import { ModelManager } from './modelManager'
import { NimManager } from './nimManager'
import { NvidiaClient } from './nvidiaClient'
import { registerChatParticipant } from './chatParticipant'
import { SecretManager } from './secretManager'
import { Services } from './types'
import { VidiaLmProvider } from './lmcProvider'
import ModelsTreeProvider from './modelTreeview'

/** Main server class encapsulating all extension services */
export default class Server {
  public secrets: SecretManager
  public client: NvidiaClient
  public manager: ModelManager
  public nim: NimManager
  public nimLog: OutputChannel
  public logs: OutputChannel
  private disposable: Disposable[] = []

  constructor(context: ExtensionContext) {
    this.secrets = new SecretManager(context)
    this.client = new NvidiaClient(() => this.secrets.getNvidiaKey(),
      (msg) => this.logs.appendLine(msg)
    )
    this.nim = new NimManager(
      () => this.secrets.getNgcKey(),
      (item) => this.manager.fromTreeItem(item),
      (msg) => this.nimLog.appendLine(msg)
    )
    this.manager = new ModelManager(
      context,
      (source) => source === 'nim' ? this.secrets.getNgcKey() : this.secrets.getNvidiaKey()
    )
    this.manager.setClient(this.client)
    this.logs = window.createOutputChannel('VIDIA', { log: true })
    this.nimLog = window.createOutputChannel('VIDIA · NIM')

    this.disposable.push(this.logs)
    this.disposable.push(this.nimLog)
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
    return { secrets: this.secrets, client: this.client, manager: this.manager, nim: this.nim, nimLog: this.nimLog }
  }

  /** Register the chat harness */
  registerChatHarness(context: ExtensionContext, _p: ModelsTreeProvider): Disposable[] {
    const { client, manager } = this.getServices()
    const provider = new VidiaLmProvider(manager, client, manager.onDidChange)
    return [provider.register(), registerChatParticipant(context, 'vidia')]
  }

  /** Model operations */
  async addModel(_p: ModelsTreeProvider, sourceArg?: string): Promise<void> {
    await this.manager.addModelFlow(sourceArg as never)
  }

  async removeModel(_p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
    await this.manager.removeModel(item, this.nim)
  }

  async pickChatModel(_p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
    await this.manager.selectChatModel(item)
  }

  async testModel(_p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
    await this.manager.testModel(item)
  }

  /** NIM container operations */
  async startNim(_p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
    await this.nim.startWithProgress(item)
  }

  async stopNim(_p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
    await this.nim.stopWithFeedback(item)
  }

  async showNimLogs(_p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
    await this.nim.showLogs(item, this.nimLog)
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

  /** Utility methods */
  openBuildNvidia(_p: ModelsTreeProvider): Thenable<unknown> {
    return env.openExternal(Uri.parse('https://build.nvidia.com/models'))
  }

  openSettings(): Thenable<unknown> {
    return commands.executeCommand('workbench.action.openSettings', '@vidia')
  }
}
