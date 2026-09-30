// OpenRouter model catalogue for Multi-Agent mode (MULTI_AGENT_SPEC.html §06):
// fetched at runtime from /api/v1/models — no curated shortlist — with
// context length, tool-call support and per-token pricing. Cached briefly so
// settings, pre-flight estimates and run starts don't refetch.

import type { OpenRouterModelInfo } from '../../shared/multiAgentModels'

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_MS = 10 * 60_000

interface RawModel {
  id?: string
  name?: string
  context_length?: number
  supported_parameters?: string[]
  pricing?: { prompt?: string; completion?: string }
}

let cache: { key: string; at: number; models: OpenRouterModelInfo[] } | null = null

const price = (v?: string): number | null => {
  const n = parseFloat(v ?? '')
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function parseCatalogue(raw: { data?: RawModel[] }): OpenRouterModelInfo[] {
  return (raw.data ?? [])
    .filter((m): m is RawModel & { id: string } => typeof m.id === 'string' && m.id.length > 0)
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: typeof m.context_length === 'number' ? m.context_length : 0,
      promptPrice: price(m.pricing?.prompt),
      completionPrice: price(m.pricing?.completion),
      supportsTools: (m.supported_parameters ?? []).includes('tools'),
    }))
}

export async function getOpenRouterCatalogue(
  apiKey: string,
  fetchFn: typeof fetch = fetch
): Promise<OpenRouterModelInfo[]> {
  if (cache && cache.key === apiKey && Date.now() - cache.at < CACHE_MS) return cache.models
  const res = await fetchFn(CATALOGUE_URL, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}`)
  const models = parseCatalogue((await res.json()) as { data?: RawModel[] })
  cache = { key: apiKey, at: Date.now(), models }
  return models
}

export function clearOpenRouterCatalogueCache(): void {
  cache = null
}
