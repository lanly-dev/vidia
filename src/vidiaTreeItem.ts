import * as vscode from 'vscode'

import type { ManagedModel, ModelProbe, ModelStatus, ModelSource, NimContainerState } from './types'
import { NIM_STATE_HINTS, NIM_STATE_LABELS } from './types'
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
  /** Transient UI state of the NIM container; never persisted. */
  readonly nimState?: NimContainerState
  /** Latest probe result for the model, if the user ever tested it. */
  readonly probe?: ModelProbe
  /** Prerequisite failures for group rows (e.g. missing Docker / NVIDIA GPU). */
  readonly envIssues?: string[]
  /** Setup-check verdicts for group rows; absent on model/message rows. */
  readonly cloudOk?: boolean
  readonly ngcOk?: boolean

  constructor(
    kind: VidiaItem['kind'],
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    opts?: {
      model?: ManagedModel
      source?: ModelSource
      nimState?: NimContainerState
      probe?: ModelProbe
      envIssues?: string[]
      cloudOk?: boolean
      ngcOk?: boolean
    }
  ) {
    this.kind = kind
    this.label = label
    this.collapsible = collapsible
    this.model = opts?.model
    this.source = opts?.source
    this.nimState = opts?.nimState
    this.probe = opts?.probe
    this.envIssues = opts?.envIssues
    this.cloudOk = opts?.cloudOk
    this.ngcOk = opts?.ngcOk
  }

  toTreeItem(selectedModelKey: string | undefined, setChatCommand: string): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, this.collapsible)
    if (this.kind === 'group') {
      const source = this.source ?? 'cloud'
      item.id = `group:${source}`
      item.contextValue = `group:${source}`
      // Key-level verdicts from the setup check come first: a non-NGC key
      // disables the NIM group, an unverified key flags the cloud group.
      if (source === 'nim' && this.ngcOk === false) {
        item.iconPath = new vscode.ThemeIcon('warning',
          new vscode.ThemeColor('problemsWarningIcon.foreground'))
        item.tooltip = 'This NVIDIA API key is not NGC-enabled, so NIM images cannot be pulled ' +
          'from nvcr.io.\nUse a key from an NGC-linked account, or run "VIDIA: Verify NIM Setup".'
        item.description = 'NGC not enabled'
        return item
      }
      if (source === 'cloud' && this.cloudOk === false) {
        item.iconPath = new vscode.ThemeIcon('warning',
          new vscode.ThemeColor('problemsWarningIcon.foreground'))
        item.tooltip = 'The stored key was never verified against the cloud endpoint ' +
          '(it was saved without checking).\nRun "VIDIA: Verify NIM Setup" to verify it.'
        item.description = 'unverified key'
        return item
      }
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
    const state = m.source === 'nim' ? this.nimState : undefined
    item.id = m.key
    // "Ready to chat" = active + (cloud or nim-ready). Otherwise the row is
    // active-but-not-ready and gets the orange tint, so green always means
    // "will work right now".
    const notReady = m.source === 'nim' && state !== undefined && state !== 'ready'
    item.resourceUri = ModelDecorationProvider.uriFor(m.modelId, isActive, isDisabled, isActive && notReady)
    const statusSuffix = isDisabled ? ' · disabled' : ''
    const stateSuffix = state ? ` · ${NIM_STATE_LABELS[state]}` : ''
    item.description = `${m.publisher} · ${m.source}${stateSuffix}${statusSuffix}`
    const stateLine = state ? `\nContainer: ${NIM_STATE_LABELS[state]} — ${NIM_STATE_HINTS[state]}` : ''
    item.tooltip = `${m.modelId} (${SOURCE_LABELS[m.source]})${stateLine}` +
      (this.probe
        ? `\n[${status}] ${new Date(this.probe.testedAt).toLocaleString()}: ${(this.probe.reply || '').slice(0, 300)}`
        : '\n[untested] Use the inline test button to probe this model.')
    // Context value carries source + container state so package.json menus can
    // target precisely (e.g. only show Stop for a ready container).
    item.contextValue = `model:${m.source}${state ? `:${state}` : ''}:${status}`
    // Icon reflects container state (NIM) or validity (probe), never both.
    item.iconPath = this.pickIcon(m, state, isDisabled)
    item.command = { command: setChatCommand, title: 'Use for Chat', arguments: [m.key] }
    return item
  }

  /** Icon reflects container state (NIM) or probe validity, never both. */
  private pickIcon(m: ManagedModel, state: NimContainerState | undefined, isDisabled: boolean): vscode.ThemeIcon {
    // A disabled model is unusable regardless of container state — say so first.
    if (isDisabled) return new vscode.ThemeIcon('warning', new vscode.ThemeColor('disabledForeground'))
    if (m.source !== 'nim') return new vscode.ThemeIcon('cloud')
    switch (state) {
      case 'ready':
        return new vscode.ThemeIcon('server-process')
      case 'starting':
        return new vscode.ThemeIcon('loading~spin')
      case 'exited':
        return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'))
      case 'not-pulled':
        return new vscode.ThemeIcon('cloud-download', new vscode.ThemeColor('charts.orange'))
      case 'stopped':
        return new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('disabledForeground'))
      default:
        return new vscode.ThemeIcon('server')
    }
  }
}
