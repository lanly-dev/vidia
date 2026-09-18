import * as vscode from 'vscode';
import * as cp from 'child_process';
import { ManagedModel } from './types';

export class NimManager {
	constructor(
		private readonly getNgcKey: () => string | undefined | Thenable<string | undefined>,
		private readonly log: (msg: string) => void
	) { }

	get runtime(): string {
		return vscode.workspace.getConfiguration('vidia.nim').get<string>('containerRuntime', 'auto');
	}

	private async detectRuntime(): Promise<string | undefined> {
		const candidates = this.runtime === 'auto' ? ['docker', 'podman'] : [this.runtime];
		for (const cmd of candidates) {
			if (await this.exists(cmd)) { return cmd; }
		}
		return undefined;
	}

	private exists(cmd: string): Promise<boolean> {
		return new Promise(resolve => {
			cp.exec(`${cmd} --version`, { windowsHide: true }, err => resolve(!err));
		});
	}

	async assertPrerequisites(): Promise<string> {
		const rt = await this.detectRuntime();
		if (!rt) {
			throw new Error('Docker (or Podman) was not found. Install Docker Desktop to run NIM containers: https://www.docker.com/products/docker-desktop/');
		}
		const key = await this.getNgcKey();
		if (!key) {
			throw new Error('No NGC API key configured. Get one at https://org.ngc.nvidia.com/ then run "VIDIA: Set NGC API Key".');
		}
		return rt;
	}

	containerName(model: ManagedModel): string {
		return `vidia-nim-${model.modelId.replace(/[^\w.-]+/g, '-')}`.slice(0, 60);
	}

	isRunning(model: ManagedModel): Promise<boolean> {
		return new Promise(resolve => {
			cp.exec(`docker ps --filter "name=^/${this.containerName(model)}$" --format "{{.ID}}"`,
				{ windowsHide: true }, (err, stdout) => resolve(!err && stdout.trim().length > 0));
		});
	}

	/** Runs the NIM container for a model and resolves once the server is healthy. */
	async run(model: ManagedModel, token?: vscode.CancellationToken): Promise<void> {
		const rt = await this.assertPrerequisites();
		await this.stop(model, true);
		const port = model.nimPort ?? vscode.workspace.getConfiguration('vidia.nim').get<number>('defaultPort', 8000);
		const name = this.containerName(model);
		const key = (await this.getNgcKey()) ?? '';
		const remoteHost = vscode.workspace.getConfiguration('vidia.nim').get<string>('remoteHost', '');
		if (remoteHost) {
			this.log(`Using remote NIM host ${remoteHost} for ${model.modelId}; skipping local container launch.`);
			return;
		}
		const args = [
			'run', '-d', '--rm', '--name', name,
			'--gpus', 'all',
			'-p', `${port}:8000`,
			'-e', `NGC_API_KEY=${key}`,
			'-e', `NVIDIA_API_KEY=${key}`,
			model.nimImage ?? `nvcr.io/nim/${model.modelId}:latest`,
		];
		this.log(`[NIM] ${rt} ${args.join(' ')}`);
		await this.exec(`${rt} ${args.map(a => `"${a}"`).join(' ')}`, 60_000);
		await this.waitForHealthy(port, token);
	}

	/** Polls /v1/models until the NIM server answers (weights load can take minutes). */
	async waitForHealthy(port: number, token?: vscode.CancellationToken, timeoutMs = 20 * 60_000): Promise<void> {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			if (token?.isCancellationRequested) { throw new Error('Cancelled.'); }
			try {
				const res = await fetch(`http://localhost:${port}/v1/models`);
				if (res.ok) { return; }
			} catch { /* not up yet */ }
			await new Promise(r => setTimeout(r, 3_000));
		}
		throw new Error(`NIM server on port ${port} did not become healthy within ${Math.round(timeoutMs / 60000)} minutes. Check container logs (VIDIA: Show NIM Logs).`);
	}

	async stop(model: ManagedModel, quiet = false): Promise<void> {
		const name = this.containerName(model);
		await new Promise<void>(resolve => {
			cp.exec(`docker rm -f "${name}"`, { windowsHide: true }, err => {
				if (err && !quiet) { this.log(`[NIM] stop ${name}: ${err.message}`); }
				resolve();
			});
		});
	}

	async logs(model: ManagedModel, channel: vscode.OutputChannel): Promise<void> {
		const name = this.containerName(model);
		const child = cp.spawn('docker', ['logs', '-f', name], { windowsHide: true });
		child.stdout?.on('data', d => channel.append(d.toString()));
		child.stderr?.on('data', d => channel.append(d.toString()));
		vscode.window.showInformationMessage(`Streaming logs of ${name} to the "VIDIA" output channel.`);
	}

	private exec(cmd: string, timeout: number): Promise<string> {
		return new Promise((resolve, reject) => {
			cp.exec(cmd, { windowsHide: true, timeout }, (err, stdout, stderr) => {
				if (err) { reject(new Error(`${err.message}${stderr ? `\n${stderr}` : ''}`)); } else { resolve(stdout); }
			});
		});
	}
}
