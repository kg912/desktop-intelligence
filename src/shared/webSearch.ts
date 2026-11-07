// Web search provider settings and the Exa request builder (spec: specs/exa-search-integration.md).
// Pure: shared by the main process (requests, validation) and the renderer (Settings request preview).

export type WebSearchProvider = 'brave' | 'exa'
export type ExaSearchType = 'lite' | 'auto' | 'deep-lite' | 'deep'
export type ExaContentMode = 'highlights' | 'text'
export type ExaFreshness = 'default' | '24h' | 'always'

/** Model-facing tool name for both providers; `brave_web_search` stays accepted (persisted chats, older models). */
export const WEB_SEARCH_TOOL_NAME = 'web_search'
export const LEGACY_WEB_SEARCH_TOOL_NAME = 'brave_web_search'

export function isWebSearchToolName(name: string | undefined): boolean {
  return name === WEB_SEARCH_TOOL_NAME || name === LEGACY_WEB_SEARCH_TOOL_NAME
}

/** The persisted fields readiness depends on (AppSettings in the main process). */
export interface WebSearchKeys {
  braveSearchEnabled?: boolean
  braveSearchApiKey?: string
  webSearchProvider?: WebSearchProvider
  exaApiKey?: string
}

/** The selected provider's key, trimmed, or null when none is saved. */
export function webSearchApiKey(s: WebSearchKeys): string | null {
  return (s.webSearchProvider === 'exa' ? s.exaApiKey : s.braveSearchApiKey)?.trim() || null
}

/** Web search is on and the selected provider has a key (single chat and workers both check this). */
export function isWebSearchReady(s: WebSearchKeys): boolean {
  return !!s.braveSearchEnabled && webSearchApiKey(s) !== null
}

export interface WebSearchSettings {
  provider: WebSearchProvider
  exaSearchType: ExaSearchType
  exaContentMode: ExaContentMode
  exaMaxCharacters: number
  exaNumResults: number
  exaFreshness: ExaFreshness
}

export const EXA_TYPES: readonly ExaSearchType[] = ['lite', 'auto', 'deep-lite', 'deep']

/** Settings > Web Search depth cards (Phase 0 timings and prices, specs/research/exa-verification.md). */
export const EXA_MODES: Record<ExaSearchType, { label: string; latency: string; price: string; dollars: number; desc: string }> = {
  lite: { label: 'Fast', latency: '~450 ms', price: '$4 / 1k', dollars: 0.004, desc: 'Cached pages only, no synthesis. Cheapest and quickest. Good for small local models.' },
  auto: { label: 'Balanced', latency: '~1 s', price: '$7 / 1k', dollars: 0.007, desc: 'Best default for quality and speed. Supports freshness control.' },
  'deep-lite': { label: 'Deep-lite', latency: '~3-4 s', price: '$12 / 1k', dollars: 0.012, desc: 'Light query expansion plus a short grounded brief.' },
  deep: { label: 'Deep', latency: '4–15 s', price: '$12 / 1k', dollars: 0.012, desc: 'Iterative search that checks evidence and refines. For multi-part questions.' },
}

/** "balanced", "fast", "deep-lite", "deep": the input-bar selector and run chip wording. */
export const exaModeLabel = (t: ExaSearchType): string => EXA_MODES[t].label.toLowerCase()

export const EXA_DEFAULTS = { maxCharacters: 3000, numResults: 5 } as const
export const EXA_MAX_CHARACTERS_RANGE = [1000, 10000] as const
export const EXA_NUM_RESULTS_RANGE = [3, 10] as const
/** Deep types take up to 15 s per round, so a turn gets at most this many search rounds. */
export const DEEP_SEARCH_MAX_ROUNDS = 2
export const EXA_SYNTHESIS_DESCRIPTION = 'Concise evidence brief: key facts, figures and dates'

const clampInt = (v: unknown, [lo, hi]: readonly [number, number], fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback

/** Defaults and clamping for the persisted fields; an old settings file (no Exa fields) gives Brave defaults. */
export function normalizeWebSearchSettings(raw: {
  webSearchProvider?: unknown; exaSearchType?: unknown; exaContentMode?: unknown
  exaMaxCharacters?: unknown; exaNumResults?: unknown; exaFreshness?: unknown
}): WebSearchSettings {
  return {
    provider: oneOf(raw.webSearchProvider, ['brave', 'exa'], 'brave'),
    exaSearchType: oneOf(raw.exaSearchType, EXA_TYPES, 'auto'),
    exaContentMode: oneOf(raw.exaContentMode, ['highlights', 'text'], 'highlights'),
    exaMaxCharacters: clampInt(raw.exaMaxCharacters, EXA_MAX_CHARACTERS_RANGE, EXA_DEFAULTS.maxCharacters),
    exaNumResults: clampInt(raw.exaNumResults, EXA_NUM_RESULTS_RANGE, EXA_DEFAULTS.numResults),
    exaFreshness: oneOf(raw.exaFreshness, ['default', '24h', 'always'], 'default'),
  }
}

export const isDeepExaType = (t: ExaSearchType): boolean => t === 'deep' || t === 'deep-lite'

/** Multi-agent workers never run the deep types: the lower of the selected type and `auto`. */
export function workerExaType(t: ExaSearchType): ExaSearchType {
  return t === 'lite' ? 'lite' : 'auto'
}

/** Search rounds a single-chat turn gets: deep Exa types are capped at DEEP_SEARCH_MAX_ROUNDS. */
export function effectiveSearchRounds(maxSearchLoops: number, s: Pick<WebSearchSettings, 'provider' | 'exaSearchType'>): number {
  return s.provider === 'exa' && isDeepExaType(s.exaSearchType) ? Math.min(maxSearchLoops, DEEP_SEARCH_MAX_ROUNDS) : maxSearchLoops
}

export interface ExaRequestBody {
  query: string
  objective?: string
  type: ExaSearchType
  numResults: number
  contents: { highlights?: true; text?: { maxCharacters: number }; maxAgeHours?: number }
  outputSchema?: { type: 'text'; description: string }
}

/**
 * The single place that knows which parameters each Exa type allows (spec 2.2, Phase 0 §3):
 * `lite` rejects outputSchema, systemPrompt, additionalQueries, contents.summary,
 * contents.maxAgeHours and contents.livecrawl with 400 INVALID_REQUEST_BODY, so it never gets them.
 */
export function buildExaRequest(s: WebSearchSettings, query: string, objective?: string, type: ExaSearchType = s.exaSearchType): ExaRequestBody {
  const contents: ExaRequestBody['contents'] = s.exaContentMode === 'text'
    ? { text: { maxCharacters: s.exaMaxCharacters } }
    : { highlights: true }
  if (type !== 'lite' && s.exaFreshness !== 'default') contents.maxAgeHours = s.exaFreshness === '24h' ? 24 : 0
  return {
    query,
    ...(objective?.trim() ? { objective: objective.trim() } : {}),
    type,
    numResults: s.exaNumResults,
    contents,
    ...(isDeepExaType(type) ? { outputSchema: { type: 'text' as const, description: EXA_SYNTHESIS_DESCRIPTION } } : {}),
  }
}

/** Optional search metadata carried by tool stream events and persisted search blocks. */
export interface WebSearchMeta {
  provider?: WebSearchProvider
  /** Exa type that ran (absent for Brave). */
  mode?: ExaSearchType
  contentMode?: ExaContentMode
  searchTimeMs?: number
  costDollars?: number
  synthesis?: { text: string; citations?: Array<{ title: string; url: string }> }
}

/** Settings > Web Search over IPC (mcpGetSettings / mcpSaveSettings). */
export interface WebSearchSettingsPayload {
  braveEnabled: boolean
  braveApiKey: string
  maxSearchLoops: number
  keepSearchResultsInContext: boolean
  webSearchProvider: WebSearchProvider
  exaApiKey: string
  exaSearchType: ExaSearchType
  exaContentMode: ExaContentMode
  exaMaxCharacters: number
  exaNumResults: number
  exaFreshness: ExaFreshness
}

/** Multi-agent: the provider a run's workers search with, snapshot when the run starts (run_config.webSearch). */
export interface RunWebSearch {
  provider: WebSearchProvider
  /** Effective Exa type for workers (workerExaType of the saved one); absent for Brave. */
  type?: ExaSearchType
}

/** The run snapshot for these settings, or null when web search is off or has no key (no web_search tool offered). */
export function runWebSearchSnapshot(s: WebSearchKeys & { exaSearchType?: unknown }): RunWebSearch | null {
  if (!isWebSearchReady(s)) return null
  const ws = normalizeWebSearchSettings(s)
  return ws.provider === 'exa' ? { provider: 'exa', type: workerExaType(ws.exaSearchType) } : { provider: 'brave' }
}

/** "Brave", "Exa · balanced", or "Exa" when no type is given. */
export function webSearchLabel(provider: WebSearchProvider, type?: ExaSearchType): string {
  return provider === 'exa' ? `Exa${type ? ` · ${exaModeLabel(type)}` : ''}` : 'Brave'
}

/** One worker search, summarised from its observability search_call record (tool_done.search). */
export interface WorkerSearchInfo {
  provider: WebSearchProvider
  /** Exa type that ran; absent for Brave. */
  type?: ExaSearchType
  ms: number
  /** Exa costDollars.total; null when the provider reports none (Brave). */
  costUsd: number | null
  results: number | null
}
