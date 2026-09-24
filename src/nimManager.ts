import * as vscode from 'vscode'
import * as cp from 'child_process'
import type { ManagedModel, ModelArgument } from './types'
import { refreshEvents } from './events'

export class NimManager {
  constructor(
    private readonly getNgcKey: () => string | undefined | Thenable<string | undefined>,
    private readonly resolveModel: (arg?: ModelArgument) => ManagedModel | undefined,
    private readonly log: (msg: string) => void
  ) { }

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
          await this.run(m, token)
          const url = `http://localhost:${m.nimPort}/v1`
          vscode.window.showInformationMessage(`NIM server for ${m.modelId} is healthy at ${url}`)
        } catch (e) {
          vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
        }
      })
    refreshEvents.fire()
  }

  /** User flow: stop the container for the selected NIM model. */
  async stopWithFeedback(arg?: ModelArgument): Promise<void> {
    const m = this.resolveModel(arg)
    if (!m) return
    await this.stop(m)
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
    if (!await this.detectRuntime()) {
      issues.push('Docker (or Podman) not found — install Docker Desktop: ' +
        'https://www.docker.com/products/docker-desktop/')
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

  async assertPrerequisites(): Promise<string> {
    const rt = await this.detectRuntime()
    if (!rt) {
      throw new Error(
        'Docker (or Podman) was not found. Install Docker Desktop to run NIM containers:' +
        ' https://www.docker.com/products/docker-desktop/')
    }

    const key = await this.getNgcKey()
    if (!key) throw new Error('No NGC API key configured. Get one at https://org.ngc.nvidia.com/".')

    return rt
  }

  containerName(model: ManagedModel): string {
    return `vidia-nim-${model.modelId.replace(/[^\w.-]+/g, '-')}`.slice(0, 60)
  }

  isRunning(model: ManagedModel): Promise<boolean> {
    return new Promise(resolve => {
      cp.exec(`docker ps --filter "name=^/${this.containerName(model)}$" --format "{{.ID}}"`,
        { windowsHide: true }, (err, stdout) => resolve(!err && stdout.trim().length > 0))
    })
  }

  /** Runs the NIM container for a model and resolves once the server is healthy. */
  async run(model: ManagedModel, token?: vscode.CancellationToken): Promise<void> {
    const rt = await this.assertPrerequisites()
    await this.stop(model, true)
    const port = model.nimPort ?? vscode.workspace.getConfiguration('vidia.nim').get<number>('defaultPort', 8000)
    const name = this.containerName(model)
    const key = (await this.getNgcKey()) ?? ''
    const remoteHost = vscode.workspace.getConfiguration('vidia.nim').get<string>('remoteHost', '')
    if (remoteHost) {
      this.log(`Using remote NIM host ${remoteHost} for ${model.modelId}; skipping local container launch.`)
      return
    }
    const args = [
      'run', '-d', '--rm', '--name', name,
      '--gpus', 'all',
      '-p', `${port}:8000`,
      '-e', `NGC_API_KEY=${key}`,
      '-e', `NVIDIA_API_KEY=${key}`,
      model.nimImage ?? `nvcr.io/nim/${model.modelId}:latest`
    ]
    this.log(`[NIM] ${rt} ${args.join(' ')}`)
    await this.exec(`${rt} ${args.map(a => `"${a}"`).join(' ')}`, 60_000)
    await this.waitForHealthy(port, token)
  }

  /** Polls /v1/models until the NIM server answers (weights load can take minutes). */
  async waitForHealthy(port: number, token?: vscode.CancellationToken, timeoutMs = 20 * 60_000): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (token?.isCancellationRequested) throw new Error('Cancelled.')
      try {
        const res = await fetch(`http://localhost:${port}/v1/models`)
        if (res.ok) return
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 3_000))
    }
    throw new Error(
      `NIM server on port ${port} did not become healthy within ${Math.round(timeoutMs / 60000)} minutes.` +
      ' Check container logs (VIDIA: Show NIM Logs).')
  }

  async stop(model: ManagedModel, quiet = false): Promise<void> {
    const name = this.containerName(model)
    await new Promise<void>(resolve => {
      cp.exec(`docker rm -f "${name}"`, { windowsHide: true }, err => {
        if (err && !quiet) this.log(`[NIM] stop ${name}: ${err.message}`)
        resolve()
      })
    })
  }

  async logs(model: ManagedModel, channel: vscode.OutputChannel): Promise<void> {
    const name = this.containerName(model)
    const child = cp.spawn('docker', ['logs', '-f', name], { windowsHide: true })
    child.stdout?.on('data', d => channel.append(d.toString()))
    child.stderr?.on('data', d => channel.append(d.toString()))
    vscode.window.showInformationMessage(`Streaming logs of ${name} to the "VIDIA" output channel.`)
  }

  private exec(cmd: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.exec(cmd, { windowsHide: true, timeout }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message}${stderr ? `\n${stderr}` : ''}`)); else resolve(stdout)
      })
    })
  }
}
