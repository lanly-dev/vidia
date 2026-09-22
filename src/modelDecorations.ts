import * as vscode from 'vscode'

/** Colors model rows in the Models tree with green text when that model is the active chat model.

 * The tree-item API cannot color label text directly, so the active model row gets its
 * green label through the FileDecoration API: each model row carries a `vidia-model:` resource URI
 * encoding whether it is the active chat model, and this provider tints matching labels green.
 */
export class ModelDecorationProvider implements vscode.FileDecorationProvider {
  /** Build the resource URI for a model row. */
  static uriFor(modelId: string, isActive: boolean): vscode.Uri {
    return vscode.Uri.from({
      scheme: 'vidia-model',
      path: `/${modelId}`,
      query: `active=${isActive ? '1' : '0'}`
    })
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'vidia-model') return undefined
    if (uri.query.includes('active=1')) return { color: new vscode.ThemeColor('charts.green') }
    return undefined
  }
}
