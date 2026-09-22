import { commands, ExtensionContext, TreeItem, window, Disposable } from 'vscode'

import ModelsTreeProvider from './modelTreeview'
import { ModelDecorationProvider } from './modelDecorations'
import { Server } from './server'

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
  const d2 = rc('vidia.ncp.removeModelItem', (item?: TreeItem) => server.removeModel(p, item))
  const d3 = rc('vidia.ncp.setChatModelItem', (item?: TreeItem) => server.pickChatModel(p, item))
  const d4 = rc('vidia.ncp.testModelItem', (item?: TreeItem) => server.testModel(p, item))
  const d5 = rc('vidia.ncp.startNimItem', (item?: TreeItem) => server.startNim(p, item))
  const d6 = rc('vidia.ncp.stopNimItem', (item?: TreeItem) => server.stopNim(p, item))
  const d7 = rc('vidia.ncp.showNimLogsItem', (item?: TreeItem) => server.showNimLogs(p, item))

  const d8 = rc('vidia.setNvidiaApiKey', () => server.setNvidiaApiKey(p))
  const d9 = rc('vidia.setNgcApiKey', () => server.setNgcApiKey(p))
  const d10 = rc('vidia.openBuildNvidia', () => server.openBuildNvidia(p))
  const d11 = rc('vidia.openSettings', () => server.openSettings())
  const d12 = rc('vidia.refreshServerStatus', () => p.refreshStatus())
  const d13 = rc('vidia.changeNvidiaApiKey', () => server.changeNvidiaApiKey(p))

  context.subscriptions.push(d0, d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, dDecorations, ...harness)
}

export function deactivate() {
  console.info('VIDIA extension deactivated')
}
