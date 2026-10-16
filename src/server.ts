import { Disposable, ExtensionContext, LogOutputChannel, Uri, env, window, commands } from 'vscode'

import { ModelManager } from './modelManager'
import { NimManager } from './nimManager'
import { NvidiaClient } from './nvidiaClient'
import { registerChatParticipant } from './chatParticipant'
import { SecretManager } from './secretManager'
import { VidiaLmProvider } from './lmcProvider'
import type { ModelArgument } from './types'

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
      (msg) => this.logs.appendLine(msg),
      () => this.secrets.getSetupState()
    )
    this.manager = new ModelManager(
      context,
      () => this.secrets.getNvidiaKey(),
      () => this.secrets.getSetupState()
    )
    this.manager.setClient(this.client)

    this.disposable.push(this.logs)
    this.disposable.push(this.manager)
    this.disposable.push(this.nim)
  }

  /** Register the chat harness (provider + @vidia participant). */
  registerChatHarness(): Disposable[] {
    const provider = new VidiaLmProvider(this.manager, this.client, this.manager.onDidChange)
    return [provider.register(), registerChatParticipant('vidia')]
  }

  /** Inline "+" on the cloud group header: catalog pick-list, straight into that group. */
  async addFep(): Promise<void> {
    await this.manager.addFepFlow()
  }

  /**
   * View-title "+" (and Command Palette "Add Model"): offers both sources,
   * then routes to the matching single-purpose flow.
   */
  async addModel(): Promise<void> {
    const pick = await window.showQuickPick(
      [
        {
          label: '$(cloud) Free Endpoint',
          description: 'Cloud model from the NVIDIA chat catalog',
          source: 'cloud' as const
        },
        {
          label: '$(vm-active) NIM Model',
          description: 'Self-hosted container from the NGC NIM catalog',
          source: 'nim' as const
        }
      ],
      { placeHolder: 'Where should this model run?' })
    if (!pick) return
    if (pick.source === 'nim') await this.addNim()
    else await this.addFep()
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

  /** Re-runs the full NVIDIA setup check for the stored key. */
  async recheckSetup(): Promise<void> {
    await this.secrets.recheckSetup()
  }

  async openBuildNvidia(): Promise<unknown> {
    return env.openExternal(Uri.parse('https://build.nvidia.com/models'))
  }

  /** Probes every FE catalog model and caches per-model liveness verdicts. */
  async probeFeCatalog(): Promise<void> {
    await this.manager.probeFeCatalogFlow()
  }

  openSettings(): Thenable<unknown> {
    return commands.executeCommand('workbench.action.openSettings', '@vidia')
  }

  /** Releases the output channel and the model manager's event emitter. */
  dispose(): void {
    for (const d of this.disposable.splice(0)) d.dispose()
  }
}
