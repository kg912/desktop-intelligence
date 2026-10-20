// Rectification R4: claims for runs recorded before spec B 7a (2026-10-15). Those traces carry each gate's claim
// statuses but not the claims, so the evidence drawer had nothing to list (run 0f11f3fd, step 1.3, in the bug report).
// The claims are in the run's own log: each attempt's final worker reply ends with its ```claims block (or a
// ```claims_patch on a patch-only repair), and every tool result is a tool record. Parsing follows the sidecar's
// parse_claims / parse_claim_item / apply_claims_patch so the recovered claims are the ones the gate checked. Pure:
// main reads the log files (services/multiAgentClaimRecovery.ts); the dev gallery feeds the fixture's records.
import type { AgentEvent, ClaimView, EvidenceRecord, MultiAgentRunRecord } from './types'

/** The fields of a run-log call record (MultiAgentRunLogger.CallRecord) that recovery reads. */
export interface LogRecord {
  seq: number
  kind: 'model' | 'tool'
  role: string
  attempt: number
  response?: { content: string; toolCalls?: unknown[] } | null
  callId?: string
  name?: string
  args?: string
  result?: string | null
  denied?: boolean
  error?: unknown
}

const CLAIMS_BLOCK_RE = /```claims(?!_patch)[ \t]*\n?([\s\S]*?)(?:```|$)/g
const PATCH_BLOCK_RE = /```claims_patch[ \t]*\n?([\s\S]*?)(?:```|$)/g

const lastBlock = (text: string, re: RegExp): string | null => [...text.matchAll(re)].at(-1)?.[1] ?? null
const parseJson = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }

/** One claims-block entry as the sidecar keeps it (parse_claim_item), or null when the sidecar rejected it. */
function claimItem(item: unknown, index: number): ClaimView | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  if (!String(o.claim ?? '').trim()) return null
  const req = (Array.isArray(o.req) ? o.req : [o.req]).filter((r): r is string => typeof r === 'string' && !!r.trim()).map((r) => r.slice(0, 20)).slice(0, 5)
  const base: ClaimView = { id: String(o.id || `#${index + 1}`).slice(0, 20), claim: String(o.claim).slice(0, 400), ...(req.length && { req: req.length === 1 ? req[0] : req }) }
  if (Array.isArray(o.snippets) && o.snippets.length) return { ...base, snippets: o.snippets.map((x) => String(x).slice(0, 20)).slice(0, 10) }
  if (o.callId && typeof o.quote === 'string') return { ...base, callId: String(o.callId), quote: o.quote }
  if (o.unverified === true) return { ...base, unverified: true }
  if (o.source) return { ...base, source: String(o.source).slice(0, 20) }
  return base
}

/** The claims an attempt's final reply settled on: its last ```claims block, or its ```claims_patch applied to `previous`. */
export function claimsFromReply(reply: string, previous?: ClaimView[]): ClaimView[] | null {
  const patchText = lastBlock(reply, PATCH_BLOCK_RE)
  if (patchText !== null && previous) {
    const patch = parseJson(patchText) as { replace?: unknown; drop?: unknown } | undefined
    if (!patch || typeof patch !== 'object') return null
    const merged = previous.map((c) => ({ ...c }))
    if (Array.isArray(patch.replace)) patch.replace.forEach((item, i) => {
      const claim = claimItem(item, i)
      if (!claim) return
      const at = merged.findIndex((c) => c.id === claim.id)
      if (at < 0) merged.push(claim)
      else merged[at] = claim
    })
    if (Array.isArray(patch.drop)) for (const id of patch.drop.map(String)) {
      const at = merged.findIndex((c) => c.id === id)
      if (at >= 0) merged[at] = { id, claim: merged[at].claim, unverified: true, ...(merged[at].req !== undefined && { req: merged[at].req }) }
    }
    return merged
  }
  const text = lastBlock(reply, CLAIMS_BLOCK_RE)
  const raw = text === null ? undefined : parseJson(text)
  if (!Array.isArray(raw)) return null
  return raw.map(claimItem).filter((c): c is ClaimView => c !== null)
}

/** Each attempt's claims, in attempt order, from the agent's final worker reply of that attempt. */
function claimsByAttempt(records: LogRecord[]): Map<number, ClaimView[]> {
  const out = new Map<number, ClaimView[]>()
  const replies = new Map<number, string>()
  for (const r of [...records].sort((a, b) => a.seq - b.seq)) {
    const content = r.kind === 'model' && r.role === 'worker' ? r.response?.content : undefined
    if (content && !r.response?.toolCalls?.length) replies.set(r.attempt, content)  // later replies of an attempt win
  }
  let previous: ClaimView[] | undefined
  for (const attempt of [...replies.keys()].sort((a, b) => a - b)) {
    const claims = claimsFromReply(replies.get(attempt)!, previous)
    if (claims) out.set(attempt, (previous = claims))
  }
  return out
}

type Gate = Extract<AgentEvent, { type: 'reflection_result' }>

/** Agents whose gates have statuses but no claims (an older run): the ones whose log must be read. */
export function agentsMissingClaims(record: MultiAgentRunRecord): string[] {
  return [...new Set(record.executionTrace.filter((e): e is Gate => e.type === 'reflection_result' && e.claims === undefined && !!e.claimStatuses).map((e) => e.agentId))]
}

/** The saved run with `claims` filled on every gate that has statuses but no claims; the same object when there is
 *  nothing to fill. Only that field is added; the stored trace is not changed. */
export function withClaimsFromRecords(record: MultiAgentRunRecord, recordsOf: (agentId: string) => LogRecord[]): MultiAgentRunRecord {
  const agents = agentsMissingClaims(record)
  if (!agents.length) return record
  const byAgent = new Map(agents.map((id) => [id, claimsByAttempt(recordsOf(id))]))
  let changed = false
  const executionTrace = record.executionTrace.map((e) => {
    if (e.type !== 'reflection_result' || e.claims !== undefined || !e.claimStatuses) return e
    const claims = byAgent.get(e.agentId)?.get(e.attempt ?? 0)
    if (!claims) return e
    changed = true
    return { ...e, claims }
  })
  return changed ? { ...record, executionTrace } : record
}

/** "1.2/<callId>" is 1.2's call; anything else is `agentId`'s. */
export function evidenceOwner(agentId: string, callId: string): [string, string] {
  const at = callId.indexOf('/')
  return at >= 0 ? [callId.slice(0, at), callId.slice(at + 1)] : [agentId, callId]
}

/** A cited tool result from the owner's log records (evidence for runs whose sidecar state is gone). */
export function evidenceFromRecords(records: LogRecord[], owner: string, callId: string): EvidenceRecord | null {
  const tool = [...records].sort((a, b) => a.seq - b.seq).findLast((r) => r.kind === 'tool' && r.callId === callId)
  if (!tool || typeof tool.result !== 'string') return null
  return { agentId: owner, callId, name: tool.name ?? '', args: tool.args ?? '', ok: !tool.denied && !tool.error, result: tool.result, snippets: {} }
}
