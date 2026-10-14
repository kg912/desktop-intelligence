// Spec B 7a: claim chips and the evidence drawer's view-model (pure). A chip shows only what the verifier computed:
// green = a verified status, amber = declared unverified, red = in a conflict (heuristic: "possible conflict" until the
// assess call confirms it), grey = anything else (a failed check, or no status known).

import type { ClaimView } from '../../../shared/types'
import type { RunView } from './multiAgentRunState'

export type ChipTone = 'ok' | 'warn' | 'bad' | 'neutral'

export interface ClaimRow extends ClaimView {
  agentId: string
  /** "<agentId> <claimId>", as chips and the ledger write it. */
  ref: string
  status: string
  conflictWith?: string[]
  conflictConfirmed?: boolean
}

export interface AcceptedClaims {
  claims: ClaimRow[]
  /** 0-based attempt whose answer was passed on, of how many judged. */
  attempt: number
  attempts: number
  /** The judge's 1–5 score for that attempt (0 = no verdict). */
  score: number
}

const isVerified = (status: string): boolean => status.startsWith('verified')

/** Ledger conflicts by claim ref: the other claims, and whether the assess call confirmed it. */
export function conflictsByRef(view: RunView): Map<string, { other: string[]; confirmed: boolean }> {
  const out = new Map<string, { other: string[]; confirmed: boolean }>()
  for (const entry of Object.values(view.ledger ?? {})) {
    const pair = entry.conflict?.claimIds ?? []
    for (const ref of pair) {
      const prev = out.get(ref)
      const other = [...(prev?.other ?? []), ...pair.filter((r) => r !== ref && !prev?.other.includes(r))]
      out.set(ref, { other, confirmed: (prev?.confirmed ?? false) || !!entry.conflict?.confirmed })
    }
  }
  return out
}

/** The claims of the answer an agent passed on: the passing attempt's, or the degraded one's. Null when none were sent. */
export function acceptedClaims(view: RunView, agentId: string): AcceptedClaims | null {
  const agent = view.agents[agentId]
  if (!agent) return null
  // One gate per attempt, in order: the index is the 0-based attempt (ReflectionView.attempt counts from 1).
  const gates = agent.reflections
  const index = agent.degraded ? agent.degraded.attempt : gates.findLastIndex((r) => r.passed) >= 0 ? gates.findLastIndex((r) => r.passed) : gates.length - 1
  const gate = gates[index]
  if (!gate?.claims) return null
  const statuses = agent.degraded?.claimStatuses ?? gate.claimStatuses ?? {}
  const conflicts = conflictsByRef(view)
  const claims = gate.claims.map((c): ClaimRow => {
    const ref = `${agentId} ${c.id}`
    const conflict = conflicts.get(ref)
    return { ...c, agentId, ref, status: statuses[c.id] ?? 'unknown', ...(conflict && { conflictWith: conflict.other, conflictConfirmed: conflict.confirmed }) }
  })
  return { claims, attempt: index, attempts: gates.length, score: gate.score }
}

export function claimTone(status: string, conflicted: boolean): ChipTone {
  if (conflicted) return 'bad'
  if (isVerified(status)) return 'ok'
  if (status === 'unverified_declared') return 'warn'
  return 'neutral'
}

export function claimLabel(row: Pick<ClaimRow, 'status' | 'conflictWith' | 'conflictConfirmed' | 'source'>): string {
  if (row.conflictWith?.length) return row.conflictConfirmed ? 'conflicted' : 'possible conflict'
  if (row.status === 'unverified_declared') return 'unverified · declared'
  if (row.status === 'source') return `from ${row.source ?? 'an earlier agent'}`
  if (isVerified(row.status)) return row.status.includes('repointed') ? 'verified · re-pointed' : 'verified'
  return row.status === 'unknown' ? 'no status' : 'failed check'
}

function findRow(view: RunView, ref: string): ClaimRow | undefined {
  const [agentId] = ref.split(' ')
  return acceptedClaims(view, agentId)?.claims.find((c) => c.ref === ref)
}

/** Markdown links for chips: [1.2] → the agent; [1.2 c3] (or [c3] inside agent `own`'s report) → the claim, its tone
 *  in the href (#claim-<tone>-1.2~c3) so CSS colours it, and " · possible conflict" / " · unverified" on the label. */
export function linkClaims(text: string, agentIds: Set<string>, view: RunView, own?: string): string {
  return text.replace(/\[(?:(\d+(?:\.\d+)*[a-z]?) )?(c\d+[a-z]?)\](?!\()|\[(\d+(?:\.\d+)*[a-z]?)\](?!\()/g, (match, agent: string | undefined, claim: string | undefined, bare: string | undefined) => {
    if (bare) return agentIds.has(bare) ? `[${bare}](#agent-${bare})` : match
    const agentId = agent ?? own
    if (!agentId || !agentIds.has(agentId) || !claim) return match
    const row = findRow(view, `${agentId} ${claim}`)
    const tone = row ? claimTone(row.status, !!row.conflictWith?.length) : 'neutral'
    const suffix = tone === 'bad' ? (row?.conflictConfirmed ? ' · conflict' : ' · possible conflict') : tone === 'warn' ? ' · unverified' : ''
    return `[${agentId} ${claim}${suffix}](#claim-${tone}-${agentId}~${claim})`
  })
}

/** "#claim-ok-1.2~c3" → "1.2 c3". */
export function refFromHref(href: string): string | null {
  const m = /^#claim-(?:ok|warn|bad|neutral)-(.+)~(c\d+[a-z]?)$/.exec(href)
  return m ? `${m[1]} ${m[2]}` : null
}

/** Header chips of the final answer: accepted claims that verified (and are in no conflict), declared unverified, in a conflict. */
export function answerCounts(view: RunView): { verified: number; unverified: number; conflicted: number } {
  const rows = view.steps.flatMap((s) => acceptedClaims(view, s.id)?.claims ?? [])
  return {
    verified: rows.filter((r) => isVerified(r.status) && !r.conflictWith?.length).length,
    unverified: rows.filter((r) => r.status === 'unverified_declared' && !r.conflictWith?.length).length,
    conflicted: rows.filter((r) => r.conflictWith?.length).length,
  }
}

// ── Quote highlighting ───────────────────────────────────────────────────────
// The sidecar matched the quote after normalise_quote (entities, tags, curly quotes and dashes, markdown emphasis,
// thousands separators, whitespace, case). The same normalisation runs here with each normalised character mapped to
// its original span, so the highlight covers the original text, not the normalised one.

const PUNCT: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '“': '"', '”': '"', '„': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
}
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function normaliseMapped(text: string): { norm: string; from: number[]; to: number[] } {
  let norm = ''
  const from: number[] = []
  const to: number[] = []
  const push = (ch: string, start: number, end: number): void => {
    if (/\s/.test(ch)) {
      if (!norm.length || norm.endsWith(' ')) return
      ch = ' '
    }
    // Lower-casing can lengthen a character ("İ" → "i̇"): every output character maps to the same original span.
    for (const out of ch.toLowerCase()) {
      norm += out
      from.push(start)
      to.push(end)
    }
  }
  for (let i = 0; i < text.length;) {
    const ch = text[i]
    const tag = ch === '<' ? /^<[^>]{0,200}>/.exec(text.slice(i, i + 202)) : null
    if (tag) { push(' ', i, i + tag[0].length); i += tag[0].length; continue }
    const entity = ch === '&' ? /^&(#\d+|#x[0-9a-f]+|[a-z]+);/i.exec(text.slice(i, i + 12)) : null
    if (entity) {
      const name = entity[1].toLowerCase()
      const decoded = ENTITIES[name] ?? (name.startsWith('#x') ? String.fromCodePoint(parseInt(name.slice(2), 16)) : name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1))) : null)
      if (decoded !== null) { push(PUNCT[decoded] ?? decoded, i, i + entity[0].length); i += entity[0].length; continue }
    }
    if ('*_`~'.includes(ch)) { i++; continue }
    if (ch === ',' && /\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')) { i++; continue }
    push(PUNCT[ch] ?? ch, i, i + 1)
    i++
  }
  while (norm.endsWith(' ')) { norm = norm.slice(0, -1); from.pop(); to.pop() }
  return { norm, from, to }
}

const normalise = (text: string): string => normaliseMapped(text).norm.trim()

/** Original-text [start, end) ranges of the quote in `text`: one range, or one per "..."-stitched fragment found in
 *  order. [] when it is not there. */
export function findQuoteRanges(text: string, quote: string): Array<[number, number]> {
  const { norm, from, to } = normaliseMapped(text)
  const whole = normalise(quote)
  const span = (at: number, len: number): [number, number] => [from[at], to[at + len - 1]]
  if (!whole) return []
  const at = norm.indexOf(whole)
  if (at >= 0) return [span(at, whole.length)]
  const fragments = quote.split(/\.\.\.|…/).map(normalise).filter(Boolean)
  if (fragments.length < 2) return []
  const out: Array<[number, number]> = []
  let pos = 0
  for (const fragment of fragments) {
    const found = norm.indexOf(fragment, pos)
    if (found < 0) return []
    out.push(span(found, fragment.length))
    pos = found + fragment.length
  }
  return out
}
