import { commands, ExtensionContext, window, Disposable } from 'vscode'

import ModelsTreeProvider from './modelTreeview'
import Server from './server'
import { ModelDecorationProvider } from './modelDecorations'
import type { ModelArgument } from './types'

export async function activate(context: ExtensionContext) {
  const rc = commands.registerCommand

  const server = new Server(context)
  await server.secrets.initKeyExistsContext()
  const p = await ModelsTreeProvider.createOrGet(server.manager, server.nim, server.secrets)
  const harness = server.registerChatHarness(context, p)

  // Bind the activity-bar view to its data provider
  const d0 = window.createTreeView('vidia.modelsExplorer', {
    treeDataProvider: p,
    showCollapseAll: true
  })

  // FileDecoration provider that colors the active model's label green, following
  // the same pattern used in vscode-lemon (modelDecorations.ts).
  const dDecorations = window.registerFileDecorationProvider(new ModelDecorationProvider())

  const d1 = rc('vidia.internal.addModel', (sourceArg?: string) => server.addModel(p, sourceArg))
  // Tree commands receive the VidiaItem itself (context menu) or the model key
  // (row click); the argument is forwarded as-is and resolved by ModelManager.
  const d2 = rc('vidia.ncp.removeModelItem', (arg?: ModelArgument) => server.removeModel(p, arg))
  const d3 = rc('vidia.ncp.setChatModelItem', (arg?: ModelArgument) => server.pickChatModel(p, arg))
  const d4 = rc('vidia.ncp.testModelItem', (arg?: ModelArgument) => server.testModel(p, arg))
  const d5 = rc('vidia.ncp.startNimItem', (arg?: ModelArgument) => server.startNim(p, arg))
  const d6 = rc('vidia.ncp.stopNimItem', (arg?: ModelArgument) => server.stopNim(p, arg))
  const d7 = rc('vidia.ncp.showNimLogsItem', (arg?: ModelArgument) => server.showNimLogs(p, arg))

  const d8 = rc('vidia.setNvidiaApiKey', () => server.setNvidiaApiKey(p))
  const d9 = rc('vidia.setNgcApiKey', () => server.setNgcApiKey(p))
  const d10 = rc('vidia.openBuildNvidia', () => server.openBuildNvidia(p))
  const d11 = rc('vidia.openSettings', () => server.openSettings())
  const d12 = rc('vidia.refreshServerStatus', () => p.refreshStatus())
  const d13 = rc('vidia.changeNvidiaApiKey', () => server.changeNvidiaApiKey(p))
  const d14 = rc('vidia.refreshCatalog', () => server.refreshCatalog(p))

  // Prefetch the model catalog in the background (skipped when the cached
  // snapshot is less than 5 days old); never blocks activation.
  server.manager.ensureCatalogFresh()

  context.subscriptions.push(d0, d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14, dDecorations, ...harness)
}

export function deactivate() {
  console.info('VIDIA extension deactivated')
}
