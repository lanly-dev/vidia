import * as vscode from 'vscode'
import type {
  CatalogCache, CatalogModel, ChatTarget, ManagedModel, ModelArgument, ModelProbe, ModelSource,
  NimCatalogCache, SetupState
} from './types'
import type { NimManager } from './nimManager'

import { DEFAULT_BASE_URL, NvidiaClient } from './nvidiaClient'
import { NvidiaApiError } from './nvidiaErrors'
import { fetchNimCatalog, type NimContainer } from './nimCatalog'
import { probeFeCatalogModels, VERDICT_TTL_MS, type CatalogVerdicts } from './catalogVerifier'
import { refreshEvents } from './events'
import { VidiaItem, SOURCE_LABELS } from './vidiaTreeItem'

const STORAGE_KEY = 'vidia.managedModels'
const CATALOG_KEY = 'vidia.modelCatalog'
const NIM_CATALOG_KEY = 'vidia.nimCatalog'
const VERDICTS_KEY = 'vidia.catalogVerdicts'
const PROBE_KEY = 'vidia.modelProbes'
/** Catalog is re-fetched when the cached snapshot is older than this. */
const CATALOG_TTL_MS = 5 * 24 * 60 * 60 * 1000

export class ModelManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  private models: ManagedModel[] = []
  private client?: NvidiaClient

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getApiKey: (source: ModelSource) => string | undefined | Thenable<string | undefined>,
    private readonly getSetupState: () => SetupState | undefined
  ) {
    const stored = context.globalState.get<ManagedModel[]>(STORAGE_KEY, [])
    // Persisted state can predate the removal of the `local` runtime source;
    // drop stranded entries so they never surface in the chat picker.
    this.models = stored.filter(m => (m.source as string) !== 'local')
    if (this.models.length !== stored.length)
      void context.globalState.update(STORAGE_KEY, this.models)
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
    // Only `cloud` and `nim` remain; anything else left with the local runtime source.
    throw new Error(`Cannot resolve model "${model.modelId}": unsupported source "${model.source}"`)
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
   * is passed. Activate-time prefetch goes through here too — Add Model never
   * triggers a network fetch by itself.
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

  /** Reads the cached NIM container catalog (NGC snapshot + timestamp), if any. */
  getNimCatalogCache(): NimCatalogCache | undefined {
    return this.context.globalState.get<NimCatalogCache>(NIM_CATALOG_KEY)
  }

  /**
   * Returns the NIM container catalog from the globalState cache. Fetches live
   * from the public NGC catalog search only when the snapshot is missing/stale
   * (older than 5 days) or `forceRefresh` is set. Falls back to the cached
   * snapshot when the network fetch fails.
   */
  async getNimCatalog(opts: { forceRefresh?: boolean } = {}): Promise<NimContainer[]> {
    const cached = this.getNimCatalogCache()
    const stale = !cached || Date.now() - cached.fetchedAt > CATALOG_TTL_MS
    if (opts.forceRefresh || stale) {
      try {
        const containers = await fetchNimCatalog()
        const cache: NimCatalogCache = { fetchedAt: Date.now(), containers }
        await this.context.globalState.update(NIM_CATALOG_KEY, cache)
        return containers
      } catch {
        if (cached) return cached.containers
        throw new Error('VIDIA: could not reach the NGC catalog and no cached NIM list exists.')
      }
    }
    return cached?.containers ?? []
  }

  /** Reads the stored per-model liveness verdicts, if any. */
  getCatalogVerdicts(): CatalogVerdicts {
    return this.context.globalState.get<CatalogVerdicts>(VERDICTS_KEY) ?? {}
  }

  /** True when a fresh "dead" verdict hides the model from the Add Model list. */
  private isVerdictDead(id: string, verdicts: CatalogVerdicts): boolean {
    const v = verdicts[id]
    return !!v && !v.ok && Date.now() - v.checkedAt < VERDICT_TTL_MS
  }

  /**
   * VIDIA: Probe FE Catalog — probes every FE catalog model with a tiny
   * request and caches per-model liveness verdicts (5 days). The Add Free Endpoint
   * pick-list hides models with a fresh "dead" verdict. Paced at ~30 RPM so
   * the free-tier ceiling is never the thing that breaks; 401/403 aborts the
   * run, consecutive 429s stop it early, and cancelling keeps partial results.
   */
  async probeFeCatalogFlow(): Promise<void> {
    const key = await this.getApiKey('cloud')
    if (!key) {
      const set = await vscode.window.showWarningMessage(
        'VIDIA: set your NVIDIA API key first.', 'Set API Key')
      if (set === 'Set API Key')
        await vscode.commands.executeCommand('vidia.setNvidiaApiKey')
      return
    }
    let catalog: CatalogModel[]
    try {
      catalog = await this.getCatalog(key)
    } catch {
      catalog = []
    }
    if (catalog.length === 0) {
      await this.promptEmptyCatalog()
      return
    }
    const baseUrl = vscode.workspace.getConfiguration('vidia')
      .get<string>('baseUrl', DEFAULT_BASE_URL)

    const ctrl = new AbortController()
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Probing FE catalog (tiny probe per model)…',
      cancellable: true
    }, async (progress, token) => {
      const sub = token.onCancellationRequested(() => ctrl.abort())
      try {
        return await probeFeCatalogModels(baseUrl, key, catalog.map(m => m.id), {
          signal: ctrl.signal,
          verdicts: this.getCatalogVerdicts(),
          onProgress: (done, total, dead) =>
            progress.report({ message: `${done}/${total} probed, ${dead} dead` })
        })
      } finally {
        sub.dispose()
      }
    })

    // Persist even on cancel/rate-limit: partial verdicts are still useful.
    await this.context.globalState.update(VERDICTS_KEY, result.verdicts)

    if (result.abortedForAuth) {
      await vscode.window.showErrorMessage(
        'VIDIA: catalog probing stopped — the API key was rejected (401/403).')
      return
    }
    const parts = [`${result.ok} live`, `${result.dead} dead`]
    if (result.unknown > 0) parts.push(`${result.unknown} unknown`)
    let msg = `VIDIA: catalog probing done — ${parts.join(', ')}.`
    if (result.rateLimited) msg += ' Stopped early: rate limited. Re-run later to finish.'
    else if (result.cancelled) msg += ' Cancelled; partial results kept.'
    vscode.window.showInformationMessage(msg)
  }

  /**
   * True when the stored key is NGC-enabled (NIM images can be pulled).
   * Shows guidance and returns false otherwise — callers bail out.
   */
  private async checkNgcGate(): Promise<boolean> {
    if (this.getSetupState()?.ngcOk !== false) return true
    const choice = await vscode.window.showErrorMessage(
      'This NVIDIA API key is not NGC-enabled, so NIM images cannot be pulled from nvcr.io.',
      'Verify NIM Setup', 'Get an NGC API Key')
    if (choice === 'Verify NIM Setup') await vscode.commands.executeCommand('vidia.recheckNimSetup')
    else if (choice === 'Get an NGC API Key')
      void vscode.env.openExternal(vscode.Uri.parse('https://build.nvidia.com/explore/discover'))
    return false
  }

  /**
   * User flow: pick a cloud model from the NVIDIA chat catalog and add it
   * to the managed list. (NIM containers have their own `addNimFlow`.)
   */
  async addFepFlow(): Promise<ManagedModel | undefined> {
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
    // Hide catalog models with a fresh "dead" liveness verdict (retired or
    // not entitled for this key). If every model is dead, fall back to the
    // full list rather than stranding the user with an empty picker.
    const verdicts = this.getCatalogVerdicts()
    const fullCatalog = catalog
    const live = catalog.filter(m => !this.isVerdictDead(m.id, verdicts))
    if (fullCatalog.length > live.length && live.length === 0) {
      vscode.window.showWarningMessage(
        'VIDIA: every catalog model has a "dead" liveness verdict — showing all of them. ' +
        'Run "VIDIA: Probe FE Catalog" to re-check.')
    } else
      catalog = live

    const groups = [...new Set(catalog.map(m => m.publisher))]
    const picked = await vscode.window.showQuickPick(groups.map(p => ({ label: `$(folder) ${p}`, publisher: p })),
      { placeHolder: 'Choose the model publisher on build.nvidia.com' })
    if (!picked) return undefined

    const modelPick = await vscode.window.showQuickPick(
      catalog
        .filter(m => m.publisher === picked.publisher)
        .map(m => ({ label: m.name, description: m.id, model: m })),
      {
        // `groups` comes from the live list, so this publisher always has a
        // live model; count how many of its siblings were hidden as dead.
        placeHolder: (() => {
          const totalHere = fullCatalog.filter(m => m.publisher === picked.publisher).length
          const liveHere = catalog.filter(m => m.publisher === picked.publisher).length
          const hiddenHere = totalHere - liveHere
          return hiddenHere > 0
            ? `Choose a ${picked.publisher} model (${hiddenHere} unavailable hidden)`
            : `Choose a ${picked.publisher} model`
        })()
      })
    if (!modelPick) return undefined
    const m = modelPick.model

    const added: ManagedModel = this.add({
      modelId: m.id, name: m.name, publisher: m.publisher,
      source: 'cloud', contextLength: 131072
    })
    vscode.window.showInformationMessage(
      `${m.id} added using the free NVIDIA endpoint. It is now available in the chat model picker.`)
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

  /** Normalized result of picking a NIM container (catalog entry or custom image). */
  private async pickNimContainer(): Promise<
    { modelId: string, image: string, name: string, publisher: string } | undefined> {
    let catalog: NimContainer[] = []
    try {
      catalog = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading NIM catalog…' },
        () => this.getNimCatalog())
    } catch {
      catalog = []
    }
    if (catalog.length === 0) {
      const retry = await vscode.window.showErrorMessage(
        'VIDIA: could not reach the NGC catalog and no cached NIM list exists.',
        'Retry', 'Use Custom Image…')
      if (retry === 'Use Custom Image…') return this.pickCustomNimImage()
      if (retry === 'Retry') return this.pickNimContainer()
      return undefined
    }

    interface NimPick extends vscode.QuickPickItem {
      custom?: boolean
      container?: NimContainer
    }
    const pick = await vscode.window.showQuickPick<NimPick>(
      [
        ...catalog.map(c => ({
          label: c.displayName,
          description: `${c.image}:${c.tag}`,
          detail: c.description.slice(0, 120),
          container: c
        })),
        { kind: vscode.QuickPickItemKind.Separator, label: '' },
        { label: 'Custom container image…', description: 'type any NIM image (nvcr.io/nim/…)', custom: true }
      ],
      {
        title: 'Add NIM Model',
        placeHolder: 'Pick a NIM container to download & run',
        matchOnDescription: true
      })
    if (!pick) return undefined
    if (pick.custom) return this.pickCustomNimImage()
    if (pick.container) {
      const c = pick.container
      return { modelId: c.modelId, image: `${c.image}:${c.tag}`, name: c.displayName, publisher: c.publisher }
    }
    return undefined
  }

  /** Manual NIM image entry; derives the served model id from the image path. */
  private async pickCustomNimImage(): Promise<
    { modelId: string, image: string, name: string, publisher: string } | undefined> {
    const input = await vscode.window.showInputBox({
      prompt: 'NIM container image to run',
      placeHolder: 'nvcr.io/nim/<publisher>/<model>:<tag>',
      ignoreFocusOut: true
    })
    if (!input?.trim()) return undefined
    const image = input.trim()
    // Model id served by NIM = image path after "nvcr.io/nim/" without the tag.
    const modelId = image.replace(/^.*nvcr\.io\/nim\//, '').replace(/:[^:/]+$/, '') || image
    return {
      modelId,
      image,
      name: modelId.split('/').pop() ?? modelId,
      publisher: modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : 'custom'
    }
  }

  /**
   * Inline "+" on the NIM group header: verifies Docker + NVIDIA GPU first
   * (the header shows a warning icon while either is missing), then offers
   * the NGC NIM catalog as a pick-list of containers that actually exist
   * and optionally starts the container right away.
   */
  async addNimFlow(nim?: NimManager): Promise<void> {
    // 0. NGC gate — without pull access the container can never start.
    if (!await this.checkNgcGate()) return
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

    // 2. NGC NIM catalog → pick-list of containers that actually exist.
    const picked = await this.pickNimContainer()
    if (!picked) return

    // 3. Persist, then offer to pull + run the container immediately.
    const added = this.add({
      source: 'nim', modelId: picked.modelId, name: picked.name,
      publisher: picked.publisher, contextLength: 131072, nimImage: picked.image
    })
    const start = await vscode.window.showInformationMessage(
      `Added ${picked.modelId}. Start its NIM container now? Docker will download ${picked.image} on first run.`,
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
