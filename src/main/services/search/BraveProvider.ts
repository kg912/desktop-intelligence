import { augmentAndFormatResults, braveSearch } from '../BraveSearchService'
import type { BraveExchange, PageFetchOutcome } from '../BraveSearchService'
import { WebSearchError } from './SearchProvider'
import type { SearchCallRecord, SearchOutcome } from './SearchProvider'

const BRAVE_RESULTS = 5

/**
 * The existing Brave path, unchanged in behaviour: braveSearch(query, key, 5) then
 * augmentAndFormatResults (page fetch). Adds the search_call record (request, raw
 * response, per-result fetch outcome) that observability had no view of.
 */
export async function braveProviderSearch(query: string, apiKey: string, opts: { keepSnippet?: boolean } = {}): Promise<SearchOutcome> {
  const startedAt = Date.now()
  let exchange: BraveExchange | null = null
  const record: SearchCallRecord = {
    schema: 1, provider: 'brave', query, caps: [],
    request: { url: '', method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': '[redacted]' } },
    status: null, rawResponse: null, formatted: { chars: 0 },
    timing: { startedAt, endedAt: startedAt, ms: 0 }, retries: [], error: null,
  }
  const fill = (): void => {
    if (exchange) { record.request.url = exchange.url; record.status = exchange.status; record.rawResponse = exchange.raw }
    record.timing = { startedAt, endedAt: Date.now(), ms: Date.now() - startedAt }
  }
  try {
    const results = await braveSearch(query, apiKey, BRAVE_RESULTS, (x) => { exchange = x })
    const outcomes: PageFetchOutcome[] = []
    const formatted = await augmentAndFormatResults(results, { ...(opts.keepSnippet ? { keepSnippet: true } : {}), outcomes })
    fill()
    record.pageFetches = outcomes
    record.formatted = { chars: formatted.length }
    return {
      normalized: { provider: 'brave', results: results.map((r) => ({ title: r.title, url: r.url, body: r.description })), searchTimeMs: record.timing.ms },
      formatted,
      record,
    }
  } catch (err) {
    fill()
    record.error = err instanceof Error ? err.message : String(err)
    throw new WebSearchError(record.error, record)
  }
}
