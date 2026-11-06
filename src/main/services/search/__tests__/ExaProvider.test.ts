/**
 * Exa spec section 9: response normalisation from the recorded Phase 0 fixtures (keys and request ids
 * scrubbed), formatForModel, the error mapper (401, 402, 429, 400, network, timeout, user abort),
 * the 429 retry and the in-flight limit.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { exaSearch, exaErrorMessage, normalizeExaResponse, _exaInFlight, EXA_MAX_IN_FLIGHT, EXA_SEARCH_URL } from '../ExaProvider'
import { formatForModel, WebSearchError } from '../SearchProvider'
import { buildExaRequest, normalizeWebSearchSettings } from '../../../../shared/webSearch'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8')
const json = (name: string): Record<string, unknown> => JSON.parse(fixture(name))
const settings = normalizeWebSearchSettings({ webSearchProvider: 'exa' })
const KEY = 'exa-test-key-0000'

const reply = (status: number, body: string): Response => ({ status, text: async () => body }) as unknown as Response

afterEach(() => vi.useRealTimers())

describe('normalizeExaResponse (Phase 0 fixtures)', () => {
  it('auto + highlights: five results, highlights as the body, cost and searchTime', () => {
    const raw = json('search-auto-highlights')
    const n = normalizeExaResponse(raw, 'auto', 'highlights', 999)
    expect(n.results).toHaveLength(5)
    expect(n.results[0]).toEqual({
      title: 'Highlights from ESA/Hubble and ESA/Webb in 2025 | ESA/Hubble',
      url: 'https://esahubble.org/forscientists/announcements/sci25008/',
      body: ((raw.results as Array<{ highlights: string[] }>)[0].highlights).join('\n'),
      publishedDate: '2025-12-17T00:00:00.000Z',
    })
    expect(n.results[1]).not.toHaveProperty('publishedDate') // null in the fixture
    expect(n).toMatchObject({ provider: 'exa', mode: 'auto', contentMode: 'highlights', costDollars: 0.007, searchTimeMs: 308 })
    expect(n).not.toHaveProperty('synthesis')
    expect(n).not.toHaveProperty('notices')
  })

  it('lite + text: the 3,000-character text is the body', () => {
    const n = normalizeExaResponse(json('search-lite-text'), 'lite', 'text', 1)
    expect(n.results.map((r) => r.body.length)).toEqual([3000, 3000, 3000, 3000, 3000])
    expect(n.costDollars).toBe(0.004)
  })

  it('deep + outputSchema: output.content becomes the synthesis with its 16 grounding citations', () => {
    const raw = json('search-deep-synthesis') as { output: { content: string } }
    const n = normalizeExaResponse(raw, 'deep', 'highlights', 1)
    expect(n.synthesis?.text).toBe(raw.output.content)
    expect(n.synthesis?.text.length).toBe(3727)
    expect(n.synthesis?.grounding).toHaveLength(16)
    expect(n.synthesis?.grounding?.[0]).toEqual({ url: 'https://phys.org/news/2025-08-universe-earliest-black-hole-monster.html', title: "Meet the universe's earliest confirmed black hole: A monster at the dawn of time" })
    expect(n.costDollars).toBe(0.012)
    expect(n.searchTimeMs).toBe(9864)
  })

  it('notices (string or {message}) are kept; warnings are not passed to the model', () => {
    const raw = { ...json('search-auto-warnings'), notices: ['Results may be stale', { message: 'Type fast is legacy' }] }
    const n = normalizeExaResponse(raw, 'auto', 'highlights', 1)
    expect(n.notices).toEqual(['Results may be stale', 'Type fast is legacy'])
    expect(formatForModel(n)).not.toContain('IGNORED_FIELD')
    expect(formatForModel(n).endsWith('\n\nExa notice: Results may be stale\n\nExa notice: Type fast is legacy')).toBe(true)
  })

  it('missing fields: wall time is used, empty titles and bodies are empty strings', () => {
    expect(normalizeExaResponse({ results: [{ url: 'https://a.example' }] }, 'lite', 'highlights', 432)).toEqual({
      provider: 'exa', mode: 'lite', contentMode: 'highlights', results: [{ title: '', url: 'https://a.example', body: '' }], searchTimeMs: 432,
    })
  })
})

describe('formatForModel', () => {
  it('numbered [n] title/url/body blocks, markdown stripped from titles, EOS tokens stripped everywhere', () => {
    const text = formatForModel({
      provider: 'exa', mode: 'auto', searchTimeMs: 1,
      results: [
        { title: '**Big** _news_', url: 'https://a.example', body: 'line one<|endoftext|>\nline two' },
        { title: 'Second', url: 'https://b.example', body: '  body<|im_end|> two  ' },
      ],
    })
    expect(text).toBe('[1] Big  news\nhttps://a.example\nline one\nline two\n\n[2] Second\nhttps://b.example\nbody two')
  })

  it('deep: the labelled brief and its own citation list come first', () => {
    const text = formatForModel({
      provider: 'exa', mode: 'deep', searchTimeMs: 1,
      synthesis: { text: 'Webb found X [1].<|eot_id|>', grounding: [{ title: 'Source *A*', url: 'https://s.example' }] },
      results: [{ title: 'R', url: 'https://r.example', body: 'b' }],
    })
    expect(text).toBe('Exa synthesis (verify against sources):\nWebb found X [1].\n\nBrief sources:\n[1] Source A https://s.example\n\n[1] R\nhttps://r.example\nb')
  })

  it('no results', () => {
    expect(formatForModel({ provider: 'exa', mode: 'lite', searchTimeMs: 1, results: [] })).toBe('No results found.')
  })
})

describe('exaErrorMessage (recorded error bodies)', () => {
  it('401 invalid key: message, tag and what to do', () => {
    expect(exaErrorMessage(401, fixture('error-401-invalid-key'))).toBe(
      "Exa API error 401: Invalid API key. Provide a valid key using 'Authorization: Bearer <key>' or 'x-api-key: <key>'. Create a key at https://dashboard.exa.ai/api-keys (INVALID_API_KEY). Check the Exa API key in Settings → Web Search.",
    )
  })
  it('402 payment required', () => {
    expect(exaErrorMessage(402, fixture('error-402-payment-required'))).toBe(
      "Exa API error 402: Payment required to access this resource (X402_PAYMENT_REQUIRED). Add credits at dashboard.exa.ai or raise the key's budget.",
    )
  })
  it('400 INVALID_REQUEST_BODY from lite', () => {
    expect(exaErrorMessage(400, fixture('error-400-lite-outputschema'))).toBe(
      'Exa API error 400: Invalid request body | Not supported with type "lite": outputSchema. Use type "auto" for other parameters (INVALID_REQUEST_BODY).',
    )
  })
  it('429, a non-JSON body and an empty body', () => {
    expect(exaErrorMessage(429, '{"error":"Too many requests"}')).toBe('Exa API error 429: Too many requests. Rate limit reached; retry in a moment.')
    expect(exaErrorMessage(500, 'upstream exploded')).toBe('Exa API error 500: upstream exploded.')
    expect(exaErrorMessage(503, '')).toBe('Exa API error 503: (empty body).')
  })
})

describe('exaSearch', () => {
  const body = buildExaRequest(settings, 'webb 2025')

  it('posts the body with x-api-key, records it with the key redacted, and returns the formatted text', async () => {
    const fetchImpl = vi.fn(async () => reply(200, fixture('search-auto-highlights')))
    const out = await exaSearch(body, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(EXA_SEARCH_URL)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': KEY })
    expect(JSON.parse(init.body as string)).toEqual(body)
    expect(out.record.request).toEqual({ url: EXA_SEARCH_URL, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': '[redacted]' }, body })
    expect(out.record.rawResponse).toEqual(json('search-auto-highlights'))
    expect(out.record).toMatchObject({ provider: 'exa', query: 'webb 2025', requestedType: 'auto', effectiveType: 'auto', status: 200, retries: [], error: null, caps: [] })
    expect(out.formatted).toBe(formatForModel(out.normalized))
    expect(out.record.formatted.chars).toBe(out.formatted.length)
    expect(JSON.stringify(out.record)).not.toContain(KEY)
  })

  it('429 is retried once after the jittered wait, and the retry is recorded', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(429, '{"error":"rate limited"}'))
      .mockResolvedValueOnce(reply(200, fixture('search-auto-highlights')))
    const sleep = vi.fn(async () => {})
    const out = await exaSearch(body, KEY, { fetchImpl, sleep, jitterMs: () => 777 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(777)
    expect(out.record.retries).toEqual([{ status: 429, waitMs: 777 }])
    expect(out.normalized.results).toHaveLength(5)
  })

  it('a second 429 surfaces the mapped error with the record attached', async () => {
    const fetchImpl = vi.fn(async () => reply(429, '{"error":"rate limited"}'))
    const err = await exaSearch(body, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, jitterMs: () => 5 }).catch((e) => e)
    expect(err).toBeInstanceOf(WebSearchError)
    expect(err.message).toBe('Exa API error 429: rate limited. Rate limit reached; retry in a moment.')
    expect(err.record).toMatchObject({ status: 429, retries: [{ status: 429, waitMs: 5 }], error: err.message, rawResponse: { error: 'rate limited' } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('401 and 400 are not retried', async () => {
    for (const [status, name] of [[401, 'error-401-invalid-key'], [400, 'error-400-lite-outputschema']] as const) {
      const fetchImpl = vi.fn(async () => reply(status, fixture(name)))
      const err = await exaSearch(body, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e)
      expect(err.message).toBe(exaErrorMessage(status, fixture(name)))
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('a network error', async () => {
    const err = await exaSearch(body, KEY, { fetchImpl: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch }).catch((e) => e)
    expect(err.message).toBe('Exa request failed: fetch failed')
    expect(err.name).toBe('WebSearchError')
    expect(err.record.status).toBeNull()
  })

  it('a timeout at the per-type limit (auto: 10 s)', async () => {
    vi.useFakeTimers()
    const fetchImpl = (async (_u: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as unknown as typeof fetch
    const pending = exaSearch(body, KEY, { fetchImpl }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(_exaInFlight()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    const err = await pending
    expect(err.message).toBe('Exa search timed out after 10 s (type auto).')
    expect(err.name).toBe('WebSearchError')
    expect(_exaInFlight()).toBe(0)
  })

  it('the user stopping the turn aborts the request (AbortError, so ChatService ends the turn)', async () => {
    const controller = new AbortController()
    const fetchImpl = (async (_u: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as unknown as typeof fetch
    const pending = exaSearch(body, KEY, { fetchImpl, signal: controller.signal }).catch((e) => e)
    await Promise.resolve()
    controller.abort()
    const err = await pending
    expect(err.name).toBe('AbortError')
    expect(err.message).toBe('Search cancelled')
    expect(err.record.error).toBe('Search cancelled')
    const already = await exaSearch(body, KEY, { fetchImpl, signal: controller.signal }).catch((e) => e)
    expect(already.name).toBe('AbortError')
  })

  it(`at most ${EXA_MAX_IN_FLIGHT} requests in flight; the rest wait for a slot`, async () => {
    const releases: Array<() => void> = []
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => releases.push(() => resolve(reply(200, '{"results":[]}')))))
    const all = Array.from({ length: 6 }, () => exaSearch(body, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }))
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(_exaInFlight()).toBe(4)
    releases.shift()!()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchImpl).toHaveBeenCalledTimes(5)
    while (releases.length || fetchImpl.mock.calls.length < 6) {
      releases.shift()?.()
      await new Promise((r) => setTimeout(r, 0))
    }
    const outs = await Promise.all(all)
    expect(outs.map((o) => o.formatted)).toEqual(Array(6).fill('No results found.'))
    expect(_exaInFlight()).toBe(0)
  })

  it('a waiting request is dropped when the user stops before it gets a slot', async () => {
    const releases: Array<() => void> = []
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => releases.push(() => resolve(reply(200, '{"results":[]}')))))
    const holders = Array.from({ length: 4 }, () => exaSearch(body, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }))
    const controller = new AbortController()
    const waiting = exaSearch(body, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch, signal: controller.signal }).catch((e) => e)
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    expect((await waiting).name).toBe('AbortError')
    releases.forEach((r) => r())
    await Promise.all(holders)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(_exaInFlight()).toBe(0)
  })

  it('a 200 with a non-JSON body is an error', async () => {
    const err = await exaSearch(body, KEY, { fetchImpl: (async () => reply(200, '<html>')) as unknown as typeof fetch }).catch((e) => e)
    expect(err.message).toBe('Exa API error 200: response is not JSON.')
    expect(err.record.rawResponse).toBe('<html>')
  })
})
