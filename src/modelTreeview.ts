import * as vscode from 'vscode'

import type { ManagedModel, ModelSource } from './types'
import { VidiaItem } from './vidiaTreeItem'
import type { ModelManager } from './modelManager'
import { SOURCE_LABELS } from './modelManager'
import type { NimManager } from './nimManager'
import { refreshEvents } from './events'
import type { SecretManager } from './secretManager'


export default class ModelsTreeProvider implements vscode.TreeDataProvider<VidiaItem> {
  private static instance?: ModelsTreeProvider
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<VidiaItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

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
  }

  refresh(): void { this._onDidChangeTreeData.fire(undefined) }

  /** Refreshes the server/model status section of the tree. */
  refreshStatus(): void { this.refresh() }

  private get selectedModelKey(): string | undefined {
    return vscode.workspace.getConfiguration('vidia').get<string>('chatModel', '')
  }

  /** The node already carries everything the item needs; build it lazily here. */
  getTreeItem(node: VidiaItem): vscode.TreeItem {
    return node.toTreeItem(this.selectedModelKey, 'vidia.ncp.setChatModelItem')
  }

  async getChildren(element?: VidiaItem): Promise<VidiaItem[]> {
    if (!element) {
      const nodes: VidiaItem[] = []
      if (!await this.secretManager.getNvidiaKey()) {
        nodes.push(new VidiaItem('setup', 'Set your NVIDIA API key to get started',
          vscode.TreeItemCollapsibleState.None))
      }
      for (const source of ['cloud', 'nim', 'local'] as ModelSource[]) {
        const opts: { source: ModelSource, envIssues?: string[] } = { source }
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
        : element.source === 'nim' ? 'No NIM models. Add one and run its container.'
          : 'No local models. Add one and point to your local runtime.'
      return [new VidiaItem('message', hint, vscode.TreeItemCollapsibleState.None)]
    }
    const items: VidiaItem[] = []
    for (const m of models) {
      const running = element.source === 'nim' ? await this.nimManager.isRunning(m) : false
      items.push(new VidiaItem('model', m.name, vscode.TreeItemCollapsibleState.None,
        { model: m, source: m.source, running, probe: this.modelManager.getProbe(m.key) }))
    }
    return items
  }
}
