import * as vscode from 'vscode'
import { CatalogModel, ChatTarget, ManagedModel, ModelSource } from './types'
import { DEFAULT_BASE_URL, NvidiaClient } from './nvidiaClient'
import { refreshEvents } from './events'
import type { NimManager } from './nimManager'

const STORAGE_KEY = 'vidia.managedModels'

export const SOURCE_LABELS: Record<ModelSource, string> = {
  cloud: 'Cloud · Free Endpoint',
  local: 'Local · Runtime',
  nim: 'NIM · Self-Hosted'
}

export class ModelManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  private models: ManagedModel[] = []
  private client?: NvidiaClient

  constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly getApiKey: (source: ModelSource) => string | undefined | Thenable<string | undefined>
  ) {
    this.models = context.globalState.get<ManagedModel[]>(STORAGE_KEY, [])
  }

  /** Injects the NVIDIA client (avoids a constructor cycle with the tree/provider wiring). */
  setClient(client: NvidiaClient): void { this.client = client }

  private persist(): void {
    this.context.globalState.update(STORAGE_KEY, this.models)
    this._onDidChange.fire()
    refreshEvents.fire()
  }

  all(): ManagedModel[] { return [...this.models] }

  get(key: string): ManagedModel | undefined { return this.models.find(m => m.key === key) }

  add(partial: Omit<ManagedModel, 'key' | 'addedAt'>): ManagedModel {
    const model: ManagedModel = { ...partial, key: `${partial.source}:${partial.modelId}`, addedAt: Date.now() }
    const existing = this.get(model.key)
    if (existing)
      Object.assign(existing, model)
		 else
      this.models.push(model)

    this.persist()
    return model
  }

  remove(key: string): void {
    this.models = this.models.filter(m => m.key !== key)
    this.persist()
  }

  /** Resolves the OpenAI-compatible endpoint for a managed model. */
  async resolveTarget(model: ManagedModel): Promise<ChatTarget> {
    const cfg = vscode.workspace.getConfiguration('vidia')
    const nimCfg = vscode.workspace.getConfiguration('vidia.nim')
    if (model.source === 'cloud') {
      return {
        baseUrl: cfg.get<string>('baseUrl', DEFAULT_BASE_URL),
        apiKey: await this.getApiKey('cloud'),
        model: model.modelId
      }
    }
    if (model.source === 'nim') {
      const remoteHost = nimCfg.get<string>('remoteHost', '')
      const port = model.nimPort ?? nimCfg.get<number>('defaultPort', 8000)
      const base = remoteHost ? `http://${remoteHost.replace(/\/+$/, '')}/v1` : `http://localhost:${port}/v1`
      return { baseUrl: base, apiKey: await this.getApiKey('nim'), model: model.modelId }
    }
    const port = model.localPort ?? cfg.get<number>('localRuntime.port', 8000)
    return { baseUrl: `http://localhost:${port}/v1`, model: model.modelId }
  }

  /** Fetches the NVIDIA catalog, falls back to a small built-in list on failure. */
  async getCatalog(apiKey?: string, fallback: () => CatalogModel[] = staticCatalog): Promise<CatalogModel[]> {
    try {
      const baseUrl = vscode.workspace.getConfiguration('vidia').get<string>('baseUrl', DEFAULT_BASE_URL)
      const res = await fetch(`${baseUrl}/models`, {
        headers: apiKey
          ? { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
          : { Accept: 'application/json' }
      })
      if (!res.ok)  return fallback()
      const json = JSON.parse(await res.text()) as { data?: Array<{ id?: string }> }
      const models = (json.data ?? [])
        .filter(m => typeof m.id === 'string')
        .map(m => {
          const id = m.id as string
          const slash = id.indexOf('/')
          return {
            id,
            publisher: slash > 0 ? id.slice(0, slash) : 'nvidia',
            name: slash > 0 ? id.slice(slash + 1) : id
          }
        })
        .sort((a, b) => a.publisher.localeCompare(b.publisher) || a.name.localeCompare(b.name))
      return models.length > 0 ? models : fallback()
    } catch {
      return fallback()
    }
  }

  /**
   * User flow: pick a source (cloud/NIM/local), then publisher and model from
   * the NVIDIA catalog, and add it to the managed list.
   */
  async addModelFlow(sourceArg?: ModelSource): Promise<ManagedModel | undefined> {
    const source: ModelSource = sourceArg ?? (await vscode.window.showQuickPick(
      (['cloud', 'nim', 'local'] as ModelSource[]).map(s => ({ label: SOURCE_LABELS[s], source: s })),
      { placeHolder: 'Where should this model run?' }))?.source ?? 'cloud'

    const catalog = await this.getCatalog(await this.getApiKey('cloud'))
    const groups = [...new Set(catalog.map(m => m.publisher))]
    const picked = await vscode.window.showQuickPick(groups.map(p => ({ label: `$(folder) ${p}`, publisher: p })),
      { placeHolder: 'Choose the model publisher on build.nvidia.com' })
    if (!picked) return undefined

    const modelPick = await vscode.window.showQuickPick(
      catalog
        .filter(m => m.publisher === picked.publisher)
        .map(m => ({ label: m.name, description: m.id, model: m })),
      { placeHolder: `Choose a ${picked.publisher} model` })
    if (!modelPick) return undefined
    const m = modelPick.model

    let added: ManagedModel
    if (source === 'nim') {
      const image = await vscode.window.showInputBox({
        prompt: 'NIM container image',
        value: `nvcr.io/nim/${m.id}:latest`,
        ignoreFocusOut: true
      })
      if (!image) return undefined
      const portRaw = await vscode.window.showInputBox({
        prompt: 'Host port for the NIM server', value: '8000', ignoreFocusOut: true
      })
      const port = Number(portRaw ?? 8000)
      added = this.add({
        modelId: m.id, name: m.name, publisher: m.publisher,
        source, contextLength: 131072, nimImage: image, nimPort: port
      })
      const startNow = await vscode.window.showInformationMessage(
        `Added ${m.id} as NIM. Start the container now?`, 'Yes', 'No')
      if (startNow === 'Yes')
        await vscode.commands.executeCommand('vidia.nim.start', { contextValue: `model:nim:${m.id}` })
    } else if (source === 'local') {
      const portRaw = await vscode.window.showInputBox({
        prompt: 'Port of your local OpenAI-compatible runtime (lemonade/ollama/NIM)',
        value: '8000',
        ignoreFocusOut: true
      })
      const port = Number(portRaw ?? 8000)
      added = this.add({
        modelId: m.id, name: m.name, publisher: m.publisher,
        source, contextLength: 32768, localPort: port
      })
    } else {
      added = this.add({
        modelId: m.id, name: m.name, publisher: m.publisher,
        source: 'cloud', contextLength: 131072
      })
      vscode.window.showInformationMessage(
        `${m.id} added using the free NVIDIA endpoint. It is now available in the chat model picker.`)
    }
    return added
  }

  /** Resolves the model from a tree item context value. */
  fromTreeItem(item?: vscode.TreeItem): ManagedModel | undefined {
    const match = (item?.contextValue ?? '').match(/^model:(\w+):(.+)$/)
    return match ? this.get(`${match[1]}:${match[2]}`) : undefined
  }

  /** Removes a model from the managed list (stops its NIM container if any). */
  async removeModel(item?: vscode.TreeItem, nim?: NimManager): Promise<void> {
    const m = this.fromTreeItem(item)
    if (!m) return
    if (m.source === 'nim' && nim) await nim.stop(m, true)
    this.remove(m.key)
    vscode.window.showInformationMessage(`Removed ${m.modelId}.`)
  }

  /** Sets the active chat model, optionally preselected from a tree item. */
  async selectChatModel(item?: vscode.TreeItem): Promise<void> {
    const m = this.fromTreeItem(item)
    const all = this.all()
    const picked = m ?? (await vscode.window.showQuickPick(
      all.map(x => ({ label: x.name, description: x.modelId, model: x })),
      { placeHolder: 'Select chat model' }))?.model
    if (!picked) return
    await vscode.workspace.getConfiguration('vidia').update('chatModel', picked.key, vscode.ConfigurationTarget.Global)
    vscode.window.showInformationMessage(`Chat model set to ${picked.modelId} (${SOURCE_LABELS[picked.source]}).`)
  }

  /** Sends a tiny completion to verify the model endpoint works. */
  async testModel(item?: vscode.TreeItem): Promise<void> {
    const m = this.fromTreeItem(item)
    if (!m) return
    if (!this.client) throw new Error('VIDIA client is not initialized yet.')
    try {
      const target = await this.resolveTarget(m)
      const answer = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Testing ${m.modelId}…` },
        () => this.client!.testModel(target))
      vscode.window.showInformationMessage(`${m.modelId} responded: ${answer.slice(0, 80) || '(empty)'}`)
    } catch (e) {
      vscode.window.showErrorMessage(`Test failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  dispose(): void { this._onDidChange.dispose() }
}

export function staticCatalog(): CatalogModel[] {
  const ids = [
    'meta/llama-3.1-8b-instruct', 'meta/llama-3.1-70b-instruct', 'meta/llama-3.3-70b-instruct',
    'nvidia/nemotron-nano-9b-v2', 'nvidia/llama-3.3-nemotron-super-49b-v1',
    'qwen/qwen2.5-coder-32b-instruct', 'deepseek-ai/deepseek-r1', 'microsoft/phi-4-mini-instruct',
    'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'mistralai/mistral-nemotron', 'moonshotai/kimi-k2-instruct'
  ]
  return ids.map(id => {
    const slash = id.indexOf('/')
    return { id, publisher: id.slice(0, slash), name: id.slice(slash + 1) }
  })
}
