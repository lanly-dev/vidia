import * as vscode from 'vscode'

/** Colors model rows in the Models tree.
 *
 * The tree-item API cannot color label text directly, so each model row
 * carries a `vidia-model:` resource URI encoding whether it is the active
 * chat model or probed disabled — this provider tints matching labels green
 * (active chat model) or grey (disabled via failed probe).
 */
export class ModelDecorationProvider implements vscode.FileDecorationProvider {
  /** Build the resource URI for a model row. */
  static uriFor(modelId: string, isActive: boolean, isDisabled = false): vscode.Uri {
    return vscode.Uri.from({
      scheme: 'vidia-model',
      path: `/${modelId}`,
      query: `active=${isActive ? '1' : '0'}&disabled=${isDisabled ? '1' : '0'}`
    })
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'vidia-model') return undefined
    if (uri.query.includes('disabled=1')) return { color: new vscode.ThemeColor('disabledForeground') }
    if (uri.query.includes('active=1')) return { color: new vscode.ThemeColor('charts.green') }
    return undefined
  }
}
