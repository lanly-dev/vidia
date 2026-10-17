import * as vscode from 'vscode'
import * as cp from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ManagedModel, ModelArgument, NimContainerState, SetupState } from './types'
import { refreshEvents } from './events'

export class NimManager implements vscode.Disposable {
  constructor(
    private readonly getNvidiaKey: () => string | undefined | Thenable<string | undefined>,
    private readonly resolveModel: (arg?: ModelArgument) => ManagedModel | undefined,
    private readonly log: (msg: string) => void,
    private readonly getSetupState: () => SetupState | undefined
  ) { }

  /** `docker logs -f` children spawned by showLogs(), keyed by container name. */
  private readonly logStreams = new Map<string, cp.ChildProcess>()

  /** Short-lived cache of container states so tree refreshes don't spam docker. */
  private readonly stateCache = new Map<string, { state: NimContainerState, at: number }>()
  /** How long a probed container state stays valid (ms). */
  private static readonly STATE_TTL_MS = 4_000

  /** User flow: start the container for the selected NIM model with progress UI. */
  async startWithProgress(arg?: ModelArgument): Promise<void> {
    const m = this.resolveModel(arg)
    if (!m) return
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting NIM container for ${m.modelId}…`,
        cancellable: true
      },
      async (_p, token) => {
        try {
          const url = await this.run(m, token)
          vscode.window.showInformationMessage(`NIM server for ${m.modelId} is healthy at ${url}`)
        } catch (e) {
          vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
        }
      })
    this.invalidateState(m)
    refreshEvents.fire()
  }

  /** User flow: stop the container for the selected NIM model. */
  async stopWithFeedback(arg?: ModelArgument): Promise<void> {
    const m = this.resolveModel(arg)
    if (!m) return
    await this.stop(m)
    this.invalidateState(m)
    refreshEvents.fire()
    vscode.window.showInformationMessage(`NIM container for ${m.modelId} stopped.`)
  }

  /** User flow: stream container logs into the NIM output channel. */
  async showLogs(arg?: ModelArgument, channel?: vscode.OutputChannel): Promise<void> {
    const m = this.resolveModel(arg)
    if (m && channel) await this.logs(m, channel)
  }

  get runtime(): string {
    return vscode.workspace.getConfiguration('vidia.nim').get<string>('containerRuntime', 'auto')
  }

  /** Cached Docker/GPU preflight used by the tree header and the add-NIM flow. */
  private envCache?: { ok: boolean, issues: string[], checkedAt: number }

  /**
   * Verifies that a container runtime (Docker/Podman) and an NVIDIA GPU are
   * present. Cached for a minute so tree renders stay snappy; pass `force`
   * after the user had a chance to install Docker/drivers.
   */
  async checkEnv(force = false): Promise<{ ok: boolean, issues: string[] }> {
    const TTL_MS = 60_000
    if (!force && this.envCache && Date.now() - this.envCache.checkedAt < TTL_MS) return this.envCache
    const issues: string[] = []
    const rt = await this.detectRuntime()
    if (!rt) {
      issues.push('Docker (or Podman) not found — install Docker Desktop: ' +
        'https://www.docker.com/products/docker-desktop/')
    } else if (!await this.daemonUp(rt)) {
      issues.push(`${rt === 'docker' ? 'Docker Desktop' : 'Podman'} is installed but its daemon ` +
        `isn't running — start it, then retry. (VIDIA: Refresh Status re-checks.)`)
    }
    if (!await this.hasNvidiaGpu())
      issues.push('No NVIDIA GPU detected — "nvidia-smi" is missing or failing; install/update the NVIDIA driver.')
    this.envCache = { ok: issues.length === 0, issues, checkedAt: Date.now() }
    return this.envCache
  }

  /** True when `nvidia-smi -L` runs and lists at least one GPU. */
  private hasNvidiaGpu(): Promise<boolean> {
    return new Promise(resolve => {
      cp.exec('nvidia-smi -L', { windowsHide: true }, (err, stdout) => resolve(!err && /GPU/i.test(stdout)))
    })
  }

  private async detectRuntime(): Promise<string | undefined> {
    const candidates = this.runtime === 'auto' ? ['docker', 'podman'] : [this.runtime]
    for (const cmd of candidates)
      if (await this.exists(cmd)) return cmd

    return undefined
  }

  private exists(cmd: string): Promise<boolean> {
    return new Promise(resolve => {
      cp.exec(`${cmd} --version`, { windowsHide: true }, err => resolve(!err))
    })
  }

  /**
   * True when the container daemon answers (`docker info`). Catches the
   * "binary installed, daemon not running" case (e.g. Docker Desktop not
   * started — the npipe/socket simply isn't there).
   */
  private daemonUp(rt: string): Promise<boolean> {
    return new Promise(resolve => {
      cp.exec(`${rt} info`, { windowsHide: true, timeout: 10_000 }, err => resolve(!err))
    })
  }

  async assertPrerequisites(): Promise<string> {
    const rt = await this.detectRuntime()
    if (!rt) {
      throw new Error(
        'Docker (or Podman) was not found. Install Docker Desktop to run NIM containers:' +
        ' https://www.docker.com/products/docker-desktop/')
    }
    if (!await this.daemonUp(rt)) {
      const product = rt === 'docker' ? 'Docker Desktop' : 'Podman'
      throw new Error(
        `${product} is installed but its daemon isn't running — start ${product}, then try again.`)
    }

    const key = await this.getNvidiaKey()
    if (!key) throw new Error('No NVIDIA API key configured. Get one at https://build.nvidia.com/.')

    return rt
  }

  containerName(model: ManagedModel): string {
    return `vidia-nim-${model.modelId.replace(/[^\w.-]+/g, '-')}`.slice(0, 60)
  }

  /** Resolved container runtime for one-off commands (falls back to docker). */
  private async runtimeCmd(): Promise<string> {
    return (await this.detectRuntime()) ?? 'docker'
  }

  async isRunning(model: ManagedModel): Promise<boolean> {
    const rt = await this.runtimeCmd()
    return new Promise(resolve => {
      cp.exec(`${rt} ps --filter "name=^/${this.containerName(model)}$" --format "{{.ID}}"`,
        { windowsHide: true }, (err, stdout) => resolve(!err && stdout.trim().length > 0))
    })
  }

  /**
   * Resolves the lifecycle state of a model's NIM container, so the UI can show
   * something more honest than a boolean "running":
   *
   *   not-pulled → the image has never been downloaded (first start is slow).
   *   stopped    → image present, container not running (fast start).
   *   starting   → container `docker ps`-running but the HTTP server isn't up yet.
   *   ready      → server answers on the published port (chat will work).
   *   exited     → container exists but has exited (crash / manual stop).
   *
   * Cached briefly (STATE_TTL_MS) so periodic tree refreshes don't spawn a
   * `docker ps` per row per keystroke. A running container is confirmed with a
   * single short-timeout ping to `127.0.0.1` (never `localhost` — see the
   * IPv6 note in waitForHealthy).
   */
  async getContainerState(model: ManagedModel): Promise<NimContainerState | undefined> {
    // Remote NIM host: there is no local container to inspect.
    if (vscode.workspace.getConfiguration('vidia.nim').get<string>('remoteHost', '')) return undefined

    const cached = this.stateCache.get(model.key)
    if (cached && Date.now() - cached.at < NimManager.STATE_TTL_MS) return cached.state

    const rt = await this.runtimeCmd()
    const name = this.containerName(model)
    const status = await this.containerStatus(rt, name)
    // No container → distinguish "never downloaded" from "downloaded, ready to start";
    // running → ready vs starting based on the health ping; otherwise exited.
    let state: NimContainerState
    if (status === undefined) state = await this.imageExists(rt, model) ? 'stopped' : 'not-pulled'
    else if (status === 'running') state = await this.pingServer(model) ? 'ready' : 'starting'
    else state = 'exited'
    this.stateCache.set(model.key, { state, at: Date.now() })
    return state
  }

  /** True when the container is up and its server is answering (chat-safe). */
  async isReady(model: ManagedModel): Promise<boolean> {
    return (await this.getContainerState(model)) === 'ready'
  }

  /** Drops the cached state so the next read reflects an explicit action. */
  invalidateState(model?: ManagedModel): void {
    if (model) this.stateCache.delete(model.key)
    else this.stateCache.clear()
  }

  /** Short-timeout ping of the container's /v1/models; true if the port answers. */
  private async pingServer(model: ManagedModel): Promise<boolean> {
    const port = model.nimPort ?? vscode.workspace.getConfiguration('vidia.nim').get<number>('defaultPort', 8000)
    const key = (await this.getNvidiaKey()) ?? ''
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 2_000)
    try {
      await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: ctl.signal
      })
      return true // any HTTP response (even 401/404) proves the server is up
    } catch { return false } // connection refused / timed out → not serving yet
    finally { clearTimeout(timer) }
  }

  /** `docker ps -a` status line → 'running' | 'exited' | undefined (no container). */
  private containerStatus(rt: string, name: string): Promise<string | undefined> {
    return new Promise(resolve => {
      cp.exec(`${rt} ps -a --filter "name=^/${name}$" --format "{{.Status}}"`,
        { windowsHide: true, timeout: 8_000 }, (err, stdout) => {
          if (err) return resolve(undefined)
          const s = stdout.trim()
          resolve(s ? (s.startsWith('Up') ? 'running' : 'exited') : undefined)
        })
    })
  }

  /** True when the model's image is already pulled locally. */
  private imageExists(rt: string, model: ManagedModel): Promise<boolean> {
    const image = model.nimImage ?? `nvcr.io/nim/${model.modelId}:latest`
    return new Promise(resolve => {
      cp.exec(`${rt} image inspect "${image}"`, { windowsHide: true, timeout: 15_000 },
        err => resolve(!err))
    })
  }

  /**
   * Chat hook: ensures a NIM model's container is ready before a request is
   * sent, honoring `vidia.nim.autoStartOnChat`:
   *   prompt (default) → ask, then start (with progress) if confirmed.
   *   always           → start without asking.
   *   never            → just report that the model isn't ready.
   * Resolves true when the model is safe to chat with; false when the user
   * declined or the start failed (an error message has already been shown).
   */
  async ensureReadyForChat(model: ManagedModel): Promise<boolean> {
    if (await this.isReady(model)) return true
    const state = await this.getContainerState(model)
    const mode = vscode.workspace.getConfiguration('vidia.nim').get<string>('autoStartOnChat', 'prompt')
    const label = state === 'not-pulled' ? 'Its image has not been downloaded yet.'
      : state === 'starting' ? 'It is still starting up.'
        : state === 'exited' ? 'The container has exited.'
          : 'The container is not running.'

    if (mode === 'never') {
      vscode.window.showWarningMessage(
        `${model.modelId} is not ready. ${label} Start it from the Models Explorer, then retry.`)
      return false
    }
    if (mode === 'prompt') {
      const choice = await vscode.window.showInformationMessage(
        `${model.modelId} is not ready. ${label} Start the NIM container now?`,
        'Start Now', 'Cancel')
      if (choice !== 'Start Now') return false
    }
    await this.startWithProgress(model)
    // startWithProgress swallows errors; re-check the real state before chatting.
    if (await this.isReady(model)) return true
    vscode.window.showErrorMessage(
      `${model.modelId} is still not ready after starting. Check "VIDIA: Show NIM Logs".`)
    return false
  }

  /** Runs the NIM container for a model; resolves with the server URL once healthy. */
  async run(model: ManagedModel, token?: vscode.CancellationToken): Promise<string> {
    const remoteHost = vscode.workspace.getConfiguration('vidia.nim').get<string>('remoteHost', '')
    // Without NGC pull access the docker pull is doomed — fail fast with guidance.
    if (!remoteHost && this.getSetupState()?.ngcOk === false) {
      throw new Error(
        'This NVIDIA API key is not NGC-enabled, so NIM images cannot be pulled from nvcr.io. ' +
        'Use a key from an NGC-linked account, or run VIDIA: Verify NIM Setup after fixing the key.')
    }
    const rt = await this.assertPrerequisites()
    await this.stop(model, true)
    const port = model.nimPort ?? vscode.workspace.getConfiguration('vidia.nim').get<number>('defaultPort', 8000)
    const name = this.containerName(model)
    const key = (await this.getNvidiaKey()) ?? ''
    if (remoteHost) {
      this.log(`Using remote NIM host ${remoteHost} for ${model.modelId}; skipping local container launch.`)
      return `http://${remoteHost.replace(/\/+$/, '')}/v1`
    }
    const image = model.nimImage ?? `nvcr.io/nim/${model.modelId}:latest`
    // Pulling needs registry auth: log in to nvcr.io with the stored key.
    // The key travels via stdin so it never appears in the process list.
    await this.registryLogin(rt, key)
    // Pass secrets via an env file (0600, deleted afterwards) instead of
    // `-e KEY=…` on the command line, where `ps` and the output log expose them.
    const envFile = path.join(os.tmpdir(), `${name}.env`)
    await fs.promises.writeFile(envFile, `NGC_API_KEY=${key}\nNVIDIA_API_KEY=${key}\n`, { mode: 0o600 })
    try {
      const args = [
        'run', '-d', '--rm', '--name', name,
        '--gpus', 'all',
        '-p', `${port}:8000`,
        '--env-file', envFile,
        image
      ]
      this.log(`[NIM] ${rt} ${args.join(' ')}`)
      // Generous timeout: the first pull of a NIM image can take a long while.
      await this.exec(`${rt} ${args.map(a => `"${a}"`).join(' ')}`, 30 * 60_000)
    } finally {
      await fs.promises.rm(envFile, { force: true })
    }
    await this.waitForHealthy(port, token)
    return `http://127.0.0.1:${port}/v1`
  }

  /**
   * Authenticates the container runtime against nvcr.io with the stored
   * NVIDIA key. Aborts the run with a clear message when the login itself
   * fails, instead of letting `docker pull` die cryptically.
   */
  private async registryLogin(rt: string, key: string): Promise<void> {
    // The $oauthtoken username must reach the shell literally: wrapped in
    // double quotes under cmd.exe, in single quotes on POSIX.
    const q = process.platform === 'win32' ? String.fromCharCode(34) : String.fromCharCode(39)
    const user = `${q}$oauthtoken${q}`
    this.log('[NIM] logging in to nvcr.io as $oauthtoken…')
    await new Promise<void>((resolve, reject) => {
      const child = cp.exec(`${rt} login nvcr.io -u ${user} --password-stdin`,
        { windowsHide: true, timeout: 30_000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`nvcr.io login failed (${stderr?.trim() || err.message}). ` +
              'Check that the key has NGC pull access (VIDIA: Verify NIM Setup).'))
            return
          }
          resolve()
        })
      child.stdin?.write(key)
      child.stdin?.end()
    })
  }

  /**
   * Polls the NIM server until it answers (weights load can take minutes).
   *
   * A container can be `docker ps`-running long before its HTTP server binds the
   * published port, so this loops on the endpoint. Two traps make the naive probe
   * spin forever even when the container is up, so we guard against both:
   *
   * 1. `localhost` can resolve to IPv6 `::1` first, while `docker run -p` publishes
   *    only on IPv4 `0.0.0.0` — the connect is refused and the loop never exits.
   *    Probe `127.0.0.1` directly to skip the ambiguity.
   * 2. NIMs started with an API key enforce bearer auth, so an unauthenticated
   *    `/v1/models` answers 401 forever. Send the stored key.
   *
   * Any HTTP response (even a non-2xx) proves the port is serving, so we stop
   * polling; only connection failures keep us waiting.
   */
  private async waitForHealthy(port: number, token?: vscode.CancellationToken, timeoutMs = 20 * 60_000): Promise<void> {
    const started = Date.now()
    const key = (await this.getNvidiaKey()) ?? ''
    while (Date.now() - started < timeoutMs) {
      if (token?.isCancellationRequested) throw new Error('Cancelled.')
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {}
        })
        if (!res.ok) this.log(`[NIM] health probe on port ${port} answered ${res.status}; server is up.`)
        return
      } catch { /* not bound yet — keep polling */ }
      await new Promise(r => setTimeout(r, 3_000))
    }
    throw new Error(
      `NIM server on port ${port} did not become healthy within ${Math.round(timeoutMs / 60000)} minutes.` +
      ' Check container logs (VIDIA: Show NIM Logs).')
  }

  async stop(model: ManagedModel, quiet = false): Promise<void> {
    const rt = await this.runtimeCmd()
    const name = this.containerName(model)
    await new Promise<void>(resolve => {
      cp.exec(`${rt} rm -f "${name}"`, { windowsHide: true }, err => {
        if (err && !quiet) this.log(`[NIM] stop ${name}: ${err.message}`)
        resolve()
      })
    })
  }

  /**
   * Streams `docker logs -f` for a container into the channel. Any previous
   * stream for the same container is killed first so repeated invocations
   * don't stack up orphaned processes.
   */
  async logs(model: ManagedModel, channel: vscode.OutputChannel): Promise<void> {
    const rt = await this.runtimeCmd()
    const name = this.containerName(model)
    const prev = this.logStreams.get(name)
    if (prev && !prev.killed) prev.kill()
    const child = cp.spawn(rt, ['logs', '-f', name], { windowsHide: true })
    this.logStreams.set(name, child)
    child.on('exit', () => {
      if (this.logStreams.get(name) === child) this.logStreams.delete(name)
    })
    child.stdout?.on('data', d => channel.append(d.toString()))
    child.stderr?.on('data', d => channel.append(d.toString()))
    vscode.window.showInformationMessage(`Streaming logs of ${name} to the "VIDIA" output channel.`)
  }

  /** Kills any live `docker logs -f` streams (runs on extension deactivation). */
  dispose(): void {
    for (const child of this.logStreams.values())
      if (!child.killed) child.kill()
    this.logStreams.clear()
  }

  private exec(cmd: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.exec(cmd, { windowsHide: true, timeout }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message}${stderr ? `\n${stderr}` : ''}`)); else resolve(stdout)
      })
    })
  }
}
