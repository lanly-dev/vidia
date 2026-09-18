export type ModelSource = 'cloud' | 'nim' | 'local';

/** A model managed by the extension (added by the user into one of the three groups). */
export interface ManagedModel {
	/** Unique key: `${source}:${modelId}` */
	key: string;
	/** NVIDIA model id, e.g. "meta/llama-3.1-8b-instruct" */
	modelId: string;
	name: string;
	publisher: string;
	source: ModelSource;
	/** Maximum input tokens advertised to the chat harness. */
	contextLength: number;
	addedAt: number;
	/** NIM container image, e.g. "nvcr.io/nim/meta/llama-3.1-8b-instruct:latest" */
	nimImage?: string;
	/** Host port the NIM container is published on. */
	nimPort?: number;
	/** Host port of the local runtime (lemonade/ollama/custom). */
	localPort?: number;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface CatalogModel {
	id: string;
	publisher: string;
	name: string;
}

export interface ChatTarget {
	/** OpenAI-compatible base URL, e.g. https://integrate.api.nvidia.com/v1 */
	baseUrl: string;
	apiKey?: string;
	model: string;
}

export interface StreamCallbacks {
	onDelta(text: string): void;
}
