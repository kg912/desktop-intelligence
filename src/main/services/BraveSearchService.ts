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
