import * as vscode from 'vscode'

import type { ManagedModel, ModelProbe, ModelStatus, ModelSource } from './types'
import { ModelDecorationProvider } from './modelDecorations'

/** Human-readable group labels, kept here (leaf module) to avoid import cycles. */
export const SOURCE_LABELS: Record<ModelSource, string> = {
  cloud: 'Cloud · Free Endpoint',
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
  readonly kind: 'group' | 'model' | 'message'
  readonly label: string
  readonly collapsible: vscode.TreeItemCollapsibleState
  readonly model?: ManagedModel
  readonly source?: ModelSource
  /** Transient UI state (NIM container running); never persisted. */
  readonly running?: boolean
  /** Latest probe result for the model, if the user ever tested it. */
  readonly probe?: ModelProbe
  /** Prerequisite failures for group rows (e.g. missing Docker / NVIDIA GPU). */
  readonly envIssues?: string[]

  constructor(
    kind: VidiaItem['kind'],
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    opts?: { model?: ManagedModel, source?: ModelSource, running?: boolean, probe?: ModelProbe, envIssues?: string[] }
  ) {
    this.kind = kind
    this.label = label
    this.collapsible = collapsible
    this.model = opts?.model
    this.source = opts?.source
    this.running = opts?.running
    this.probe = opts?.probe
    this.envIssues = opts?.envIssues
  }

  toTreeItem(selectedModelKey: string | undefined, setChatCommand: string): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, this.collapsible)
    if (this.kind === 'group') {
      const source = this.source ?? 'cloud'
      item.id = `group:${source}`
      item.contextValue = `group:${source}`
      // Prerequisite failures (no Docker / no NVIDIA GPU) turn the header
      // into a warning row; tooltip lists exactly what is missing.
      if (this.envIssues?.length) {
        item.iconPath = new vscode.ThemeIcon('warning',
          new vscode.ThemeColor('problemsWarningIcon.foreground'))
        item.tooltip = this.envIssues.join('\n')
        item.description = 'setup required'
        return item
      }
      item.iconPath = new vscode.ThemeIcon(source === 'cloud' ? 'cloud' : 'vm-active')
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
    // No probe record yet → untested (e.g. newly added). 404 probe → disabled.
    const status: ModelStatus = this.probe?.status ?? 'untested'
    const isActive = selectedModelKey === m.key
    const isDisabled = status === 'disabled'
    item.id = m.key
    item.resourceUri = ModelDecorationProvider.uriFor(m.modelId, isActive, isDisabled)
    const statusSuffix = isDisabled ? ' · disabled' : ''
    item.description = `${m.publisher} · ${m.source}${this.running ? ' · running' : ''}${statusSuffix}`
    item.tooltip = `${m.modelId} (${SOURCE_LABELS[m.source]})${this.running ? ' - running' : ''}` +
      (this.probe
        ? `\n[${status}] ${new Date(this.probe.testedAt).toLocaleString()}: ${(this.probe.reply || '').slice(0, 300)}`
        : '\n[untested] Use the inline test button to probe this model.')
    // Untested rows carry the inline Test button; active/disabled rows hide it.
    item.contextValue = `model:${m.source}:${m.modelId}:${status}`
    // No status icons: active/untested rows use the source icon; disabled
    // rows are greyed out via FileDecoration and show a warning glyph.
    item.iconPath = isDisabled
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('disabledForeground'))
      : new vscode.ThemeIcon(m.source === 'cloud' ? 'cloud' : 'server-process')
    item.command = { command: setChatCommand, title: 'Use for Chat', arguments: [m.key] }
    return item
  }
}
