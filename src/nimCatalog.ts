/**
 * NIM container catalog, sourced from NVIDIA's public NGC catalog search.
 *
 * The cloud chat catalog (`/models`) lists model ids, but those ids do NOT
 * map 1:1 to NIM container images — `nvcr.io/nim/<id>:latest` is a guess that
 * is wrong as often as it is right (e.g. there is no `nim/01-ai/yi-large`
 * container at all). This module lists the containers that actually exist:
 * the search endpoint needs no auth and answers with exact resource ids,
 * display names, and real latest tags.
 *
 * Like ./keyVerifier and ./ngcVerifier, this module has no `vscode`
 * dependency on purpose.
 */

const SEARCH_URL = 'https://api.ngc.nvidia.com/v2/search/catalog/resources/CONTAINER'
const PAGE_SIZE = 100
/** Hard stop so a misbehaving API can never page forever. */
const MAX_PAGES = 50

/** One NIM container as listed by the NGC catalog. */
export interface NimContainer {
  /** Catalog id, e.g. 'nim/meta/llama-3.1-8b-instruct'. */
  resourceId: string
  /** Registry path without tag, e.g. 'nvcr.io/nim/meta/llama-3.1-8b-instruct'. */
  image: string
  /** Real latest tag from the catalog, e.g. '1.5.0' (not a ':latest' guess). */
  tag: string
  displayName: string
  description: string
  /** Model id the NIM serves, e.g. 'meta/llama-3.1-8b-instruct'. */
  modelId: string
  publisher: string
}

interface NgcAttribute { key?: string, value?: string }

interface NgcResource {
  resourceId?: string
  orgName?: string
  teamName?: string
  name?: string
  displayName?: string
  description?: string
  attributes?: NgcAttribute[]
}

interface NgcSearchPage {
  resultPageTotal?: number
  results?: Array<{ resources?: NgcResource[] }>
}

function toContainer(r: NgcResource): NimContainer | undefined {
  if (typeof r.resourceId !== 'string' || r.orgName !== 'nim') return undefined
  const tag = r.attributes?.find(a => a.key === 'latestTag')?.value || 'latest'
  const modelId = r.resourceId.replace(/^nim\//, '')
  return {
    resourceId: r.resourceId,
    image: `nvcr.io/${r.resourceId}`,
    tag,
    displayName: r.displayName || r.name || modelId,
    description: r.description ?? '',
    modelId,
    publisher: r.teamName || 'nim'
  }
}

/**
 * Fetches every NIM container in the public NGC catalog. Paginates through
 * the search endpoint and keeps only `orgName === 'nim'` entries.
 */
export async function fetchNimCatalog(): Promise<NimContainer[]> {
  const out: NimContainer[] = []
  const seen = new Set<string>()
  let page = 0
  let totalPages = 1
  while (page < totalPages && page < MAX_PAGES) {
    const q = encodeURIComponent(JSON.stringify({ query: '*', pageSize: PAGE_SIZE, page }))
    const res = await fetch(`${SEARCH_URL}?q=${q}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`NIM catalog request failed (${res.status}).`)
    const json = (await res.json()) as NgcSearchPage
    totalPages = json.resultPageTotal ?? 1
    for (const group of json.results ?? []) {
      for (const r of group.resources ?? []) {
        const c = toContainer(r)
        if (c && !seen.has(c.resourceId)) {
          seen.add(c.resourceId)
          out.push(c)
        }
      }
    }
    page++
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  if (out.length === 0) throw new Error('NIM catalog request returned no containers.')
  return out
}
