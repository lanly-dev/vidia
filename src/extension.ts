// VIDIA extension: NVIDIA NIM model manager tree view + AI harness integration.
import * as vscode from 'vscode';
import { NvidiaClient } from './nvidiaClient';
import { ModelManager, SOURCE_LABELS, staticCatalog } from './modelManager';
import { ModelsTreeProvider } from './modelTreeview';
import { NimManager } from './nimManager';
import { VidiaLmProvider } from './lmcProvider';
import { registerChatParticipant } from './chatParticipant';
import { ManagedModel, ModelSource } from './types';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('VIDIA', { log: true });
	const nimLog = vscode.window.createOutputChannel('VIDIA · NIM');
	context.subscriptions.push(log, nimLog);

	// --- secrets ---
	const getSecret = (name: string) => () => context.secrets.get(name);
	const setSecret = (name: string, prompt: string, link: string) => async () => {
		const key = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true, placeHolder: 'nvapi-… key' });
		if (key) {
			await context.secrets.delete(name);
			await context.secrets.store(name, key.trim());
			vscode.window.showInformationMessage(`${prompt} stored securely. Get/refresh keys at ${link}`);
		}
	};
	const cloudKey = getSecret('vidia.nvapiKey');
	const ngcKey = getSecret('vidia.ngcApiKey');

	// --- services ---
	const client = new NvidiaClient(cloudKey, m => log.info(m));
	const manager = new ModelManager(context, async (source: ModelSource) =>
		source === 'nim' ? (await ngcKey()) ?? undefined : await cloudKey());
	const nim = new NimManager(ngcKey, m => nimLog.appendLine(m));
	const tree = new ModelsTreeProvider(manager, nim);
	const treeView = vscode.window.createTreeView('vidia.modelsExplorer', { treeDataProvider: tree, showCollapseAll: true });
	context.subscriptions.push(treeView, manager);

	// --- AI harness: language model provider + chat participant ---
	const provider = new VidiaLmProvider(manager, client, manager.onDidChange);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('vidia', provider));
	registerChatParticipant(context, 'vidia');

	// --- helpers ---
	const itemModel = (arg: unknown): ManagedModel | undefined => {
		const item = arg as vscode.TreeItem | undefined;
		if (!item) { return undefined; }
		const match = (item.contextValue ?? '').match(/^model:(\w+):(.+)$/);
		return match ? manager.get(`${match[1]}:${match[2]}`) : undefined;
	};

	// --- commands ---
	const commands = [
		vscode.commands.registerCommand('vidia.setNvidiaApiKey', setSecret('vidia.nvapiKey', 'Set NVIDIA API Key', 'https://build.nvidia.com/explore/discover')),
		vscode.commands.registerCommand('vidia.setNgcApiKey', setSecret('vidia.ngcApiKey', 'Set NGC API Key', 'https://org.ngc.nvidia.com/setup/api-keys')),
		vscode.commands.registerCommand('vidia.refreshModels', () => tree.refresh()),

		vscode.commands.registerCommand('vidia.addModel', async (sourceArg?: ModelSource) => {
			const source: ModelSource = sourceArg ?? (await vscode.window.showQuickPick(
				(['cloud', 'nim', 'local'] as ModelSource[]).map(s => ({ label: SOURCE_LABELS[s], source: s })),
				{ placeHolder: 'Where should this model run?' }))?.source ?? 'cloud';

			const catalog = await manager.getCatalog(await cloudKey(), staticCatalog);
			const groups = [...new Set(catalog.map(m => m.publisher))];
			const picked = await vscode.window.showQuickPick(groups.map(p => ({ label: `$(folder) ${p}`, publisher: p })),
				{ placeHolder: 'Choose the model publisher on build.nvidia.com' });
			if (!picked) { return; }
			const modelPick = await vscode.window.showQuickPick(
				catalog.filter(m => m.publisher === picked.publisher).map(m => ({ label: m.name, description: m.id, model: m })),
				{ placeHolder: `Choose a ${picked.publisher} model` });
			if (!modelPick) { return; }
			const m = modelPick.model;

			if (source === 'nim') {
				const image = await vscode.window.showInputBox({ prompt: 'NIM container image', value: `nvcr.io/nim/${m.id}:latest`, ignoreFocusOut: true });
				if (!image) { return; }
				const port = Number(await vscode.window.showInputBox({ prompt: 'Host port for the NIM server', value: '8000', ignoreFocusOut: true }) ?? 8000);
				manager.add({ modelId: m.id, name: m.name, publisher: m.publisher, source, contextLength: 131072, nimImage: image, nimPort: port });
				const startNow = await vscode.window.showInformationMessage(`Added ${m.id} as NIM. Start the container now?`, 'Yes', 'No');
				if (startNow === 'Yes') { await vscode.commands.executeCommand('vidia.nim.start', manager.get(`nim:${m.id}`)); }
			} else if (source === 'local') {
				const port = Number(await vscode.window.showInputBox({
					prompt: 'Port of your local OpenAI-compatible runtime (lemonade/ollama/NIM)', value: '8000', ignoreFocusOut: true,
				}) ?? 8000);
				manager.add({ modelId: m.id, name: m.name, publisher: m.publisher, source, contextLength: 32768, localPort: port });
			} else {
				manager.add({ modelId: m.id, name: m.name, publisher: m.publisher, source: 'cloud', contextLength: 131072 });
				vscode.window.showInformationMessage(`${m.id} added using the free NVIDIA endpoint. It is now available in the chat model picker.`);
			}
			tree.refresh();
		}),

		vscode.commands.registerCommand('vidia.removeModel', async (item?: vscode.TreeItem) => {
			const m = itemModel(item);
			if (!m) { return; }
			if (m.source === 'nim') { await nim.stop(m, true); }
			manager.remove(m.key);
			tree.refresh();
		}),

		vscode.commands.registerCommand('vidia.setChatModel', async (item?: vscode.TreeItem) => {
			const m = itemModel(item);
			const all = manager.all();
			const m2 = m ?? (await vscode.window.showQuickPick(all.map(x => ({ label: x.name, description: x.modelId, model: x })), { placeHolder: 'Select chat model' }))?.model;
			if (!m2) { return; }
			await vscode.workspace.getConfiguration('vidia').update('chatModel', m2.key, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`Chat model set to ${m2.modelId} (${SOURCE_LABELS[m2.source]}).`);
		}),

		vscode.commands.registerCommand('vidia.testModel', async (item?: vscode.TreeItem) => {
			const m = itemModel(item);
			if (!m) { return; }
			try {
				const target = await manager.resolveTarget(m);
				const answer = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: `Testing ${m.modelId}…` },
					() => client.testModel(target));
				log.info(`Test ${m.modelId}: ${answer}`);
				vscode.window.showInformationMessage(`${m.modelId} responded: ${answer.slice(0, 80) || '(empty)'}`);
			} catch (e) {
				vscode.window.showErrorMessage(`Test failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}),

		vscode.commands.registerCommand('vidia.nim.start', async (item?: vscode.TreeItem) => {
			const m = itemModel(item);
			if (!m) { return; }
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Starting NIM container for ${m.modelId}…`, cancellable: true },
				async (_p, token) => {
					try {
						await nim.run(m, token);
						vscode.window.showInformationMessage(`NIM server for ${m.modelId} is healthy at http://localhost:${m.nimPort ?? 8000}/v1.`);
					} catch (e) {
						vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
					}
				});
			tree.refresh();
		}),

		vscode.commands.registerCommand('vidia.nim.stop', async (item?: vscode.TreeItem) => {
			const m = itemModel(item);
			if (!m) { return; }
			await nim.stop(m);
			tree.refresh();
			vscode.window.showInformationMessage(`NIM container for ${m.modelId} stopped.`);
		}),

		vscode.commands.registerCommand('vidia.nim.logs', async (item?: vscode.TreeItem) => {
			const m = itemModel(item);
			if (m) { await nim.logs(m, nimLog); }
		}),

		vscode.commands.registerCommand('vidia.openBuildNvidia', () =>
			vscode.env.openExternal(vscode.Uri.parse('https://build.nvidia.com/models'))),
	];
	context.subscriptions.push(...commands);

	// Best-effort catalog preload so the first "Add model" is fast.
	(async () => {
		try { await manager.getCatalog(await cloudKey(), staticCatalog); } catch { /* offline is fine */ }
	})();
}

export function deactivate() {}

