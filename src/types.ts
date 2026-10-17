import type { NimContainer } from './nimCatalog'
import type { VidiaItem } from './vidiaTreeItem'

export type ModelSource = 'cloud' | 'nim'

/** Health state of a managed model, derived from probing the endpoint. */
export type ModelStatus = 'untested' | 'active' | 'disabled'

/**
 * Lifecycle of the local NIM container backing a managed model. This is a
 * separate axis from {@link ModelStatus}: a model can be *valid* (probed OK)
 * while its container is still pulling or loading weights. `undefined` in
 * place of this type means "unknown / not applicable" (e.g. a remote NIM host
 * that the extension cannot inspect locally).
 */
export type NimContainerState = 'not-pulled' | 'stopped' | 'starting' | 'ready' | 'exited'

/** Human-readable label for each container state (shown in the tree row). */
export const NIM_STATE_LABELS: Record<NimContainerState, string> = {
  'not-pulled': 'Not downloaded',
  stopped: 'Stopped',
  starting: 'Starting…',
  ready: 'Ready',
  exited: 'Exited'
}

/** One-line hint per state, appended to the row tooltip. */
export const NIM_STATE_HINTS: Record<NimContainerState, string> = {
  'not-pulled': 'Image not downloaded yet — the first start pulls it (can take a while).',
  stopped: 'Container is not running. Start it from the context menu, or just chat with it.',
  starting: 'Container is up but the model is still loading. Chat works once it shows Ready.',
  ready: 'Container is up and serving requests.',
  exited: 'Container exited. Check logs, then start it again.'
}

/** One probe record per managed model; overwritten on every verification. */
export interface ModelProbe {
	testedAt: number
	/** Model's reply text on success, error message on failure. */
	reply: string
	status: ModelStatus
	httpStatus?: number
}

/** A model managed by the extension (added by the user into one of the two groups). */
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
}

/** Result of the one-time NVIDIA setup check (runs when the API key is saved). */
export interface SetupState {
	/** The key was accepted by the cloud chat endpoint. */
	cloudOk: boolean
	/** The key is accepted by the NGC API — NIM images can be pulled. */
	ngcOk: boolean
	checkedAt: number
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

/** Cached NIM container catalog (NGC search snapshot + timestamp). */
export interface NimCatalogCache {
	fetchedAt: number
	containers: NimContainer[]
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
