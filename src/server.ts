import { Disposable, ExtensionContext, OutputChannel, TreeItem, Uri, env, window } from 'vscode'

import { NvidiaClient } from './nvidiaClient'
import { ModelManager } from './modelManager'
import { NimManager } from './nimManager'
import { SecretManager } from './secretManager'
import { VidiaLmProvider } from './lmcProvider'
import { registerChatParticipant } from './chatParticipant'
import ModelsTreeProvider from './modelTreeview'

/**
 * Shared services created once at activation (audio-lab style: plain module
 * functions below receive the tree provider and use these shared services).
 */
interface Services {
  secrets: SecretManager
  client: NvidiaClient
  manager: ModelManager
  nim: NimManager
  nimLog: OutputChannel
}

let services: Services | undefined

export function initServices(context: ExtensionContext): Services {
  if (services) return services

  const log = window.createOutputChannel('VIDIA', { log: true })
  const nimLog = window.createOutputChannel('VIDIA · NIM')
  const secrets = new SecretManager(context)
  const client = new NvidiaClient(() => secrets.getNvidiaKey(), msg => log.info(msg))
  const manager = new ModelManager(context, source =>
    source === 'nim' ? secrets.getNgcKey() : secrets.getNvidiaKey())
  manager.setClient(client)
  const nim = new NimManager(
    () => secrets.getNgcKey(),
    item => manager.fromTreeItem(item),
    msg => nimLog.appendLine(msg)
  )

  services = { secrets, client, manager, nim, nimLog }
  context.subscriptions.push(log, nimLog, manager)
  return services
}

function s(): Services {
  if (!services) throw new Error('VIDIA services are not initialized.')
  return services
}

// --- model flows -----------------------------------------------------------

export async function addModel(p: ModelsTreeProvider, sourceArg?: string): Promise<void> {
  const { manager } = s()
  await manager.addModelFlow(sourceArg as never)
  p.refresh()
}

export async function removeModel(p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
  const { manager, nim } = s()
  await manager.removeModel(item, nim)
  p.refresh()
}

export async function pickChatModel(p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
  const { manager } = s()
  await manager.selectChatModel(item)
  p.refresh()
}

export async function testModel(p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
  const { manager } = s()
  await manager.testModel(item)
  p.refresh()
}

// --- NIM container flows ---------------------------------------------------

export async function startNim(p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
  const { nim } = s()
  await nim.startWithProgress(item)
  p.refresh()
}

export async function stopNim(p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
  const { nim } = s()
  await nim.stopWithFeedback(item)
  p.refresh()
}

export async function showNimLogs(p: ModelsTreeProvider, item?: TreeItem): Promise<void> {
  const { nim, nimLog } = s()
  await nim.showLogs(item, nimLog)
}

// --- settings / misc -------------------------------------------------------

export async function setNvidiaApiKey(p: ModelsTreeProvider): Promise<void> {
  await s().secrets.setNvidiaKey()
  p.refresh()
}

export async function setNgcApiKey(p: ModelsTreeProvider): Promise<void> {
  await s().secrets.setNgcKey()
  p.refresh()
}

export function openBuildNvidia(_p: ModelsTreeProvider): Thenable<unknown> {
  return env.openExternal(Uri.parse('https://build.nvidia.com/models'))
}

// --- AI harness ------------------------------------------------------------

/** Registers the language model provider and the @vidia chat participant. */
export function registerChatHarness(context: ExtensionContext, _p: ModelsTreeProvider): Disposable[] {
  const { client, manager } = s()
  const provider = new VidiaLmProvider(manager, client, manager.onDidChange)
  return [provider.register(), registerChatParticipant(context, 'vidia')]
}
