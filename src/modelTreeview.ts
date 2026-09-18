import * as vscode from 'vscode'
import { ManagedModel, ModelSource } from './types'
import { ModelManager, SOURCE_LABELS } from './modelManager'
import { NimManager } from './nimManager'
import { refreshEvents } from './events'

type Node = GroupNode | ModelNode | MessageNode

interface GroupNode { kind: 'group', source: ModelSource, label: string }
interface ModelNode { kind: 'model', model: ManagedModel }
interface MessageNode { kind: 'message', label: string }

export default class ModelsTreeProvider implements vscode.TreeDataProvider<Node> {
  private static instance?: ModelsTreeProvider
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  /** Singleton factory (audio-lab style). */
  static async createOrGet(manager: ModelManager, nim: NimManager): Promise<ModelsTreeProvider> {
    if (!ModelsTreeProvider.instance)
      ModelsTreeProvider.instance = new ModelsTreeProvider(manager, nim)
    return ModelsTreeProvider.instance
  }

  private constructor(
		private readonly manager: ModelManager,
		private readonly nim: NimManager
  ) {
    // Any part of the extension can fire refreshEvents.fire() to re-query the tree.
    refreshEvents.onDidRequestRefresh(() => this.refresh())
  }

  refresh(): void { this._onDidChangeTreeData.fire(undefined) }

  /** Refreshes the server/model status section of the tree. */
  refreshStatus(): void { this.refresh() }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded)
      item.contextValue = `group:${node.source}`
      item.iconPath = new vscode.ThemeIcon(
        node.source === 'cloud' ? 'cloud' : node.source === 'nim' ? 'vm-active' : 'desktop-download')
      return item
    }
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None)
      item.contextValue = 'message'
      return item
    }
    const m = node.model
    const item = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None)
    item.description = `${m.publisher} · ${m.source}`
    item.tooltip = new vscode.MarkdownString(`**${m.modelId}**\n\n- Source: ${SOURCE_LABELS[m.source]}` +
			(m.nimImage ? `\n- Image: \`${m.nimImage}\`` : '') + (m.nimPort ? `\n- Port: ${m.nimPort}` : ''))
    item.contextValue = `model:${m.source}:${m.modelId}`
    item.iconPath = new vscode.ThemeIcon(
      m.source === 'cloud' ? 'cloud' : m.source === 'nim' ? 'server-process' : 'code')
    item.command = { command: 'vidia.setChatModel', title: 'Use for Chat', arguments: [item] }
    return item
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      return (['cloud', 'nim', 'local'] as ModelSource[]).map(source => ({
        kind: 'group', source, label: SOURCE_LABELS[source]
      } as GroupNode))
    }
    if (element.kind !== 'group')  return []
    const models = this.manager.all().filter(m => m.source === element.source)
      .sort((a, b) => a.publisher.localeCompare(b.publisher) || a.name.localeCompare(b.name))
    if (models.length === 0) {
      const hint = element.source === 'cloud'
        ? 'No models. Use the + button to add one.'
        : element.source === 'nim' ? 'No NIM models. Add one and run its container.'
          : 'No local models. Add one and point to your local runtime.'
      return [{ kind: 'message', label: hint } as MessageNode]
    }
    if (element.source === 'nim') {
      for (const m of models) {
        const running = await this.nim.isRunning(m);
        (m as ManagedModel & { running?: boolean }).running = running
      }
    }
    return models.map(m => ({ kind: 'model', model: m } as ModelNode))
  }
}
