import type { ExaContentMode, ExaSearchType, WebSearchProvider } from '../../../shared/webSearch'

// One web search, provider-neutral (spec section 5). Brave and Exa both produce this,
// plus the exact string the model gets and a `search_call` observability record (spec 8a).

export interface NormalizedSearch {
  provider: WebSearchProvider
  mode?: ExaSearchType
  contentMode?: ExaContentMode
  results: Array<{ title: string; url: string; body: string; publishedDate?: string }>
  synthesis?: { text: string; grounding?: Array<{ title: string; url: string }> }
  notices?: string[]
  costDollars?: number
  searchTimeMs: number
}

export interface SearchCap { kind: 'worker_depth_cap' | 'deep_round_cap'; from: string | number; to: string | number }

/** spec 8a item 2. Recorded from the objects actually sent and received; the key header is "[redacted]". */
export interface SearchCallRecord {
  schema: 1
  provider: WebSearchProvider
  query: string
  requestedType?: ExaSearchType
  effectiveType?: ExaSearchType
  caps: SearchCap[]
  request: { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown }
  status: number | null
  rawResponse: unknown
  /** Brave only: what happened to each result's page fetch. */
  pageFetches?: unknown[]
  formatted: { chars: number }
  timing: { startedAt: number; endedAt: number; ms: number }
  retries: Array<{ status: number; waitMs: number }>
  error: string | null
}

export interface SearchOutcome {
  normalized: NormalizedSearch
  /** The tool result text before provider truncation (ChatService / the coordinator apply that). */
  formatted: string
  record: SearchCallRecord
}

/** A failed search keeps its record so the logs show the request and the error. */
export class WebSearchError extends Error {
  constructor(message: string, readonly record: SearchCallRecord, readonly aborted = false) {
    super(message)
    this.name = aborted ? 'AbortError' : 'WebSearchError'
  }
}

/** Same set as ChatService's EOS_TOKENS_RE: fetched pages can carry literal special tokens. */
const EOS_RE = /<\|(?:endoftext|im_end|eot_id|end)\|>/gi

const sanitiseTitle = (s: string): string =>
  s.replace(/\*\*/g, '').replace(/\*/g, '').replace(/__/g, '').replace(/_/g, ' ').replace(/`/g, "'").trim()

/**
 * Exa results as the model sees them: the deep-mode brief (with its own citation list, since its
 * [n] markers index the brief's grounding, not the results), then `[n] title\nurl\nbody` blocks in
 * Brave's shape, then any notices. EOS tokens are stripped everywhere.
 */
export function formatForModel(n: NormalizedSearch): string {
  const parts: string[] = []
  if (n.synthesis?.text.trim()) {
    const cites = n.synthesis.grounding ?? []
    parts.push(
      `Exa synthesis (verify against sources):\n${n.synthesis.text.trim()}` +
        (cites.length ? `\n\nBrief sources:\n${cites.map((c, i) => `[${i + 1}] ${sanitiseTitle(c.title)} ${c.url}`).join('\n')}` : ''),
    )
  }
  parts.push(n.results.length
    ? n.results.map((r, i) => `[${i + 1}] ${sanitiseTitle(r.title)}\n${r.url}\n${r.body.trim()}`).join('\n\n')
    : 'No results found.')
  for (const notice of n.notices ?? []) parts.push(`Exa notice: ${notice}`)
  return parts.join('\n\n').replace(EOS_RE, '')
}
