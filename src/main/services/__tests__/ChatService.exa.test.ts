/**
 * Exa spec sections 5, 8a and 9 through the real ChatService loop: a fake Exa server (global fetch),
 * a fake model backend (net.fetch) and the REAL ObservabilityService writing to a temp folder.
 * Checks the tool wiring (web_search + legacy alias, tool_choice, deep round cap, MTPLX schema),
 * the exact strings the model receives, the stream events, and the search_call log entry.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'

const h = vi.hoisted(() => ({
  root: `${process.env.TMPDIR ?? '/tmp'}/di-exa-chat-${process.pid}-${Date.now()}`,
  netFetch: vi.fn(),
  settings: {} as Record<string, unknown>,
}))

vi.mock('electron', () => ({ app: { getPath: () => h.root }, net: { fetch: (...a: unknown[]) => h.netFetch(...a) } }))
vi.mock('../SettingsStore', () => ({ readSettings: () => h.settings, writeSettings: vi.fn() }))
vi.mock('../McpServerManager', () => ({
  mcpServerManager: { getToolSchemas: () => [], callTool: vi.fn(), drainPendingPermissions: vi.fn() },
  McpDeniedError: class extends Error {},
  buildApprovedToolResult: (t: string) => t,
  buildDeniedToolMessage: (n: string) => `Denied: ${n}`,
}))
vi.mock('../DatabaseService', () => ({ getCompactedSummary: () => null, clearCompactedSummary: vi.fn() }))
vi.mock('../fs/fsAccessInstance', () => ({
  fsToolService: { getToolSchemas: () => [], effectiveGrants: () => [], call: vi.fn(), cancelAll: vi.fn() },
}))

import { chatService, toModelToolContent } from '../ChatService'
import { observabilityService } from '../ObservabilityService'
import { IPC_CHANNELS } from '../../../shared/types'
import type { ChatSendPayload } from '../../../shared/types'
import { buildExaRequest, normalizeWebSearchSettings } from '../../../shared/webSearch'
import { formatForModel } from '../search/SearchProvider'
import { normalizeExaResponse } from '../search/ExaProvider'

const KEY = 'exa-test-key-SECRET-7f3a'
const FIXTURES = join(__dirname, '../search/__tests__/fixtures')
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.json`), 'utf8')
const LOGS = join(h.root, 'observability-logs')
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

// ── fake model backend ─────────────────────────────────────────────────────
const sse = (lines: unknown[]): string[] => [...lines.map((l) => `data: ${JSON.stringify(l)}\n`), 'data: [DONE]\n']
const toolCall = (name: string, args: Record<string, unknown>, id = 'call_1') =>
  sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }])
const answer = (text: string) => sse([{ choices: [{ delta: { content: text } }] }])
const stream = (chunks: string[]) => {
  const enc = new TextEncoder()
  let i = 0
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined }) }) } }
}
let modelQueue: string[][] = []
const modelBodies = (): Array<Record<string, any>> => h.netFetch.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body))

// ── fake Exa ───────────────────────────────────────────────────────────────
let exaReplies: Array<() => Promise<{ status: number; body: string }>> = []
const exaFetch = vi.fn(async (_url: string, init: RequestInit) => {
  const next = exaReplies.shift() ?? (async () => ({ status: 200, body: fixture('search-auto-highlights') }))
  const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    next().then(resolve, reject)
  })
  return { status: r.status, text: async () => r.body } as unknown as Response
})
const exaBodies = (): unknown[] => exaFetch.mock.calls.map(([, init]) => JSON.parse(init.body as string))

const wc = { isDestroyed: () => false, send: vi.fn() }
const events = (channel: string): Array<Record<string, any>> => wc.send.mock.calls.filter(([c]) => c === channel).map(([, p]) => p)
const payload = (text = 'What did JWST find in 2025?'): ChatSendPayload => ({ chatId: 'chat-exa', messages: [{ role: 'user', content: text }], model: 'qwen3.5', thinkingMode: 'fast' })

let captured: Array<{ type: string; payload: Record<string, any> }> = []

beforeEach(() => {
  h.settings = { backendProvider: 'lmstudio', braveSearchEnabled: true, webSearchProvider: 'exa', exaApiKey: KEY, maxSearchLoops: 4 }
  modelQueue = []
  exaReplies = []
  h.netFetch.mockReset().mockImplementation(async () => stream(modelQueue.shift() ?? answer('done')))
  exaFetch.mockClear()
  wc.send.mockClear()
  vi.stubGlobal('fetch', exaFetch)
  observabilityService.setPrefs({ observabilityEnabled: true, includeImages: true })
  captured = []
  const real = observabilityService.capture.bind(observabilityService)
  vi.spyOn(observabilityService, 'capture').mockImplementation((id, e) => { captured.push(e as never); real(id, e) })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); chatService.abort() })

/** session.md files written so far (endSession writes on setImmediate). */
async function sessionFiles(n: number): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    const dirs = existsSync(LOGS) ? readdirSync(LOGS).filter((d) => existsSync(join(LOGS, d, 'session.md'))) : []
    if (dirs.length >= n) return dirs.map((d) => readFileSync(join(LOGS, d, 'session.md'), 'utf8'))
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('session log not written')
}

function allLogText(dir: string): string {
  if (!existsSync(dir)) return ''
  return readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? allLogText(join(dir, e.name)) : readFileSync(join(dir, e.name), 'utf8'))).join('\n')
}

describe('single chat with Exa', () => {
  it('auto: offers web_search, sends the built request, gives the model the formatted results, and logs what it saw', async () => {
    rmSync(LOGS, { recursive: true, force: true })
    modelQueue = [toolCall('web_search', { query: 'JWST 2025 discoveries', objective: 'list the main findings' }), answer('Webb found black holes.')]
    await chatService.send(payload(), 'qwen3.5', wc as never)

    // Tool wiring: one web_search tool with query + objective, tool_choice auto, no legacy name in the schema.
    const [first, second] = modelBodies()
    const ws = first.tools.find((t: any) => t.function.name === 'web_search')
    expect(ws.function.parameters).toEqual({
      type: 'object', required: ['query'],
      properties: {
        query: { type: 'string', description: 'Specific, concise search query for current/real-time information.' },
        objective: { type: 'string', description: 'Optional: one short sentence on what this search should find.' },
      },
    })
    expect(first.tools.map((t: any) => t.function.name)).not.toContain('brave_web_search')
    expect(first.tool_choice).toBe('auto')
    expect(first.messages[0].content).toContain('You have access to a real-time web search tool: web_search.')
    expect(first.messages[0].content).toContain('You may call web_search at most 4 time(s) per turn.')

    // What Exa received, and what the model received.
    const sent = buildExaRequest(normalizeWebSearchSettings(h.settings), 'JWST 2025 discoveries', 'list the main findings')
    expect(exaBodies()).toEqual([sent])
    const expected = formatForModel(normalizeExaResponse(JSON.parse(fixture('search-auto-highlights')), 'auto', 'highlights', 0))
    const toolMsg = second.messages.find((m: any) => m.role === 'tool')
    expect(toolMsg.content).toBe(expected)

    // Stream events carry provider metadata; nothing differs, so no sentToModel.
    expect(events(IPC_CHANNELS.CHAT_STREAM_TOOL_START)).toEqual([{ query: 'JWST 2025 discoveries', toolName: 'web_search', provider: 'exa', mode: 'auto' }])
    const [done] = events(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE)
    expect(done).toMatchObject({ query: 'JWST 2025 discoveries', toolName: 'web_search', provider: 'exa', mode: 'auto', contentMode: 'highlights', searchTimeMs: 308, costDollars: 0.007, formattedContent: expected })
    expect(done.results).toHaveLength(5)
    expect(done.results[0]).toEqual({ title: 'Highlights from ESA/Hubble and ESA/Webb in 2025 | ESA/Hubble', url: 'https://esahubble.org/forscientists/announcements/sci25008/' })
    expect(done).not.toHaveProperty('sentToModel')
    expect(done).not.toHaveProperty('synthesis')

    // Observability: search_call (request = what the fake server got, raw = what it returned) right before the tool result.
    const types = captured.map((e) => e.type)
    const sIdx = types.indexOf('search_call')
    expect(types[sIdx + 1]).toBe('tool_result')
    const rec = captured[sIdx].payload
    expect(rec.request).toEqual({ url: 'https://api.exa.ai/search', method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': '[redacted]' }, body: exaBodies()[0] })
    expect(rec.rawResponse).toEqual(JSON.parse(fixture('search-auto-highlights')))
    expect(rec).toMatchObject({ provider: 'exa', requestedType: 'auto', effectiveType: 'auto', caps: [], retries: [], status: 200, error: null, formatted: { chars: expected.length } })
    expect(captured[sIdx + 1].payload).toEqual({ toolName: 'web_search', result: toolMsg.content })

    const [md] = await sessionFiles(1)
    expect(md).toContain('### 🔎 Search Call — exa · type auto')
    expect(md).toContain('<details><summary>Raw response (as received)</summary>')
    expect(md).toContain('"searchTime": 308.4')
    expect(md).toContain('"x-api-key": "[redacted]"')
    expect(allLogText(LOGS)).not.toContain(KEY)
  })

  it('the legacy brave_web_search name still runs (through the selected provider); an unknown name is screened', async () => {
    modelQueue = [toolCall('brave_web_search', { query: 'old name' }), answer('ok')]
    await chatService.send(payload(), 'qwen3.5', wc as never)
    expect(exaBodies()).toEqual([{ query: 'old name', type: 'auto', numResults: 5, contents: { highlights: true } }])
    expect(events(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE)[0]).toMatchObject({ toolName: 'brave_web_search', provider: 'exa' })

    modelQueue = [toolCall('google_search', { query: 'x' }), answer('ok')]
    wc.send.mockClear()
    h.netFetch.mockClear()
    await chatService.send(payload(), 'qwen3.5', wc as never)
    expect(events(IPC_CHANNELS.CHAT_STREAM_TOOL_START)).toEqual([])
    const tool = modelBodies()[1].messages.find((m: any) => m.role === 'tool')
    expect(tool.content).toContain('"google_search" is not registered')
    expect(tool.content).toContain('Registered tools for this session: web_search, get_ticker_price, get_stock_chart, brave_web_search.')
  })

  it('deep: rounds capped at 2 (recorded as deep_round_cap), the brief reaches the model, and the forced final request has no tools or tool_choice', async () => {
    h.settings = { ...h.settings, exaSearchType: 'deep' }
    exaReplies = [async () => ({ status: 200, body: fixture('search-deep-synthesis') }), async () => ({ status: 200, body: fixture('search-deep-synthesis') })]
    modelQueue = [toolCall('web_search', { query: 'a' }, 'c1'), toolCall('web_search', { query: 'b' }, 'c2'), answer('final')]
    await chatService.send(payload(), 'qwen3.5', wc as never)
    const bodies = modelBodies()
    expect(bodies).toHaveLength(3)
    expect(bodies[0].messages[0].content).toContain('You may call web_search at most 2 time(s) per turn.')
    expect(bodies[2]).not.toHaveProperty('tools')
    expect(bodies[2]).not.toHaveProperty('tool_choice')
    expect(exaBodies()).toHaveLength(2)
    expect((exaBodies()[0] as any).outputSchema).toEqual({ type: 'text', description: 'Concise evidence brief: key facts, figures and dates' })
    const tool = bodies[1].messages.find((m: any) => m.role === 'tool')
    expect(tool.content.startsWith('Exa synthesis (verify against sources):\nIn 2025, the James Webb Space Telescope')).toBe(true)
    expect(tool.content).toContain('\n\nBrief sources:\n[1] Meet the universe\'s earliest confirmed black hole: A monster at the dawn of time https://phys.org/news/2025-08-universe-earliest-black-hole-monster.html\n')
    const done = events(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE)[0]
    expect(done.synthesis.citations).toHaveLength(16)
    expect(done).toMatchObject({ mode: 'deep', costDollars: 0.012 })
    const searchCalls = captured.filter((e) => e.type === 'search_call')
    expect(searchCalls.map((e) => e.payload.caps)).toEqual([[{ kind: 'deep_round_cap', from: 4, to: 2 }], [{ kind: 'deep_round_cap', from: 4, to: 2 }]])
  })

  it('Ollama: the 12K provider limit applies; the event and the log carry the exact truncated string and originalChars', async () => {
    await new Promise((r) => setTimeout(r, 100))
    rmSync(LOGS, { recursive: true, force: true })
    observabilityService.setPrefs({ includeImages: false }) // the plain .log writer
    h.settings = { ...h.settings, backendProvider: 'ollama', exaContentMode: 'text', exaSearchType: 'lite' }
    exaReplies = [async () => ({ status: 200, body: fixture('search-lite-text') })]
    const nd = (o: unknown) => JSON.stringify(o) + '\n'
    modelQueue = [
      [nd({ message: { content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'long' } } }] }, done: true })],
      [nd({ message: { content: 'short answer' }, done: true })],
    ]
    await chatService.send(payload(), 'qwen3.5', wc as never)
    const formatted = formatForModel(normalizeExaResponse(JSON.parse(fixture('search-lite-text')), 'lite', 'text', 0))
    expect(formatted.length).toBeGreaterThan(12_000)
    const expected = formatted.slice(0, 12_000) + '\n\n[Result truncated at 12,000 chars to fit provider limit.]'
    expect(exaBodies()).toEqual([{ query: 'long', type: 'lite', numResults: 5, contents: { text: { maxCharacters: 3000 } } }])
    expect(modelBodies()[1].messages.find((m: any) => m.role === 'tool').content).toBe(expected)
    const done = events(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE)[0]
    expect(done.formattedContent).toBe(formatted)
    expect(done.sentToModel).toBe(expected)
    expect(captured.find((e) => e.type === 'tool_result')!.payload).toEqual({ toolName: 'web_search', result: expected, truncated: { originalChars: formatted.length } })
    let log = ''
    for (let i = 0; i < 100 && !log; i++) {
      const f = existsSync(LOGS) ? readdirSync(LOGS).find((n) => n.endsWith('.log')) : undefined
      if (f) log = readFileSync(join(LOGS, f), 'utf8')
      else await new Promise((r) => setTimeout(r, 10))
    }
    expect(log).toContain('▶ SEARCH CALL  exa · type lite')
    expect(log).toContain('Caps: none · Retries: none')
    expect(log).toContain(`Sent to the model: ${formatted.length} chars`)
    expect(log).toContain(`Truncated: yes (original ${formatted.length} chars)\nResult: ${expected}`)
    expect(log).not.toContain(KEY)
  })

  it('MTPLX: the web_search schema has no objective parameter', async () => {
    h.settings = { ...h.settings, backendProvider: 'mtplx' }
    await chatService.send(payload(), 'qwen3.5', wc as never)
    const ws = modelBodies()[0].tools.find((t: any) => t.function.name === 'web_search')
    expect(Object.keys(ws.function.parameters.properties)).toEqual(['query'])
  })

  it('text-stream fallback: <tool_call>web_search …</tool_call> runs through Exa', async () => {
    modelQueue = [sse([{ choices: [{ delta: { content: '<tool_call>web_search {"query": "fallback q"}</tool_call>' } }] }]), answer('done')]
    await chatService.send(payload(), 'qwen3.5', wc as never)
    expect(exaBodies()).toEqual([{ query: 'fallback q', type: 'auto', numResults: 5, contents: { highlights: true } }])
    expect(events(IPC_CHANNELS.CHAT_STREAM_TOOL_START)[0]).toEqual({ query: 'fallback q', toolName: 'web_search', provider: 'exa', mode: 'auto' })
    expect(events(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE)[0]).toMatchObject({ provider: 'exa', mode: 'auto', searchTimeMs: 308 })
  })

  it('an Exa error reaches the accordion (mapped, with the chip) and the model; the log keeps the failed request', async () => {
    exaReplies = [async () => ({ status: 401, body: fixture('error-401-invalid-key') })]
    modelQueue = [toolCall('web_search', { query: 'x' }), answer('sorry')]
    await chatService.send(payload(), 'qwen3.5', wc as never)
    const [err] = events(IPC_CHANNELS.CHAT_STREAM_TOOL_ERROR)
    expect(err).toMatchObject({ query: 'x', toolName: 'web_search', provider: 'exa', mode: 'auto' })
    expect(err.error).toMatch(/^Exa API error 401: Invalid API key\..*\(INVALID_API_KEY\)\. Check the Exa API key in Settings → Web Search\.$/)
    expect(modelBodies()[1].messages.find((m: any) => m.role === 'tool').content).toBe(`Tool failed: ${err.error}. Use training knowledge.`)
    const rec = captured.find((e) => e.type === 'search_call')!.payload
    expect(rec).toMatchObject({ status: 401, error: err.error })
  })

  it('Stop during a deep search aborts the Exa request and ends the turn (no error card, no second model call)', async () => {
    h.settings = { ...h.settings, exaSearchType: 'deep' }
    let started!: () => void
    const inFlight = new Promise<void>((r) => { started = r })
    exaReplies = [() => { started(); return new Promise(() => {}) }]
    modelQueue = [toolCall('web_search', { query: 'slow' })]
    const done = chatService.send(payload(), 'qwen3.5', wc as never)
    await inFlight
    chatService.abort()
    await done
    expect(events(IPC_CHANNELS.CHAT_STREAM_TOOL_ERROR)).toEqual([])
    expect(events(IPC_CHANNELS.CHAT_ERROR)).toEqual([])
    expect(events(IPC_CHANNELS.CHAT_STREAM_END)[0].aborted).toBe(true)
    expect(h.netFetch).toHaveBeenCalledTimes(1)
  })

  it('with observability off nothing is written', async () => {
    await new Promise((r) => setTimeout(r, 100)) // earlier tests' session writes (setImmediate) land first
    rmSync(LOGS, { recursive: true, force: true })
    observabilityService.setPrefs({ observabilityEnabled: false })
    modelQueue = [toolCall('web_search', { query: 'q' }), answer('a')]
    await chatService.send(payload(), 'qwen3.5', wc as never)
    await new Promise((r) => setTimeout(r, 50))
    expect(exaFetch).toHaveBeenCalledTimes(1)
    expect(existsSync(LOGS) ? readdirSync(LOGS) : []).toEqual([])
  })
})

describe('toModelToolContent', () => {
  it('truncates at the limit, then strips EOS tokens; untouched text has no truncated field', () => {
    expect(toModelToolContent('abc<|im_end|>', null)).toEqual({ content: 'abc' })
    expect(toModelToolContent('x'.repeat(10), 4)).toEqual({ content: 'xxxx\n\n[Result truncated at 4 chars to fit provider limit.]', truncated: { originalChars: 10 } })
    expect(toModelToolContent('ab<|endoftext|>cdef<|eot_id|>', 30)).toEqual({ content: 'abcdef' })
    // A token cut by the limit is no longer a token (same as before: truncate, then the body-wide strip).
    expect(toModelToolContent('ab<|endoftext|>cdef', 6)).toEqual({ content: 'ab<|en\n\n[Result truncated at 6 chars to fit provider limit.]', truncated: { originalChars: 19 } })
  })
})
