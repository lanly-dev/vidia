import * as vscode from 'vscode'
import { ManagedModel, ModelSource } from './types'
import { ModelManager, SOURCE_LABELS } from './modelManager'
import { NimManager } from './nimManager'
import type { SecretManager } from './secretManager'
import { refreshEvents } from './events'
import { ModelDecorationProvider } from './modelDecorations'

type Node = SetupNode | GroupNode | ModelNode | MessageNode

interface SetupNode { kind: 'setup' }
interface GroupNode { kind: 'group', source: ModelSource, label: string }
interface ModelNode { kind: 'model', model: ManagedModel }
interface MessageNode { kind: 'message', label: string }

export default class ModelsTreeProvider implements vscode.TreeDataProvider<Node> {
  private static instance?: ModelsTreeProvider
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  /** Singleton factory (audio-lab style). */
  static async createOrGet(
    manager: ModelManager,
    nim: NimManager,
    secrets: SecretManager
  ): Promise<ModelsTreeProvider> {
    if (!ModelsTreeProvider.instance) ModelsTreeProvider.instance = new ModelsTreeProvider(manager, nim, secrets)
    return ModelsTreeProvider.instance
  }
  private constructor(
    private readonly manager: ModelManager,
    private readonly nim: NimManager,
    private readonly secrets: SecretManager
  ) {
    // Any part of the extension can fire refreshEvents.fire() to re-query the tree.
    refreshEvents.onDidRequestRefresh(() => this.refresh())
  }

  refresh(): void { this._onDidChangeTreeData.fire(undefined) }

  /** Refreshes the server/model status section of the tree. */
  refreshStatus(): void { this.refresh() }

  /**
   * Returns the key of the currently selected chat model, or undefined if none is set.
   */
  private get selectedModelKey(): string | undefined {
    return vscode.workspace.getConfiguration('vidia').get<string>('chatModel', '')
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'setup') {
      const item = new vscode.TreeItem('Set your NVIDIA API key to get started',
        vscode.TreeItemCollapsibleState.None)
      item.description = 'Click here to enter your key'
      item.tooltip = new vscode.MarkdownString(
        '**No NVIDIA API key found.**\n\nClick this row to paste your API key (nvapi-…).\n\n' +
        'No key yet? Use the $(globe) button on the right to create a free one on ' +
        '[build.nvidia.com](https://build.nvidia.com/explore/discover).')
      item.contextValue = 'setup'
      item.iconPath = new vscode.ThemeIcon('key')
      // Clicking the row opens the key input field; the inline $(globe) button
      // (see package.json view/item/context) opens the key portal website.
      item.command = { command: 'vidia.setNvidiaApiKey', title: 'Set NVIDIA API Key' }
      return item
    }
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
    const isActive = this.selectedModelKey === m.key
    const item = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None)
    item.resourceUri = ModelDecorationProvider.uriFor(m.modelId, isActive)
    item.description = `${m.publisher} · ${m.source}`
    item.tooltip = new vscode.MarkdownString(`**${m.modelId}**\n\n- Source: ${SOURCE_LABELS[m.source]}` +
      (m.nimImage ? `\n- Image: \`${m.nimImage}\`` : '') + (m.nimPort ? `\n- Port: ${m.nimPort}` : ''))
    item.contextValue = `model:${m.source}:${m.modelId}`
    item.iconPath = new vscode.ThemeIcon(
      m.source === 'cloud' ? 'cloud' : m.source === 'nim' ? 'server-process' : 'code')
    item.command = { command: 'vidia.ncp.setChatModelItem', title: 'Use for Chat', arguments: [item] }

    if (isActive) item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
    return item
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      // Show a top-level setup item while no NVIDIA API key is stored yet.
      const nodes: Node[] = []
      if (!await this.secrets.getNvidiaKey()) nodes.push({ kind: 'setup' })
      return nodes.concat((['cloud', 'nim', 'local'] as ModelSource[]).map(source => ({
        kind: 'group', source, label: SOURCE_LABELS[source]
      } as GroupNode)))
    }
    if (element.kind !== 'group') return []
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
