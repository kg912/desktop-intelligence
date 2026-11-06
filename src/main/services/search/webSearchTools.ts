import { readSettings } from '../SettingsStore'
import type { AppSettings } from '../SettingsStore'
import type { LMStudioTool } from '../McpServerManager'
import {
  buildExaRequest, isWebSearchReady, isWebSearchToolName, normalizeWebSearchSettings, webSearchApiKey, workerExaType, WEB_SEARCH_TOOL_NAME,
} from '../../../shared/webSearch'
import { braveProviderSearch } from './BraveProvider'
import { exaSearch } from './ExaProvider'
import type { SearchCap, SearchCallRecord, SearchOutcome } from './SearchProvider'

export interface RunWebSearchOptions {
  objective?: string
  signal?: AbortSignal
  /** Multi-agent worker: Exa deep types run as `auto`, Brave keeps its snippet line. */
  worker?: boolean
  /** Turn-level caps already applied by the caller (deep_round_cap), recorded with this call. */
  caps?: SearchCap[]
  settings?: AppSettings
}

/** One search through the selected provider (Settings → Web Search). Throws WebSearchError (with its record) on failure. */
export async function runWebSearch(query: string, opts: RunWebSearchOptions = {}): Promise<SearchOutcome> {
  const settings = opts.settings ?? readSettings()
  const key = webSearchApiKey(settings)
  if (!key) throw new Error('Web search is not configured')
  const ws = normalizeWebSearchSettings(settings)
  if (ws.provider === 'brave') {
    const out = await braveProviderSearch(query, key, { keepSnippet: opts.worker })
    out.record.caps.push(...(opts.caps ?? []))
    return out
  }
  const type = opts.worker ? workerExaType(ws.exaSearchType) : ws.exaSearchType
  const caps = [...(opts.caps ?? []), ...(type !== ws.exaSearchType ? [{ kind: 'worker_depth_cap' as const, from: ws.exaSearchType, to: type }] : [])]
  return exaSearch(buildExaRequest(ws, query, opts.objective, type), key, { signal: opts.signal, caps, requestedType: ws.exaSearchType })
}

const DESCRIPTION =
  'Search the web for CURRENT or REAL-TIME information only. ' +
  'Use ONLY for: live data (prices, weather, scores), recent news/events, ' +
  'or when the user explicitly asks to search. ' +
  'Do NOT use for general knowledge, concepts, history, coding, math, or creative tasks.'
const QUERY = { type: 'string', description: 'Specific, concise search query for current/real-time information.' }
/** Under 20 words (it costs tokens on every request). */
const OBJECTIVE = { type: 'string', description: 'Optional: one short sentence on what this search should find.' }

/**
 * The model-facing `web_search` tool. Brave keeps its old parameters (query, count); Exa adds an
 * optional `objective`, left out for MTPLX (small local models, every token counts).
 */
export function webSearchToolSchema(settings: AppSettings, opts: { name?: string; lite?: boolean; worker?: boolean } = {}): LMStudioTool {
  const exa = normalizeWebSearchSettings(settings).provider === 'exa'
  const properties: Record<string, unknown> = { query: QUERY }
  if (exa && !opts.lite) properties.objective = OBJECTIVE
  if (!exa && !opts.worker) properties.count = { type: 'number', description: 'Number of results (1-10, default 5).' }
  return {
    type: 'function',
    function: { name: opts.name ?? WEB_SEARCH_TOOL_NAME, description: DESCRIPTION, parameters: { type: 'object', properties, required: ['query'] } },
  } as LMStudioTool
}

/** Run, agent and round a worker search belongs to, so its record lands under that tool round (spec 8a item 3). */
export interface WorkerSearchContext {
  runId: string
  chatId: string
  agentId: string
  attempt?: number
  toolRound?: number
  callId?: string
  /** Appends to the agent's JSONL through MultiAgentRunLogger (a no-op for a run that is not recorded). */
  record?: (record: unknown) => void
}

/** spec 8a item 5: multi-agent logs cap each field at 2 MB with the existing `capped` marker. */
export const WORKER_FIELD_CAP_CHARS = 2_000_000

export function workerSearchRecord(ctx: WorkerSearchContext, name: string, search: SearchCallRecord): Record<string, unknown> {
  const capped: Array<{ field: string; originalChars: number }> = []
  let raw: unknown = search.rawResponse
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? ''
  if (text.length > WORKER_FIELD_CAP_CHARS) {
    raw = text.slice(0, WORKER_FIELD_CAP_CHARS)
    capped.push({ field: 'search.rawResponse', originalChars: text.length })
  }
  return {
    schema: 1, runId: ctx.runId, chatId: ctx.chatId, seq: 0, kind: 'search_call', role: 'worker',
    agentId: ctx.agentId, attempt: ctx.attempt ?? 0, toolRound: ctx.toolRound ?? 0, callId: ctx.callId ?? '', name,
    timing: { startedAt: search.timing.startedAt, endedAt: search.timing.endedAt, ms: search.timing.ms },
    search: { ...search, rawResponse: raw },
    capped: capped.length ? capped : null,
  }
}

/** Multi-agent workers (server "builtin"): offered when isWebSearchReady(), run through the selected provider. */
export const webSearchWorkerTools = {
  getToolSchemas(): LMStudioTool[] {
    const s = readSettings()
    return isWebSearchReady(s) ? [webSearchToolSchema(s, { name: `builtin__${WEB_SEARCH_TOOL_NAME}`, worker: true })] : []
  },
  /** `web_search`, or the legacy `brave_web_search` (older plans and traces). */
  async call(toolName: string, args: Record<string, unknown>, ctx?: WorkerSearchContext): Promise<string> {
    if (!isWebSearchToolName(toolName)) throw new Error(`Unknown built-in tool: ${toolName}`)
    if (!isWebSearchReady(readSettings())) throw new Error('Web search is not configured')
    const query = String(args.query ?? '').trim()
    if (!query) throw new Error(`${toolName} needs a non-empty query`)
    const objective = typeof args.objective === 'string' ? args.objective : undefined
    try {
      const out = await runWebSearch(query, { objective, worker: true })
      ctx?.record?.(workerSearchRecord(ctx, `builtin__${toolName}`, out.record))
      return out.formatted
    } catch (err) {
      const rec = (err as { record?: SearchCallRecord }).record
      if (ctx && rec) ctx.record?.(workerSearchRecord(ctx, `builtin__${toolName}`, rec))
      throw err
    }
  },
}
