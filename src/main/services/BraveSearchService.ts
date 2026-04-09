import { net } from 'electron'
import { readSettings } from './SettingsStore'

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'

export interface BraveSearchResult {
  title:       string
  url:         string
  description: string
}

export async function braveSearch(
  query:  string,
  apiKey: string,
  count = 5
): Promise<BraveSearchResult[]> {
  const url = new URL(BRAVE_SEARCH_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(count, 10)))

  const response = await fetch(url.toString(), {
    headers: {
      'Accept':               'application/json',
      'Accept-Encoding':      'gzip',
      'X-Subscription-Token': apiKey,
    },
  })

  if (!response.ok) {
    throw new Error(`Brave Search API error ${response.status}: ${await response.text()}`)
  }

  const data = await response.json() as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
  }

  return (data.web?.results ?? []).map(r => ({
    title:       r.title       ?? '',
    url:         r.url         ?? '',
    description: r.description ?? '',
  }))
}

export function formatSearchResults(results: BraveSearchResult[]): string {
  if (results.length === 0) return 'No results found.'

  // Strip markdown syntax from snippets — prevents asterisks/underscores from
  // bleeding through into the rendered response when the model echoes them back.
  const sanitise = (s: string): string =>
    s
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/__/g, '')
      .replace(/_/g, ' ')
      .replace(/`/g, "'")
      .trim()

  return results
    .map((r, i) => `[${i + 1}] ${sanitise(r.title)}\n${r.url}\n${sanitise(r.description)}`)
    .join('\n\n')
}

/**
 * Resolves the Brave Search API key from SettingsStore only.
 * Returns null if no key has been saved.
 */
export function resolveBraveApiKey(): string | null {
  const s = readSettings()
  if (s.braveSearchApiKey && s.braveSearchApiKey.trim()) return s.braveSearchApiKey.trim()
  return null
}

// ── Page-fetch augmentation ─────────────────────────────────────────────────
//
// For results with very short snippets, we attempt to fetch the page directly
// and extract plain text — giving the model substantially more context than
// the 1-2 sentence Brave snippet alone.
//
// Domains known to return JS-shell pages or hard paywalls are skipped
// immediately so we don't waste the 5s timeout budget on them.

const FETCH_SKIP_DOMAINS = new Set([
  'twitter.com', 'x.com', 'instagram.com', 'facebook.com',
  'linkedin.com', 'tiktok.com', 'reddit.com',
  'tipranks.com', 'stockanalysis.com',
  'bloomberg.com', 'wsj.com',   // hard paywalls
])

function shouldSkipFetch(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return FETCH_SKIP_DOMAINS.has(host)
  } catch {
    return true  // unparseable URL — skip
  }
}

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{3,}/g, '\n\n')
    .trim()
    .slice(0, 3000)
}

const SNIPPET_MIN_LENGTH = 80  // below this, snippet is too short to be useful

async function fetchPageText(
  url: string,
  timeoutMs = 5000
): Promise<string | null> {
  if (shouldSkipFetch(url)) {
    if (typeof __DEV_MODE__ !== 'undefined' && __DEV_MODE__) {
      console.log(`[BraveSearch] ⏭ Skipped fetch for ${url} (domain blocklist)`)
    }
    return null
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await net.fetch(url, {
      signal: controller.signal as RequestInit['signal'],
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    } as RequestInit)
    clearTimeout(timer)
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) return null
    const html = await response.text()
    const text = extractTextFromHtml(html)
    if (text.length > 100) {
      if (typeof __DEV_MODE__ !== 'undefined' && __DEV_MODE__) {
        console.log(`[BraveSearch] 📄 Fetched ${url.slice(0, 60)} — ${text.length} chars`)
      }
      return text
    }
    return null
  } catch {
    return null  // timeout, network error, CSP block — all silent
  }
}

/**
 * Augmented formatter: for results with weak snippets, fetches the page
 * directly and substitutes the extracted body text.
 *
 * Fetch targets are processed in parallel — the total latency overhead is
 * bounded by the slowest successful fetch (≤5s), not the sum of all fetches.
 *
 * Falls back to the Brave snippet for any result where the fetch fails,
 * times out, or is on the skip list.
 */
export async function augmentAndFormatResults(
  results: BraveSearchResult[]
): Promise<string> {
  if (results.length === 0) return 'No results found.'

  // Identify results with weak snippets that are worth fetching
  const fetchTargets = results
    .map((r, i) => ({ r, i, needsFetch: r.description.length < SNIPPET_MIN_LENGTH && !shouldSkipFetch(r.url) }))

  // Fetch all weak-snippet results in parallel
  const fetched = await Promise.allSettled(
    fetchTargets.map(t =>
      t.needsFetch ? fetchPageText(t.r.url) : Promise.resolve(null)
    )
  )

  const sanitise = (s: string): string =>
    s
      .replace(/\*\*/g, '').replace(/\*/g, '')
      .replace(/__/g, '').replace(/_/g, ' ')
      .replace(/`/g, "'").trim()

  return results
    .map((r, i) => {
      const fetchResult = fetched[i]
      const pageText = fetchResult.status === 'fulfilled'
        ? fetchResult.value
        : null

      // Use fetched page text if snippet was weak and fetch succeeded
      const body = pageText
        ? pageText
        : sanitise(r.description)

      return `[${i + 1}] ${sanitise(r.title)}\n${r.url}\n${body}`
    })
    .join('\n\n')
}
