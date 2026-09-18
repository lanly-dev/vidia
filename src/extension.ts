import { commands, ExtensionContext, TreeItem } from 'vscode'

import ModelsTreeProvider from './modelTreeview'
import {
  initServices,
  addModel,
  removeModel,
  pickChatModel,
  testModel,
  startNim,
  stopNim,
  showNimLogs,
  setNvidiaApiKey,
  setNgcApiKey,
  openBuildNvidia,
  registerChatHarness
} from './server'

export async function activate(context: ExtensionContext) {
  const rc = commands.registerCommand

  const services = initServices(context)
  const p = await ModelsTreeProvider.createOrGet(services.manager, services.nim)
  const harness = registerChatHarness(context, p)

  const d1 = rc('vidia.internal.addModel', (sourceArg?: string) => addModel(p, sourceArg))
  const d2 = rc('vidia.ncp.removeModelItem', (item?: TreeItem) => removeModel(p, item))
  const d3 = rc('vidia.ncp.setChatModelItem', (item?: TreeItem) => pickChatModel(p, item))
  const d4 = rc('vidia.ncp.testModelItem', (item?: TreeItem) => testModel(p, item))
  const d5 = rc('vidia.ncp.startNimItem', (item?: TreeItem) => startNim(p, item))
  const d6 = rc('vidia.ncp.stopNimItem', (item?: TreeItem) => stopNim(p, item))
  const d7 = rc('vidia.ncp.showNimLogsItem', (item?: TreeItem) => showNimLogs(p, item))

  const d8 = rc('vidia.setNvidiaApiKey', () => setNvidiaApiKey(p))
  const d9 = rc('vidia.setNgcApiKey', () => setNgcApiKey(p))
  const d10 = rc('vidia.openBuildNvidia', () => openBuildNvidia(p))
  const d11 = rc('vidia.refreshServerStatus', () => p.refreshStatus())

  context.subscriptions.push(d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, ...harness)
}

export function deactivate() {
  console.info('VIDIA extension deactivated')
}
