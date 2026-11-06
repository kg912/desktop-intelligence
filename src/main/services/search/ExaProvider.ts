import type { ExaContentMode, ExaRequestBody, ExaSearchType } from '../../../shared/webSearch'
import { formatForModel, WebSearchError } from './SearchProvider'
import type { NormalizedSearch, SearchCap, SearchCallRecord, SearchOutcome } from './SearchProvider'

export const EXA_SEARCH_URL = 'https://api.exa.ai/search'
/** Per-type request timeouts (spec 5). */
export const EXA_TIMEOUT_MS: Record<ExaSearchType, number> = { lite: 5_000, auto: 10_000, 'deep-lite': 12_000, deep: 30_000 }
/** Parallel workers share Exa's 10 QPS (5 QPS for deep): at most this many requests in flight. */
export const EXA_MAX_IN_FLIGHT = 4

let inFlight = 0
const queue: Array<() => void> = []

async function acquire(signal?: AbortSignal): Promise<void> {
  if (inFlight < EXA_MAX_IN_FLIGHT) { inFlight++; return }
  await new Promise<void>((resolve, reject) => {
    const go = (): void => { signal?.removeEventListener('abort', cancel); inFlight++; resolve() }
    const cancel = (): void => { const i = queue.indexOf(go); if (i >= 0) queue.splice(i, 1); reject(signal!.reason) }
    queue.push(go)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

function release(): void {
  inFlight--
  queue.shift()?.()
}

/** @internal test use: requests currently holding a slot. */
export function _exaInFlight(): number { return inFlight }

interface ExaRawResult { title?: string | null; url?: string; publishedDate?: string | null; highlights?: string[]; text?: string }
interface ExaRawResponse {
  results?: ExaRawResult[]
  output?: { content?: unknown; grounding?: Array<{ citations?: Array<{ url?: string; title?: string }> }> }
  notices?: Array<string | { message?: string }>
  warnings?: unknown[]
  costDollars?: { total?: number }
  searchTime?: number
}

/** Response normalisation (Phase 0 fixtures: highlights is an array, text a string, output only with outputSchema). */
export function normalizeExaResponse(raw: ExaRawResponse, mode: ExaSearchType, contentMode: ExaContentMode, wallMs: number): NormalizedSearch {
  const results = (raw.results ?? []).map((r) => {
    const highlights = (r.highlights ?? []).join('\n')
    const body = contentMode === 'text' ? r.text ?? highlights : highlights || (r.text ?? '')
    return { title: r.title ?? '', url: r.url ?? '', body, ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}) }
  })
  const content = typeof raw.output?.content === 'string' ? raw.output.content : ''
  const grounding = (raw.output?.grounding ?? []).flatMap((g) => g.citations ?? []).map((c) => ({ title: c.title ?? '', url: c.url ?? '' }))
  const notices = (raw.notices ?? []).map((n) => (typeof n === 'string' ? n : n?.message ?? JSON.stringify(n))).filter(Boolean)
  return {
    provider: 'exa', mode, contentMode, results,
    ...(content.trim() ? { synthesis: { text: content, ...(grounding.length ? { grounding } : {}) } } : {}),
    ...(notices.length ? { notices } : {}),
    ...(typeof raw.costDollars?.total === 'number' ? { costDollars: raw.costDollars.total } : {}),
    searchTimeMs: Math.round(typeof raw.searchTime === 'number' ? raw.searchTime : wallMs),
  }
}

/** Error mapper (spec 5): `Exa API error <status>: <message>`, with what to do for 401 and 402. */
export function exaErrorMessage(status: number, body: string): string {
  let message = body
  try {
    const j = JSON.parse(body) as { error?: unknown; tag?: unknown }
    if (typeof j.error === 'string') message = typeof j.tag === 'string' ? `${j.error} (${j.tag})` : j.error
  } catch { /* not JSON: use the body */ }
  const hint = status === 401 ? ' Check the Exa API key in Settings → Web Search.'
    : status === 402 ? ' Add credits at dashboard.exa.ai or raise the key\'s budget.'
    : status === 429 ? ' Rate limit reached; retry in a moment.' : ''
  return `Exa API error ${status}: ${(message.trim() || '(empty body)').replace(/\.$/, '')}.${hint}`
}

export interface ExaSearchOptions {
  signal?: AbortSignal
  caps?: SearchCap[]
  requestedType?: ExaSearchType
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  jitterMs?: () => number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function exaSearch(body: ExaRequestBody, apiKey: string, opts: ExaSearchOptions = {}): Promise<SearchOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const startedAt = Date.now()
  const record: SearchCallRecord = {
    schema: 1, provider: 'exa', query: body.query,
    requestedType: opts.requestedType ?? body.type, effectiveType: body.type, caps: opts.caps ?? [],
    request: { url: EXA_SEARCH_URL, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': '[redacted]' }, body },
    status: null, rawResponse: null, formatted: { chars: 0 },
    timing: { startedAt, endedAt: startedAt, ms: 0 }, retries: [], error: null,
  }
  const fail = (message: string, aborted = false): never => {
    record.error = message
    record.timing = { startedAt, endedAt: Date.now(), ms: Date.now() - startedAt }
    throw new WebSearchError(message, record, aborted)
  }
  if (opts.signal?.aborted) fail('Search cancelled', true)

  const timeoutMs = EXA_TIMEOUT_MS[body.type]
  let slot = false
  try {
    try { await acquire(opts.signal); slot = true } catch { fail('Search cancelled', true) }
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
      const onAbort = (): void => controller.abort()
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      let status: number
      let text: string
      try {
        const res = await fetchImpl(EXA_SEARCH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        status = res.status
        text = await res.text()
      } catch (err) {
        if (opts.signal?.aborted) fail('Search cancelled', true)
        if (timedOut) fail(`Exa search timed out after ${timeoutMs / 1000} s (type ${body.type}).`)
        fail(`Exa request failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      record.status = status!
      let raw: unknown = text!
      try { raw = JSON.parse(text!) } catch { /* keep the text as received */ }
      record.rawResponse = raw
      if (status! === 429 && attempt === 0) {
        const waitMs = (opts.jitterMs ?? (() => 500 + Math.floor(Math.random() * 1000)))()
        record.retries.push({ status: 429, waitMs })
        await sleep(waitMs)
        if (opts.signal?.aborted) fail('Search cancelled', true)
        continue
      }
      if (status! < 200 || status! >= 300) fail(exaErrorMessage(status!, text!))
      if (typeof raw !== 'object' || raw === null) fail(`Exa API error ${status!}: response is not JSON.`)
      const r = raw as ExaRawResponse
      for (const w of r.warnings ?? []) console.warn('[Exa] warning:', JSON.stringify(w))
      const endedAt = Date.now()
      const normalized = normalizeExaResponse(r, body.type, body.contents.text ? 'text' : 'highlights', endedAt - startedAt)
      const formatted = formatForModel(normalized)
      record.formatted = { chars: formatted.length }
      record.timing = { startedAt, endedAt, ms: endedAt - startedAt }
      return { normalized, formatted, record }
    }
  } finally {
    if (slot) release()
  }
}
