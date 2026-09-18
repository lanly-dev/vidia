import * as vscode from 'vscode'

import { NvidiaClient } from './nvidiaClient'
import { registerChatParticipant } from './chatParticipant'
import { ModelManager } from './modelManager'
import { ModelsTreeProvider } from './modelTreeview'
import { NimManager } from './nimManager'
import { VidiaLmProvider } from './lmcProvider'
import { SecretManager } from './secretManager'

import { refreshEvents } from './events'

export async function activate(context: vscode.ExtensionContext) {
  const rc = vscode.commands.registerCommand

  // Initialize managers
  const log = vscode.window.createOutputChannel('VIDIA', { log: true })
  const secrets = new SecretManager(context)
  const client = new NvidiaClient(() => secrets.getNvidiaKey(), msg => log.info(msg))
  const nimLog = vscode.window.createOutputChannel('VIDIA · NIM')
  const manager = new ModelManager(context, source =>
    source === 'nim' ? secrets.getNgcKey() : secrets.getNvidiaKey())
  manager.setClient(client)
  const nim = new NimManager(
    () => secrets.getNgcKey(),
    item => manager.fromTreeItem(item),
    msg => nimLog.appendLine(msg)
  )
  const treeProvider = await createTreeView(manager, nim)

  // Expose NVIDIA NIM models in the native VS Code model picker (like Ollama).
  const lmcProvider = new VidiaLmProvider(manager, client, manager.onDidChange)
  const chatParticipant = registerChatParticipant(context, 'vidia')

  const d1 = rc('vidia.setNvidiaApiKey', () => secrets.setNvidiaKey())
  const d2 = rc('vidia.setNgcApiKey', () => secrets.setNgcKey())
  const d3 = rc('vidia.refreshModels', () => refreshEvents.fire())
  const d4 = rc('vidia.addModel', (arg?: string) => manager.addModelFlow(arg as never))
  const d5 = rc('vidia.removeModel', (item?: vscode.TreeItem) => manager.removeModel(item, nim))
  const d6 = rc('vidia.setChatModel', (item?: vscode.TreeItem) => manager.selectChatModel(item))
  const d7 = rc('vidia.testModel', (item?: vscode.TreeItem) => manager.testModel(item))
  const d8 = rc('vidia.nim.start', (item?: vscode.TreeItem) => nim.startWithProgress(item))
  const d9 = rc('vidia.nim.stop', (item?: vscode.TreeItem) => nim.stopWithFeedback(item))
  const d10 = rc('vidia.nim.logs', (item?: vscode.TreeItem) => nim.showLogs(item, nimLog))
  const d11 = rc('vidia.openBuildNvidia', () =>
    vscode.env.openExternal(vscode.Uri.parse('https://build.nvidia.com/models')))

  const d12 = lmcProvider.register()
  const d13 = listenConfigsChange(treeProvider)

  context.subscriptions.push(d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, chatParticipant, nimLog, manager)
}

function listenConfigsChange(treeProvider: ModelsTreeProvider) {
  return vscode.workspace.onDidChangeConfiguration(e => {
    const settings = [
      'vidia.baseUrl', 'vidia.nim.containerRuntime', 'vidia.nim.defaultPort',
      'vidia.nim.remoteHost', 'vidia.localRuntime.port'
    ]

    if (settings.some(setting => e.affectsConfiguration(setting)))
      refreshEvents.fire()

  })
}

// Register tree view for VIDIA model management
async function createTreeView(manager: ModelManager, nim: NimManager) {
  const provider = new ModelsTreeProvider(manager, nim)
  const view = vscode.window.createTreeView('vidia.modelsExplorer', {
    treeDataProvider: provider,
    showCollapseAll: true
  })
  refreshEvents.fire()
  return provider
}
