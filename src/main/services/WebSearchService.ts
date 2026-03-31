/**
 * WebSearchService — Main process
 *
 * Free web search via duck-duck-scrape (no API key required).
 * Detects search intent from the user's message, performs the query
 * with a 5-second timeout, and returns the top-3 result snippets for
 * injection into the system prompt.
 *
 * Pushes WebSearchStatus events to the renderer so the UI can show
 * a "Searching the web…" indicator while the request is in flight.
 */

import type { WebContents }                  from 'electron'
import { IPC_CHANNELS }                      from '../../shared/types'
import type { WebSearchStatus }              from '../../shared/types'
import { SafeSearchType, search as ddgSearch } from 'duck-duck-scrape'

// ── Intent patterns ───────────────────────────────────────────────
// Order matters: more specific patterns first.
const INTENT_PATTERNS: Array<{ re: RegExp; stripPrefix: RegExp | null }> = [
  {
    re:          /\b(search the web|search online|google|look up|look for|search for)\b/i,
    stripPrefix: /^(search (the web |online )?for|search (the web|online)|look up|look for|google)\s+/i,
  },
  {
    re:          /\b(what('s| is)|who('s| is)|tell me about|latest|current|recent news (about|on)|news about)\b/i,
    stripPrefix: /^(what('s| is)|who('s| is)|tell me about)\s+/i,
  },
  {
    re:          /\b(find|check)\b.{0,40}\b(online|web|internet|news|latest|current)\b/i,
    stripPrefix: /^(find|check)\s+/i,
  },
]

/**
 * Returns a cleaned query string if the text suggests web search,
 * or null if it's a plain conversation turn.
 */
export function detectSearchIntent(text: string): string | null {
  const trimmed = text.trim()

  for (const { re, stripPrefix } of INTENT_PATTERNS) {
    if (re.test(trimmed)) {
      const query = stripPrefix
        ? trimmed.replace(stripPrefix, '').trim()
        : trimmed
      return query || trimmed
    }
  }

  return null
}

/**
 * Performs a DDG web search, pushes status events, and returns
 * a formatted string suitable for injection into the system prompt.
 * Never throws — returns a failure notice on timeout or error.
 */
export async function performWebSearch(
  query:  string,
  wc:     WebContents
): Promise<string> {
  const push = (s: WebSearchStatus): void => {
    if (!wc.isDestroyed()) wc.send(IPC_CHANNELS.WEB_SEARCH_STATUS, s)
  }

  push({ phase: 'searching', query })

  try {
    const results = await Promise.race<string>([
      fetchTopSnippets(query),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('timeout')), 5_000)
      ),
    ])

    push({ phase: 'done', query })
    return results
  } catch {
    push({ phase: 'error', query, error: 'Web search failed or timed out.' })
    return '[System: Web search failed or timed out.]'
  }
}

// ── Internal ──────────────────────────────────────────────────────

async function fetchTopSnippets(query: string): Promise<string> {
  const data = await ddgSearch(query, { safeSearch: SafeSearchType.MODERATE })

  const top3 = (data.results ?? []).slice(0, 3)
  if (top3.length === 0) {
    return `[Web Search Results for "${query}": No results found.]`
  }

  const body = top3
    .map((r, i) => `${i + 1}. **${r.title}**\n${r.description}\n(${r.url})`)
    .join('\n\n')

  return `[Web Search Results for "${query}":\n\n${body}]`
}
