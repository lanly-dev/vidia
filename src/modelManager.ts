import * as vscode from 'vscode'
import type {
  CatalogCache, CatalogModel, ChatTarget, ManagedModel, ModelArgument, ModelProbe, ModelSource
} from './types'
import type { NimManager } from './nimManager'

import { DEFAULT_BASE_URL, NvidiaApiError, NvidiaClient } from './nvidiaClient'
import { refreshEvents } from './events'
import { VidiaItem, SOURCE_LABELS } from './vidiaTreeItem'

const STORAGE_KEY = 'vidia.managedModels'
const CATALOG_KEY = 'vidia.modelCatalog'
const PROBE_KEY = 'vidia.modelProbes'
/** Catalog is re-fetched when the cached snapshot is older than this. */
const CATALOG_TTL_MS = 5 * 24 * 60 * 60 * 1000

/** Re-exported for existing import sites (modelTreeview, lmcProvider, …). */
export { SOURCE_LABELS }

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
    if (existing) Object.assign(existing, model)
    else this.models.push(model)

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

  /** Reads the per-model probe log (keyed by managed-model key), if any. */
  getProbes(): Record<string, ModelProbe> {
    return this.context.globalState.get<Record<string, ModelProbe>>(PROBE_KEY, {})
  }

  /** Returns the latest probe for a model key, if the user ever tested it. */
  getProbe(key: string): ModelProbe | undefined {
    return this.getProbes()[key]
  }

  /** Overwrites the probe record for a model key and refreshes the tree. */
  private saveProbe(key: string, probe: ModelProbe): void {
    const all = this.getProbes()
    all[key] = probe
    void this.context.globalState.update(PROBE_KEY, all)
    this._onDidChange.fire()
    refreshEvents.fire()
  }

  /** Reads the cached model catalog (endpoint snapshot + timestamp), if any. */
  getCatalogCache(): CatalogCache | undefined {
    return this.context.globalState.get<CatalogCache>(CATALOG_KEY)
  }

  /** Fetches the live model catalog from `<baseUrl>/models` (no cache read). */
  async fetchCatalog(apiKey?: string): Promise<CatalogModel[]> {
    const baseUrl = vscode.workspace.getConfiguration('vidia').get<string>('baseUrl', DEFAULT_BASE_URL)
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
        : { Accept: 'application/json' }
    })
    if (!res.ok) throw new Error(`Catalog request failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
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
    if (models.length === 0) throw new Error('Catalog request returned no models.')
    return models
  }

  /** Fetches the live catalog and persists it to globalState with a timestamp. */
  async refreshCatalog(apiKey?: string): Promise<CatalogCache> {
    const baseUrl = vscode.workspace.getConfiguration('vidia').get<string>('baseUrl', DEFAULT_BASE_URL)
    const models = await this.fetchCatalog(apiKey ?? await this.getApiKey('cloud'))
    const cache: CatalogCache = { fetchedAt: Date.now(), baseUrl, models }
    await this.context.globalState.update(CATALOG_KEY, cache)
    return cache
  }

  /**
   * Returns the model catalog from the globalState cache. Fetches live only
   * when the snapshot is missing/stale (older than 5 days) or `forceRefresh`
   * is set (VIDIA: Refresh Model Catalog). Activate-time prefetch goes
   * through here too — Add Model never triggers a network fetch by itself.
   */
  async getCatalog(apiKey?: string, opts: { forceRefresh?: boolean } = {}): Promise<CatalogModel[]> {
    const cached = this.getCatalogCache()
    const stale = !cached || Date.now() - cached.fetchedAt > CATALOG_TTL_MS
    if ((opts.forceRefresh || stale)) {
      try {
        return (await this.refreshCatalog(apiKey)).models
      } catch {
        if (cached) return cached.models
        throw new Error('VIDIA: could not reach the model endpoint and no cached catalog exists.')
      }
    }
    return cached?.models ?? []
  }

  /**
   * Fire-and-forget prefetch for extension activation: refreshes the catalog
   * in the background when the snapshot is missing or older than 5 days.
   */
  ensureCatalogFresh(): void {
    void this.getCatalog(undefined, {}).catch(() => undefined)
  }

  /**
   * User flow: pick a source (cloud/NIM/local), then publisher and model from
   * the NVIDIA catalog, and add it to the managed list.
   */
  async addModelFlow(sourceArg?: ModelSource): Promise<ManagedModel | undefined> {
    const source: ModelSource = sourceArg ?? (await vscode.window.showQuickPick(
      (['cloud', 'nim', 'local'] as ModelSource[]).map(s => ({ label: SOURCE_LABELS[s], source: s })),
      { placeHolder: 'Where should this model run?' }))?.source ?? 'cloud'

    let catalog: CatalogModel[]
    try {
      catalog = await this.getCatalog(await this.getApiKey('cloud'))
    } catch {
      catalog = []
    }
    if (catalog.length === 0) {
      await this.promptEmptyCatalog()
      return undefined
    }
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
        await vscode.commands.executeCommand('vidia.ncp.startNimItem', added)
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

  /** Shown when the catalog is empty/unavailable; shared by the add flows. */
  private async promptEmptyCatalog(): Promise<void> {
    const retry = await vscode.window.showErrorMessage(
      'VIDIA: could not reach the model endpoint and no cached catalog exists.',
      'Refresh Catalog', 'Open build.nvidia.com')
    if (retry === 'Refresh Catalog') await this.refreshCatalogFlow()
    else if (retry === 'Open build.nvidia.com')
      void vscode.env.openExternal(vscode.Uri.parse('https://build.nvidia.com/models'))
  }

  /**
   * Inline "+" on the NIM group header: verifies Docker + NVIDIA GPU first
   * (the header shows a warning icon while either is missing), then offers
   * the cloud catalog as a pick-list of NIM containers to download
   * (`nvcr.io/nim/<id>:latest`) and optionally start right away.
   */
  async addNimFlow(nim?: NimManager): Promise<void> {
    // 1. Preflight — forced so a fresh Docker/driver install is picked up now.
    const env = await nim?.checkEnv(true)
    refreshEvents.fire()
    if (env && !env.ok) {
      const choice = await vscode.window.showErrorMessage(
        `Cannot run NIM containers yet: ${env.issues.join('  |  ')}`,
        'Install Docker', 'Install NVIDIA Driver')
      if (choice === 'Install Docker')
        void vscode.env.openExternal(vscode.Uri.parse('https://www.docker.com/products/docker-desktop/'))
      else if (choice === 'Install NVIDIA Driver')
        void vscode.env.openExternal(vscode.Uri.parse('https://www.nvidia.com/Download/index.aspx'))
      return
    }

    // 2. Catalog → pick-list (catalog ids map 1:1 to NIM image paths).
    let catalog: CatalogModel[] = []
    try {
      catalog = await this.getCatalog(await this.getApiKey('cloud'))
    } catch {
      catalog = []
    }
    if (catalog.length === 0) {
      await this.promptEmptyCatalog()
      return
    }

    interface NimPick extends vscode.QuickPickItem {
      custom?: boolean
      model?: CatalogModel
    }
    const pick = await vscode.window.showQuickPick<NimPick>(
      [
        ...catalog.map(c => ({
          label: c.name,
          description: c.id,
          model: c
        })),
        { kind: vscode.QuickPickItemKind.Separator, label: '' },
        { label: 'Custom container image…', description: 'type any NIM image (nvcr.io/nim/…)', custom: true }
      ],
      {
        title: 'Add NIM Model',
        placeHolder: 'Pick a model to download & run as a NIM container',
        matchOnDescription: true
      })
    if (!pick) return

    let modelId: string
    let image: string
    let name: string
    let publisher: string
    if (pick.custom) {
      const input = await vscode.window.showInputBox({
        prompt: 'NIM container image to run',
        placeHolder: 'nvcr.io/nim/<publisher>/<model>:latest',
        ignoreFocusOut: true
      })
      if (!input?.trim()) return
      image = input.trim()
      // Model id served by NIM = image path after "nvcr.io/nim/" without the tag.
      modelId = image.replace(/^.*nvcr\.io\/nim\//, '').replace(/:[^:/]+$/, '') || image
      name = modelId.split('/').pop() ?? modelId
      publisher = modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : 'custom'
    } else if (pick.model) {
      modelId = pick.model.id
      image = `nvcr.io/nim/${modelId}:latest`
      name = pick.model.name
      publisher = pick.model.publisher
    } else
      return

    // 3. Persist, then offer to pull + run the container immediately.
    const added = this.add({ source: 'nim', modelId, name, publisher, contextLength: 131072, nimImage: image })
    const start = await vscode.window.showInformationMessage(
      `Added ${modelId}. Start its NIM container now? Docker will download ${image} on first run.`,
      'Start Now', 'Later')
    if (start === 'Start Now' && nim) await nim.startWithProgress(added)
  }

  /** Resolves the managed model behind a tree command argument. */
  resolveModel(arg?: ModelArgument): ManagedModel | undefined {
    if (typeof arg === 'string') return this.get(arg)
    if (!arg || typeof arg !== 'object') return undefined
    if (arg instanceof VidiaItem)
      return arg.kind === 'model' && arg.model ? this.get(arg.model.key) ?? arg.model : undefined
    return 'key' in arg ? this.get(arg.key) : undefined
  }

  /** Removes a model from the managed list (stops its NIM container if any). */
  async removeModel(arg?: ModelArgument, nim?: NimManager): Promise<void> {
    const m = this.resolveModel(arg)
    if (!m || !this.get(m.key)) {
      vscode.window.showWarningMessage('VIDIA: could not resolve the model to remove. Refresh the view and try again.')
      return
    }
    if (m.source === 'nim' && nim) await nim.stop(m, true)
    this.remove(m.key)
    vscode.window.showInformationMessage(`Removed ${m.modelId}.`)
  }

  /** Sets the active chat model, optionally preselected from a tree argument. */
  async selectChatModel(arg?: ModelArgument): Promise<void> {
    const m = this.resolveModel(arg)
    const all = this.all()
    const picked = m ?? (await vscode.window.showQuickPick(
      all.map(x => ({ label: x.name, description: x.modelId, model: x })),
      { placeHolder: 'Select chat model' }))?.model
    if (!picked) return
    await vscode.workspace.getConfiguration('vidia').update('chatModel', picked.key, vscode.ConfigurationTarget.Global)
    vscode.window.showInformationMessage(`Chat model set to ${picked.modelId} (${SOURCE_LABELS[picked.source]}).`)
  }

  /**
   * Probes the model with "Which model are you?", overwrites its probe log
   * (timestamp + reply) in globalState, and marks 404s disabled. Newly added
   * models have no probe (untested) until the user runs this — via the
   * inline test button or the context menu.
   */
  async testModel(arg?: ModelArgument): Promise<void> {
    const m = this.resolveModel(arg)
    if (!m) return
    if (!this.client) throw new Error('VIDIA client is not initialized yet.')
    try {
      const target = await this.resolveTarget(m)
      const { reply, httpStatus } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Testing ${m.modelId}…` },
        () => this.client!.probeModel(target))
      this.saveProbe(m.key, { testedAt: Date.now(), reply, status: 'active', httpStatus })
      vscode.window.showInformationMessage(`${m.modelId} responded: ${reply.slice(0, 120) || '(empty)'}`)
    } catch (e) {
      const status = e instanceof NvidiaApiError ? e.status : undefined
      const msg = e instanceof Error ? e.message : String(e)
      // 404 = endpoint has no deployment for this id → mark disabled in tree.
      this.saveProbe(m.key, {
        testedAt: Date.now(), reply: msg, status: status === 404 ? 'disabled' : 'untested', httpStatus: status
      })
      vscode.window.showErrorMessage(`Test failed: ${msg}`)
    }
  }

  /** Command flow: force-fetch the catalog, persist it, and report the result. */
  async refreshCatalogFlow(): Promise<void> {
    try {
      const cache = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Refreshing model catalog…' },
        () => this.refreshCatalog())
      vscode.window.showInformationMessage(
        `Model catalog updated — ${cache.models.length} model(s), ${new Date(cache.fetchedAt).toLocaleString()}.`)
    } catch (e) {
      const cached = this.getCatalogCache()
      const when = cached ? new Date(cached.fetchedAt).toLocaleString() : ''
      const count = cached ? ` (${cached.models.length} models)` : ''
      vscode.window.showErrorMessage(
        `Catalog refresh failed: ${e instanceof Error ? e.message : String(e)}` +
        (cached ? ` Using cached snapshot from ${when}${count}.` : ''))
    }
  }

  dispose(): void {
    this._onDidChange.dispose()
  }
}
