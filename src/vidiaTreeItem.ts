import * as vscode from 'vscode'

import type { ManagedModel } from './types'
import { ModelDecorationProvider } from './modelDecorations'

export type VidiaSource = 'cloud' | 'nim' | 'local'

/** Human-readable group labels, kept here (leaf module) to avoid import cycles. */
export const SOURCE_LABELS: Record<VidiaSource, string> = {
  cloud: 'Cloud · Free Endpoint',
  local: 'Local · Runtime',
  nim: 'NIM · Self-Hosted'
}

/**
 * Single element type for the Models tree: the node already carries everything
 * the item needs, so context-menu commands receive the data directly instead of
 * a `contextValue` string that has to be parsed back.
 *
 * NOTE: intentionally NOT `extends vscode.TreeItem`. During extension-host
 * startup the `vscode` module is a thin stub whose classes (e.g. `TreeItem`)
 * are only filled in after activation resolves; subclassing one at module load
 * can throw/hang before `activate()` ever runs. So this is a plain data class
 * and the provider builds a real `vscode.TreeItem` from it in `getTreeItem()`.
 */
export class VidiaItem {
  readonly kind: 'setup' | 'group' | 'model' | 'message'
  readonly label: string
  readonly collapsible: vscode.TreeItemCollapsibleState
  readonly model?: ManagedModel
  readonly source?: VidiaSource
  /** Transient UI state (NIM container running); never persisted. */
  readonly running?: boolean

  constructor(
    kind: VidiaItem['kind'],
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    opts?: { model?: ManagedModel, source?: VidiaSource, running?: boolean }
  ) {
    this.kind = kind
    this.label = label
    this.collapsible = collapsible
    this.model = opts?.model
    this.source = opts?.source
    this.running = opts?.running
  }

  toTreeItem(selectedModelKey: string | undefined, setChatCommand: string): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, this.collapsible)
    if (this.kind === 'setup') {
      item.id = 'setup'
      item.description = 'Click here to enter your key'
      item.tooltip = 'No NVIDIA API key found. Click this row to paste your key (nvapi-...).'
      item.contextValue = 'setup'
      item.iconPath = new vscode.ThemeIcon('key')
      item.command = { command: 'vidia.setNvidiaApiKey', title: 'Set NVIDIA API Key' }
      return item
    }
    if (this.kind === 'group') {
      const source = this.source ?? 'cloud'
      item.id = `group:${source}`
      item.contextValue = `group:${source}`
      item.iconPath = new vscode.ThemeIcon(
        source === 'cloud' ? 'cloud' : source === 'nim' ? 'vm-active' : 'desktop-download')
      return item
    }
    if (this.kind === 'message') {
      item.contextValue = 'message'
      return item
    }
    const m = this.model
    if (!m) {
      item.contextValue = 'message'
      return item
    }
    const isActive = selectedModelKey === m.key
    item.id = m.key
    item.resourceUri = ModelDecorationProvider.uriFor(m.modelId, isActive)
    item.description = `${m.publisher} · ${m.source}${this.running ? ' · running' : ''}`
    item.tooltip = `${m.modelId} (${SOURCE_LABELS[m.source]})${this.running ? ' - running' : ''}`
    item.contextValue = `model:${m.source}:${m.modelId}`
    item.iconPath = isActive
      ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon(
        m.source === 'cloud' ? 'cloud' : m.source === 'nim' ? 'server-process' : 'code')
    item.command = { command: setChatCommand, title: 'Use for Chat', arguments: [m.key] }
    return item
  }
}
