import * as vscode from 'vscode'

import type { ManagedModel, ModelSource } from './types'
import { SOURCE_LABELS, VidiaItem } from './vidiaTreeItem'
import type { ModelManager } from './modelManager'
import type { NimManager } from './nimManager'
import { refreshEvents } from './events'
import type { SecretManager } from './secretManager'

export default class ModelsTreeProvider implements vscode.TreeDataProvider<VidiaItem>, vscode.Disposable {
  private static instance?: ModelsTreeProvider
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<VidiaItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event
  /** Poll that flips `starting` containers to Ready in the tree; see startAutoRefresh. */
  private autoRefresh?: ReturnType<typeof setInterval>
  /** Window-focus listener that refreshes state when the user looks back. */
  private focusSubscription?: vscode.Disposable
  /** True while some NIM container is still `starting`; the poll idles otherwise. */
  private transient = false

  /** Singleton factory (audio-lab style). */
  static async createOrGet(mm: ModelManager, nm: NimManager, sm: SecretManager): Promise<ModelsTreeProvider> {
    if (!ModelsTreeProvider.instance) ModelsTreeProvider.instance = new ModelsTreeProvider(mm, nm, sm)
    return ModelsTreeProvider.instance
  }

  private constructor(
    private readonly modelManager: ModelManager,
    private readonly nimManager: NimManager,
    private readonly secretManager: SecretManager
  ) {
    refreshEvents.onDidRequestRefresh(() => this.refresh())
    this.startAutoRefresh()
  }

  refresh(): void { this._onDidChangeTreeData.fire(undefined) }

  /** Refreshes the server/model status section of the tree. */
  refreshStatus(): void { this.refresh() }

  /**
   * Keeps container states honest without manual refreshes:
   *  - a slow poll (every 5s) that only re-probes while some NIM model is still
   *    `starting` (so a container flipping to Ready updates the row on its own,
   *    without churning `docker ps` when nothing is warming up);
   *  - a refresh whenever the window regains focus (the user is likely looking).
   */
  private startAutoRefresh(): void {
    this.autoRefresh = setInterval(() => {
      if (!this.transient) return
      this.nimManager.invalidateState()
      this.refresh()
    }, 5_000)
    this.focusSubscription = vscode.window.onDidChangeWindowState(e => {
      if (e.focused) { this.nimManager.invalidateState(); this.refresh() }
    })
  }

  /** Releases the tree-data change emitter and the auto-refresh timer. */
  dispose(): void {
    if (this.autoRefresh) clearInterval(this.autoRefresh)
    this.focusSubscription?.dispose()
    this._onDidChangeTreeData.dispose()
  }

  private get selectedModelKey(): string | undefined {
    return vscode.workspace.getConfiguration('vidia').get<string>('chatModel', '')
  }

  /** The node already carries everything the item needs; build it lazily here. */
  getTreeItem(node: VidiaItem): vscode.TreeItem {
    return node.toTreeItem(this.selectedModelKey, 'vidia.ncp.setChatModelItem')
  }

  async getChildren(element?: VidiaItem): Promise<VidiaItem[]> {
    if (!element) {
      if (!await this.secretManager.getNvidiaKey()) return []
      const setup = this.secretManager.getSetupState()
      // A full refresh starts here, so clear the "something is starting" flag;
      // the model rows below re-set it if a container is still warming up.
      this.transient = false
      // Legacy keys (stored before the setup check existed) are treated as
      // cloud-OK; ensureSetupState backfills the real verdict in the background.
      const cloudOk = setup?.cloudOk ?? true
      const ngcOk = setup?.ngcOk ?? false
      const nodes: VidiaItem[] = []
      for (const source of ['cloud', 'nim'] as ModelSource[]) {
        const opts: { source: ModelSource, cloudOk: boolean, ngcOk: boolean, envIssues?: string[] } =
          { source, cloudOk, ngcOk }
        // NIM header shows a warning icon until Docker + NVIDIA GPU are present.
        if (source === 'nim') opts.envIssues = (await this.nimManager.checkEnv()).issues
        nodes.push(new VidiaItem('group', SOURCE_LABELS[source], vscode.TreeItemCollapsibleState.Expanded, opts))
      }
      return nodes
    }
    if (element.kind !== 'group' || !element.source) return []
    // Disabled (404 probe) models sink to the bottom; the rest stay sorted.
    const isDisabled = (key: string): boolean => this.modelManager.getProbe(key)?.status === 'disabled'
    const models = this.modelManager.all().filter(m => m.source === element.source)
      .sort((a, b) =>
        Number(isDisabled(a.key)) - Number(isDisabled(b.key)) ||
        a.publisher.localeCompare(b.publisher) || a.name.localeCompare(b.name))
    if (models.length === 0) {
      const hint = element.source === 'cloud'
        ? 'No models. Use the + button to add one.'
        : 'No NIM models. Add one and run its container.'
      return [new VidiaItem('message', hint, vscode.TreeItemCollapsibleState.None)]
    }
    const items: VidiaItem[] = []
    for (const m of models) {
      const nimState = element.source === 'nim' ? await this.nimManager.getContainerState(m) : undefined
      if (nimState === 'starting') this.transient = true
      items.push(new VidiaItem('model', m.name, vscode.TreeItemCollapsibleState.None,
        { model: m, source: m.source, nimState, probe: this.modelManager.getProbe(m.key) }))
    }
    return items
  }
}
