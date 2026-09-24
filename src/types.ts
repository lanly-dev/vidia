import type { ModelManager } from './modelManager'
import type { NimManager } from './nimManager'
import type { NvidiaClient } from './nvidiaClient'
import type { OutputChannel } from 'vscode'
import type { SecretManager } from './secretManager'
import type { VidiaItem } from './vidiaTreeItem'

export type ModelSource = 'cloud' | 'nim' | 'local'

/**
 * Shared services created once at activation (audio-lab style: plain module
 * functions below receive the tree provider and use these shared services).
 */
export interface Services {
	secrets: SecretManager
	client: NvidiaClient
	manager: ModelManager
	nim: NimManager
	nimLog: OutputChannel
}

/** Health state of a managed model, derived from probing the endpoint. */
export type ModelStatus = 'untested' | 'active' | 'disabled'

/** One probe record per managed model; overwritten on every test. */
export interface ModelProbe {
	testedAt: number
	/** Model's reply text on success, error message on failure. */
	reply: string
	status: ModelStatus
	httpStatus?: number
}

/** A model managed by the extension (added by the user into one of the three groups). */
export interface ManagedModel {
	/** Unique key: `${source}:${modelId}` */
	key: string
	/** NVIDIA model id, e.g. "openai/gpt-oss-20b" */
	modelId: string
	name: string
	publisher: string
	source: ModelSource
	/** Maximum input tokens advertised to the chat harness. */
	contextLength: number
	addedAt: number
	/** NIM container image, e.g. "nvcr.io/nim/openai/gpt-oss-20b:latest" */
	nimImage?: string
	/** Host port the NIM container is published on. */
	nimPort?: number
	/** Host port of the local runtime (lemonade/ollama/custom). */
	localPort?: number
}

/**
 * Argument a model command receives from the tree view (or programmatic callers).
 * The tree view hands over the VidiaItem itself, row clicks pass the model key,
 * and programmatic callers may pass a ManagedModel (or nothing at all).
 */
export type ModelArgument = VidiaItem | ManagedModel | string | undefined

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant'
	content: string
}

export interface CatalogModel {
	id: string
	publisher: string
	name: string
}

export interface CatalogCache {
	fetchedAt: number
	baseUrl: string
	models: CatalogModel[]
}

export interface ChatTarget {
	/** OpenAI-compatible base URL, e.g. https://integrate.api.nvidia.com/v1 */
	baseUrl: string
	apiKey?: string
	model: string
}

export interface StreamCallbacks {
	onDelta(text: string): void
}
