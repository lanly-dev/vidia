import * as vscode from 'vscode'
import { CatalogModel, ChatTarget, ManagedModel, ModelSource } from './types'
import { DEFAULT_BASE_URL } from './nvidiaClient'

const STORAGE_KEY = 'vidia.managedModels'

export const SOURCE_LABELS: Record<ModelSource, string> = {
  cloud: 'Cloud · Free Endpoint',
  nim: 'NIM · Self-Hosted',
  local: 'Local · Runtime'
}

export class ModelManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  private models: ManagedModel[] = []

  constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly getApiKey: (source: ModelSource) => string | undefined | Promise<string | undefined>
  ) {
    this.models = context.globalState.get<ManagedModel[]>(STORAGE_KEY, [])
  }

  private persist(): void {
    this.context.globalState.update(STORAGE_KEY, this.models)
    this._onDidChange.fire()
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
      const res = await fetch(`${vscode.workspace.getConfiguration('vidia').get<string>('baseUrl', DEFAULT_BASE_URL)}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } : { Accept: 'application/json' }
      })
      if (!res.ok)  return fallback()
      const json = JSON.parse(await res.text()) as { data?: Array<{ id?: string }> }
      const models = (json.data ?? [])
        .filter(m => typeof m.id === 'string')
        .map(m => {
          const id = m.id as string
          const slash = id.indexOf('/')
          return { id, publisher: slash > 0 ? id.slice(0, slash) : 'nvidia', name: slash > 0 ? id.slice(slash + 1) : id }
        })
        .sort((a, b) => a.publisher.localeCompare(b.publisher) || a.name.localeCompare(b.name))
      return models.length > 0 ? models : fallback()
    } catch {
      return fallback()
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
