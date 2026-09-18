import * as vscode from 'vscode';
import { ChatMessage, ManagedModel } from './types';
import { ModelManager } from './modelManager';
import { NvidiaClient } from './nvidiaClient';

export class VidiaLmProvider implements vscode.LanguageModelChatProvider {
	readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;

	constructor(
		private readonly manager: ModelManager,
		private readonly client: NvidiaClient,
		changeSignal: vscode.Event<void>
	) {
		this.onDidChangeLanguageModelChatInformation = changeSignal;
	}

	async provideLanguageModelChatInformation(_options: { silent: boolean }, _token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		return this.manager.all().map(m => this.toInfo(m));
	}

	private toInfo(m: ManagedModel): vscode.LanguageModelChatInformation {
		const detail = m.source === 'cloud' ? 'NVIDIA free endpoint'
			: m.source === 'nim' ? 'Self-hosted NIM container' : 'Local runtime';
		return {
			id: m.key,
			name: `${m.publisher}/${m.name}`,
			family: m.publisher,
			version: '1',
			maxInputTokens: m.contextLength,
			maxOutputTokens: 4096,
			capabilities: { toolCalling: false, imageInput: false },
			tooltip: `${m.modelId} — ${detail}`,
			detail,
		};
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		_options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const managed = this.manager.get(model.id);
		if (!managed) { throw new Error(`Model "${model.id}" is no longer managed by VIDIA. Re-add it in the Models Explorer.`); }
		const target = await this.manager.resolveTarget(managed);
		const chatMessages: ChatMessage[] = messages.map(msg => {
			const roleNum = msg.role as unknown as number;
			const role: ChatMessage['role'] = roleNum === 2 ? 'assistant' : roleNum === 3 ? 'system' : 'user';
			return {
				role,
				content: msg.content
					.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '')
					.join(''),
			};
		}).filter(m => m.content.length > 0 || m.role === 'system');

		const controller = new AbortController();
		const listener = token.onCancellationRequested(() => controller.abort());
		try {
			await this.client.chatStream(target, chatMessages, {
				onDelta: t => progress.report(new vscode.LanguageModelTextPart(t)),
			}, controller.signal);
		} finally {
			listener.dispose();
		}
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const value = typeof text === 'string'
			? text
			: text.content.map(p => p instanceof vscode.LanguageModelTextPart ? p.value : '').join('');
		return Math.ceil(value.length / 4);
	}
}
