/**
 * Exa spec 6a / 8a / 9: the multi-agent worker web search tool (offered only when isWebSearchReady(),
 * routed to the selected provider, never a deep type) and its search_call record in the per-run log
 * (under the right tool round, with depth-cap and 429 anomalies, and no API key anywhere in the tree).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/di-exa-worker' }, net: { fetch: vi.fn(async () => { throw new Error('offline') }) } }))
vi.mock('../../SettingsStore', () => ({ readSettings: () => h.settings, writeSettings: vi.fn() }))

import { webSearchWorkerTools, workerSearchRecord, WORKER_FIELD_CAP_CHARS } from '../webSearchTools'
import type { WorkerSearchContext } from '../webSearchTools'
import { MultiAgentRunLogger, readRun, renderRun, verifyRunDir } from '../../MultiAgentRunLogger'
import type { CallRecord } from '../../MultiAgentRunLogger'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../../shared/types'
import type { AgentEvent } from '../../../../shared/types'

const KEY = 'exa-worker-key-SECRET-91c2'
const FIX = join(__dirname, 'fixtures')
const fixture = (name: string): string => readFileSync(join(FIX, `${name}.json`), 'utf8')
const TMP = mkdtempSync(join(tmpdir(), 'di-exa-worker-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

let replies: Array<{ status: number; body: string }> = []
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
  const r = replies.shift() ?? { status: 200, body: fixture('search-auto-highlights') }
  return { ok: r.status < 300, status: r.status, text: async () => r.body, json: async () => JSON.parse(r.body) } as unknown as Response
})

beforeEach(() => {
  h.settings = { braveSearchEnabled: true, webSearchProvider: 'exa', exaApiKey: KEY, exaSearchType: 'auto' }
  replies = []
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('webSearchWorkerTools', () => {
  it('offers builtin__web_search only when web search is ready for the selected provider', () => {
    const names = (): string[] => webSearchWorkerTools.getToolSchemas().map((t) => t.function.name)
    expect(names()).toEqual(['builtin__web_search'])
    expect(Object.keys(webSearchWorkerTools.getToolSchemas()[0].function.parameters.properties)).toEqual(['query', 'objective'])
    h.settings = { ...h.settings, exaApiKey: '' , braveSearchApiKey: 'bk' }
    expect(names()).toEqual([]) // Exa selected, only a Brave key
    h.settings = { ...h.settings, webSearchProvider: 'brave' }
    expect(names()).toEqual(['builtin__web_search'])
    expect(Object.keys(webSearchWorkerTools.getToolSchemas()[0].function.parameters.properties)).toEqual(['query'])
    h.settings = { ...h.settings, braveSearchEnabled: false }
    expect(names()).toEqual([])
  })

  it('routes to Exa; a deep selection runs as auto for workers and records the worker_depth_cap', async () => {
    h.settings = { ...h.settings, exaSearchType: 'deep' }
    const records: unknown[] = []
    const text = await webSearchWorkerTools.call('web_search', { query: 'IST NAV', objective: 'ferry times' }, { runId: 'r', chatId: 'c', agentId: '1.1', record: (r) => records.push(r) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.exa.ai/search')
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ query: 'IST NAV', objective: 'ferry times', type: 'auto', numResults: 5, contents: { highlights: true } })
    expect(text.startsWith('[1] Highlights from ESA/Hubble and ESA/Webb in 2025 | ESA/Hubble\nhttps://esahubble.org/forscientists/announcements/sci25008/\n')).toBe(true)
    expect((records[0] as { search: { caps: unknown; requestedType: string; effectiveType: string } }).search).toMatchObject({
      caps: [{ kind: 'worker_depth_cap', from: 'deep', to: 'auto' }], requestedType: 'deep', effectiveType: 'auto',
    })
  })

  it('lite stays lite for workers (no cap recorded)', async () => {
    h.settings = { ...h.settings, exaSearchType: 'lite' }
    const records: Array<{ search: { caps: unknown[] } }> = []
    await webSearchWorkerTools.call('brave_web_search', { query: 'q' }, { runId: 'r', chatId: 'c', agentId: '1.1', record: (r) => records.push(r as never) })
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).type).toBe('lite')
    expect(records[0].search.caps).toEqual([])
  })

  it('routes to Brave with its snippet line kept (the sidecar trim contract)', async () => {
    h.settings = { braveSearchEnabled: true, webSearchProvider: 'brave', braveSearchApiKey: 'bk' }
    replies = [{ status: 200, body: JSON.stringify({ web: { results: [{ title: 'Ferry', url: 'https://f.example', description: 'Daily 09:00' }] } }) }]
    const records: Array<{ search: Record<string, unknown> }> = []
    const text = await webSearchWorkerTools.call('web_search', { query: 'ferry' }, { runId: 'r', chatId: 'c', agentId: '1.1', record: (r) => records.push(r as never) })
    expect(text).toBe('[1] Ferry\nhttps://f.example\nDaily 09:00')
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('q')).toBe('ferry')
    expect(records[0].search).toMatchObject({
      provider: 'brave', status: 200, error: null,
      request: { method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': '[redacted]' } },
      rawResponse: { web: { results: [{ title: 'Ferry', url: 'https://f.example', description: 'Daily 09:00' }] } },
      pageFetches: [{ url: 'https://f.example', outcome: 'failed', reason: 'offline' }],
    })
  })

  it('refuses unknown names, empty queries and an unconfigured provider; a failed search still records', async () => {
    await expect(webSearchWorkerTools.call('exec', {})).rejects.toThrow('Unknown built-in tool: exec')
    await expect(webSearchWorkerTools.call('web_search', { query: '  ' })).rejects.toThrow('web_search needs a non-empty query')
    replies = [{ status: 402, body: fixture('error-402-payment-required') }]
    const records: Array<{ search: { status: number; error: string } }> = []
    await expect(webSearchWorkerTools.call('web_search', { query: 'q' }, { runId: 'r', chatId: 'c', agentId: '1.1', record: (r) => records.push(r as never) }))
      .rejects.toThrow("Exa API error 402: Payment required to access this resource (X402_PAYMENT_REQUIRED). Add credits at dashboard.exa.ai or raise the key's budget.")
    expect(records[0].search).toMatchObject({ status: 402, error: expect.stringMatching(/^Exa API error 402/) })
    h.settings = { ...h.settings, exaApiKey: '' }
    await expect(webSearchWorkerTools.call('web_search', { query: 'q' })).rejects.toThrow('Web search is not configured')
  })

  it('caps a raw response over 2 MB with the capped marker', () => {
    const big = 'x'.repeat(WORKER_FIELD_CAP_CHARS + 10)
    const rec = workerSearchRecord({ runId: 'r', chatId: 'c', agentId: 'a' }, 'builtin__web_search', {
      schema: 1, provider: 'exa', query: 'q', caps: [], request: { url: 'u', method: 'POST', headers: {} }, status: 200, rawResponse: big,
      formatted: { chars: 1 }, timing: { startedAt: 1, endedAt: 2, ms: 1 }, retries: [], error: null,
    })
    expect((rec.search as { rawResponse: string }).rawResponse).toHaveLength(WORKER_FIELD_CAP_CHARS)
    expect(rec.capped).toEqual([{ field: 'search.rawResponse', originalChars: WORKER_FIELD_CAP_CHARS + 10 }])
  })
})

describe('worker search in the per-run log', () => {
  const CONFIG = { ...DEFAULT_MULTI_AGENT_CONFIG, models: { orchestrator: 'm/p', worker: 'm/w', reflection: 'm/j', synthesizer: 'm/s' } }
  const ev = (seq: number, e: Record<string, unknown>): AgentEvent => ({ runId: 'run-1', seq, ts: 1_000 + seq, ...e }) as AgentEvent
  const toolRecord = (seq: number, callId: string, toolRound: number): CallRecord => ({
    schema: 1, runId: 'run-1', chatId: 'chat-1', seq, kind: 'tool', role: 'worker', agentId: '1.1', attempt: 0, toolRound,
    callId, name: 'builtin__web_search', args: '{"query":"IST NAV"}', result: 'r', approved: true, denied: false, error: null,
    timing: { startedAt: 2_000 + seq, endedAt: 2_100 + seq, ms: 100 },
  })

  function allFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? allFiles(join(dir, n)) : [join(dir, n)]))
  }

  it('lands in agent-1.1.jsonl under its tool round, renders under the tool call, adds anomalies and spend, and never contains the key', async () => {
    const root = join(TMP, 'runs')
    const logger = new MultiAgentRunLogger(root, { secrets: () => [KEY] })
    logger.begin({ runId: 'run-1', chatId: 'chat-1', chatTitle: 'Exa run', task: 'ferries', config: CONFIG })
    logger.event(ev(1, { type: 'orchestrator_plan', steps: [{ id: '1.1', label: 'Ferries', stage: 'worker', role: 'Scout', model: 'm/w', phase: 1, dependsOn: [] }] }))
    const ctx = (callId: string, toolRound: number): WorkerSearchContext => ({
      runId: 'run-1', chatId: 'chat-1', agentId: '1.1', attempt: 0, toolRound, callId, record: (r) => logger.record('run-1', r as CallRecord),
    })
    // Round 0: deep selected → capped to auto, Exa rate-limits once. The raw body echoes the key: the writer must scrub it.
    h.settings = { ...h.settings, exaSearchType: 'deep' }
    const echoed = JSON.stringify({ ...JSON.parse(fixture('search-auto-highlights')), echo: KEY })
    replies = [{ status: 429, body: '{"error":"rate limited"}' }, { status: 200, body: echoed }]
    await webSearchWorkerTools.call('web_search', { query: 'IST NAV' }, ctx('call_a', 0))
    logger.record('run-1', toolRecord(3, 'call_a', 0))
    // Round 1: no results.
    replies = [{ status: 200, body: '{"results":[],"costDollars":{"total":0.007}}' }]
    await webSearchWorkerTools.call('web_search', { query: 'nothing here' }, ctx('call_b', 1))
    logger.record('run-1', toolRecord(5, 'call_b', 1))
    logger.event(ev(9, { type: 'task_complete', finalOutput: 'done', totalCostUsd: 0, totalTokens: 0 }))
    await logger.flush()

    const dir = logger.runDir('chat-1', 'run-1')
    const lines = readFileSync(join(dir, 'agent-1.1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const searches = lines.filter((l) => l.kind === 'search_call')
    expect(searches.map((s) => [s.callId, s.toolRound, s.attempt, s.search.effectiveType, s.search.retries.length])).toEqual([['call_a', 0, 0, 'auto', 1], ['call_b', 1, 0, 'auto', 0]])
    expect(searches[0].search.rawResponse.echo).toBe('[redacted]')

    const { records, searches: read } = await readRun(dir)
    expect(records.map((r) => r.seq)).toEqual([3, 5]) // search records are kept apart from sidecar records
    expect(read).toHaveLength(2)

    const agentMd = readFileSync(join(dir, 'agent-1.1.md'), 'utf8')
    const callA = agentMd.indexOf('#### Call 3: Tool builtin__web_search (call_a), round 0')
    const searchA = agentMd.indexOf('##### Search call: exa, type auto (selected deep) for call_a')
    const callB = agentMd.indexOf('#### Call 5: Tool builtin__web_search (call_b), round 1')
    const searchB = agentMd.indexOf('##### Search call: exa, type auto (selected deep) for call_b')
    expect([callA, searchA, callB, searchB].every((i) => i >= 0)).toBe(true)
    expect(callA < searchA && searchA < callB && callB < searchB).toBe(true)
    expect(agentMd).toContain('Caps: worker_depth_cap deep → auto.')
    expect(agentMd).toMatch(/Retries: HTTP 429, waited \d+ ms\./)

    const runMd = readFileSync(join(dir, 'run.md'), 'utf8')
    expect(runMd).toMatch(/\| s1 \| \d+ \| \d+ \| exa \| auto \| 1\.1 \| 0 \| 0 \| 5 \| \$0\.007000 \| 200 \| \[agent-1\.1\.md#search-call_a\]\(agent-1\.1\.md#search-call_a\) \|/)
    expect(runMd).toContain('| exa | auto | 2 | $0.014000 |')
    expect(runMd).toContain('Search spend: $0.014000')
    expect(runMd).toContain('- **search_depth_capped**: builtin__web_search for agent 1.1: worker_depth_cap deep → auto')
    expect(runMd).toMatch(/- \*\*search_retry_429\*\*: builtin__web_search for agent 1\.1: HTTP 429, retried after \d+ ms/)
    expect(runMd).toContain('- **search_empty**: builtin__web_search for agent 1.1 returned no results for "nothing here"')

    await renderRun(dir, [KEY])
    expect(await verifyRunDir(dir, [KEY])).toEqual([])
    for (const f of allFiles(root)) expect(readFileSync(f, 'utf8')).not.toContain(KEY)
  })

  it('Brave reports no cost: run.md says "not reported", never $0', async () => {
    h.settings = { braveSearchEnabled: true, webSearchProvider: 'brave', braveSearchApiKey: 'bk' }
    const root = join(TMP, 'brave-cost')
    const logger = new MultiAgentRunLogger(root, { secrets: () => [] })
    logger.begin({ runId: 'run-1', chatId: 'chat-1', chatTitle: 'b', task: 't', config: CONFIG })
    replies = [{ status: 200, body: JSON.stringify({ web: { results: [{ title: 'T', url: 'https://t.example', description: 'd' }] } }) }]
    await webSearchWorkerTools.call('web_search', { query: 'q' }, { runId: 'run-1', chatId: 'chat-1', agentId: '1.1', callId: 'call_b', record: (r) => logger.record('run-1', r as CallRecord) })
    logger.record('run-1', toolRecord(2, 'call_b', 0))
    logger.event(ev(3, { type: 'task_complete', finalOutput: 'x', totalCostUsd: 0, totalTokens: 0 }))
    await logger.flush()
    const runMd = readFileSync(join(logger.runDir('chat-1', 'run-1'), 'run.md'), 'utf8')
    expect(runMd).toContain('| brave |  | 1 | not reported |')
    expect(runMd).toContain('Search spend: not reported (billed by the search provider')
    expect(runMd).toMatch(/\| s1 \| .* \| brave \|  \| 1\.1 \| 0 \| 0 \| 1 \| not reported \| 200 \|/)
    expect(readFileSync(join(logger.runDir('chat-1', 'run-1'), 'agent-1.1.md'), 'utf8')).toContain('Cost: not reported. Results: 1.')
  })

  it('a run that is not recorded (observability off) writes nothing', async () => {
    const root = join(TMP, 'off')
    const logger = new MultiAgentRunLogger(root, { secrets: () => [KEY] })
    await webSearchWorkerTools.call('web_search', { query: 'q' }, { runId: 'run-x', chatId: 'chat-x', agentId: '1.1', record: (r) => logger.record('run-x', r as CallRecord) })
    await logger.flush()
    expect(() => readdirSync(root)).toThrow()
  })
})

describe('provider edge branches', () => {
  it('Brave HTTP error: WebSearchError with the request URL, status and raw body recorded', async () => {
    const { braveProviderSearch } = await import('../BraveProvider')
    replies = [{ status: 403, body: 'forbidden' }]
    const err = await braveProviderSearch('blocked q', 'bk').catch((e) => e)
    expect(err.name).toBe('WebSearchError')
    expect(err.message).toBe('Brave Search API error 403: forbidden')
    expect(err.record).toMatchObject({ provider: 'brave', status: 403, rawResponse: 'forbidden', error: 'Brave Search API error 403: forbidden' })
    expect(new URL(err.record.request.url).searchParams.get('q')).toBe('blocked q')
  })

  it('Brave single-chat schema keeps its count parameter; runWebSearch without a key refuses', async () => {
    const { webSearchToolSchema, runWebSearch } = await import('../webSearchTools')
    expect(Object.keys(webSearchToolSchema({ webSearchProvider: 'brave' }).function.parameters.properties)).toEqual(['query', 'count'])
    await expect(runWebSearch('q', { settings: { braveSearchEnabled: true, webSearchProvider: 'exa' } })).rejects.toThrow('Web search is not configured')
  })

  it('a brief without grounding has no "Brief sources" list; text mode falls back to highlights; odd notices are kept as JSON', async () => {
    const { formatForModel } = await import('../SearchProvider')
    const { normalizeExaResponse } = await import('../ExaProvider')
    expect(formatForModel({ provider: 'exa', mode: 'deep-lite', searchTimeMs: 1, synthesis: { text: 'Brief.' }, results: [] }))
      .toBe('Exa synthesis (verify against sources):\nBrief.\n\nNo results found.')
    const n = normalizeExaResponse({ results: [{ title: 't', url: 'u', highlights: ['h1', 'h2'] }], notices: [{ code: 7 } as never], output: { content: '  ' } }, 'auto', 'text', 1)
    expect(n.results[0].body).toBe('h1\nh2')
    expect(n.notices).toEqual(['{"code":7}'])
    expect(n).not.toHaveProperty('synthesis')
    expect(normalizeExaResponse({ results: [{ url: 'u', text: 'page' }] }, 'auto', 'highlights', 1).results[0].body).toBe('page')
  })
})
