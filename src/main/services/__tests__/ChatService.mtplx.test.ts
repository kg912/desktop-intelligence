/**
 * ChatService — MTPLX provider branch
 *
 * MTPLX (https://github.com/youssofal/MTPLX) is a local OpenAI-compatible server.
 * Three behaviours differ from every other provider and are asserted here:
 *
 *   1. Thinking is controlled by chat_template_kwargs.enable_thinking, sent
 *      UNCONDITIONALLY (MTPLX only serves Qwen3-family models) — not by the
 *      /think and /no_think soft-prompt tokens, which MTPLX silently ignores and
 *      echoes back as literal text.
 *   2. The endpoint comes from the user-configurable mtplxBaseUrl, and no
 *      Authorization header is sent (local server, no auth, no key to misconfigure).
 *   3. Reasoning arrives on delta.reasoning_content, already split from
 *      delta.content server-side — the shared SSE path handles it, so no
 *      <think>-tag scraping happens on content for this provider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { chatService } from '../ChatService'
import { IPC_CHANNELS } from '../../../shared/types'
import type { ChatSendPayload } from '../../../shared/types'

const { mockFetch, mockReadSettings, mockGetToolSchemas } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockReadSettings: vi.fn(),
  mockGetToolSchemas: vi.fn().mockReturnValue([]),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData' },
  net: { fetch: (...args: any[]) => mockFetch(...args) },
}))

vi.mock('../SettingsStore', () => ({
  readSettings: () => mockReadSettings(),
  writeSettings: vi.fn(),
}))

vi.mock('../ObservabilityService', () => ({
  observabilityService: {
    startSession: vi.fn().mockReturnValue('obs-id'),
    endSession: vi.fn().mockResolvedValue(undefined),
    capture: vi.fn(),
  },
}))

vi.mock('../McpServerManager', () => ({
  mcpServerManager: {
    getToolSchemas: () => mockGetToolSchemas(),
    callTool: vi.fn(),
    drainPendingPermissions: vi.fn(),
  },
  McpDeniedError: class extends Error {},
  buildApprovedToolResult: (t: string) => t,
  buildDeniedToolMessage: (n: string) => `Denied: ${n}`,
}))

vi.mock('../BraveSearchService', () => ({
  braveSearch: vi.fn(),
  augmentAndFormatResults: vi.fn(),
  // No Brave key — keeps the web-search tool out of the payload so the
  // assertions below are about the MTPLX branch, not tool assembly.
  resolveBraveApiKey: vi.fn().mockReturnValue(''),
}))

vi.mock('../DatabaseService', () => ({
  getCompactedSummary: vi.fn().mockReturnValue(null),
  clearCompactedSummary: vi.fn(),
}))

// ── Harness ───────────────────────────────────────────────────────────────────

const createMockReader = (chunks: string[]) => {
  let index = 0
  const encoder = new TextEncoder()
  return {
    read: async () => {
      if (index >= chunks.length) return { done: true, value: undefined }
      return { done: false, value: encoder.encode(chunks[index++]) }
    },
  }
}

const mockResponse = (chunks: string[]) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  body: { getReader: () => createMockReader(chunks) },
})

const DONE_SSE = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n', 'data: [DONE]\n']

let mockWebContents: any

function makePayload(overrides: Partial<ChatSendPayload> = {}): ChatSendPayload {
  return {
    chatId: 'chat-mtplx',
    model: 'Qwen3-30B-A3B-MLX-4bit',
    thinkingMode: 'fast',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  } as ChatSendPayload
}

/** The parsed JSON request body of the single fetch call made by send(). */
function sentBody(): any {
  return JSON.parse(mockFetch.mock.calls[0][1].body)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockWebContents = { isDestroyed: vi.fn().mockReturnValue(false), send: vi.fn() }
  mockGetToolSchemas.mockReturnValue([])
  mockReadSettings.mockReturnValue({
    backendProvider: 'mtplx',
    mtplxBaseUrl: 'http://localhost:8000',
    maxOutputTokens: 1024,
  })
  mockFetch.mockImplementation(() => Promise.resolve(mockResponse(DONE_SSE)))
})

// ─── Endpoint & headers ───────────────────────────────────────────────────────

describe('MTPLX endpoint resolution', () => {
  it('posts to <mtplxBaseUrl>/v1/chat/completions', async () => {
    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:8000/v1/chat/completions')
  })

  it('honours a non-default port — confirmed working on 6000 locally', async () => {
    mockReadSettings.mockReturnValue({
      backendProvider: 'mtplx',
      mtplxBaseUrl: 'http://localhost:6000',
    })

    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:6000/v1/chat/completions')
  })

  it('strips a trailing slash from the saved base URL', async () => {
    mockReadSettings.mockReturnValue({
      backendProvider: 'mtplx',
      mtplxBaseUrl: 'http://localhost:6000/',
    })

    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:6000/v1/chat/completions')
  })

  it('falls back to port 8000 when no base URL is saved', async () => {
    mockReadSettings.mockReturnValue({ backendProvider: 'mtplx' })

    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:8000/v1/chat/completions')
  })

  it('sends Content-Type only — no Authorization header on a local server', async () => {
    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    const headers = mockFetch.mock.calls[0][1].headers
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('does not throw a missing-API-key error — there is no mtplxApiKey setting', async () => {
    mockReadSettings.mockReturnValue({ backendProvider: 'mtplx' })

    await expect(
      chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents),
    ).resolves.toBeUndefined()
  })
})

// ─── Thinking control ─────────────────────────────────────────────────────────

describe('MTPLX thinking control', () => {
  it('sends chat_template_kwargs.enable_thinking = true in thinking mode', async () => {
    await chatService.send(
      makePayload({ thinkingMode: 'thinking' }),
      'Qwen3-30B-A3B-MLX-4bit',
      mockWebContents,
    )

    expect(sentBody().chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it('sends chat_template_kwargs.enable_thinking = false in fast mode', async () => {
    await chatService.send(
      makePayload({ thinkingMode: 'fast' }),
      'Qwen3-30B-A3B-MLX-4bit',
      mockWebContents,
    )

    expect(sentBody().chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('sends the field unconditionally — not gated on a Qwen model-name check', async () => {
    // A model id with no "qwen" in it still gets the field, unlike the NVIDIA branch.
    await chatService.send(
      makePayload({ model: 'some-other-mlx-build' }),
      'some-other-mlx-build',
      mockWebContents,
    )

    expect(sentBody().chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('does NOT prepend /no_think to the user message — MTPLX ignores it and echoes it back', async () => {
    await chatService.send(
      makePayload({ thinkingMode: 'fast' }),
      'Qwen3-30B-A3B-MLX-4bit',
      mockWebContents,
    )

    const userMsgs = sentBody().messages.filter((m: any) => m.role === 'user')
    const joined = userMsgs.map((m: any) => m.content).join('')
    expect(joined).not.toContain('/no_think')
  })

  it('does NOT prepend /think in thinking mode either', async () => {
    await chatService.send(
      makePayload({ thinkingMode: 'thinking' }),
      'Qwen3-30B-A3B-MLX-4bit',
      mockWebContents,
    )

    const userMsgs = sentBody().messages.filter((m: any) => m.role === 'user')
    const joined = userMsgs.map((m: any) => m.content).join('')
    expect(joined).not.toContain('/think')
  })

  it('does not send the LM Studio `thinking` field', async () => {
    await chatService.send(
      makePayload({ thinkingMode: 'thinking' }),
      'Qwen3-30B-A3B-MLX-4bit',
      mockWebContents,
    )

    expect(sentBody().thinking).toBeUndefined()
  })
})

// ─── Body shape ───────────────────────────────────────────────────────────────

describe('MTPLX request body', () => {
  it('streams with usage included', async () => {
    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    const body = sentBody()
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('carries model, temperature and max_tokens from commonFields', async () => {
    mockReadSettings.mockReturnValue({
      backendProvider: 'mtplx',
      temperature: 0.42,
      maxOutputTokens: 2048,
    })

    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    const body = sentBody()
    expect(body.model).toBe('Qwen3-30B-A3B-MLX-4bit')
    expect(body.temperature).toBe(0.42)
    expect(body.max_tokens).toBe(2048)
  })

  it('omits max_tokens when unlimitedOutputTokens is set', async () => {
    mockReadSettings.mockReturnValue({
      backendProvider: 'mtplx',
      unlimitedOutputTokens: true,
    })

    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    expect(sentBody().max_tokens).toBeUndefined()
  })

  it('includes tool definitions when tools are registered', async () => {
    mockGetToolSchemas.mockReturnValue([
      { type: 'function', function: { name: 'calculator__add', description: 'Add' } },
    ])

    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    const body = sentBody()
    expect(body.tool_choice).toBe('auto')
    expect(body.tools.map((t: any) => t.function.name)).toContain('calculator__add')
  })
})

// ─── Streaming: reasoning_content ─────────────────────────────────────────────

describe('MTPLX streaming', () => {
  it('routes delta.reasoning_content into a <think> block for the accordion', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        mockResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"Let me think. "}}]}\n',
          'data: {"choices":[{"delta":{"reasoning_content":"Done."}}]}\n',
          'data: {"choices":[{"delta":{"content":"The answer is 42."}}]}\n',
          'data: [DONE]\n',
        ]),
      ),
    )

    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    const streamed = mockWebContents.send.mock.calls
      .filter(([channel]: [string]) => channel === IPC_CHANNELS.CHAT_STREAM_CHUNK)
      .map(([, v]: [string, string]) => v)
      .join('')

    expect(streamed).toContain('<think>Let me think. Done.')
    expect(streamed).toContain('</think>')
    expect(streamed).toContain('The answer is 42.')
  })

  it('passes plain content straight through when no reasoning is emitted', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        mockResponse([
          'data: {"choices":[{"delta":{"content":"Straight answer."}}]}\n',
          'data: [DONE]\n',
        ]),
      ),
    )

    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    const streamed = mockWebContents.send.mock.calls
      .filter(([channel]: [string]) => channel === IPC_CHANNELS.CHAT_STREAM_CHUNK)
      .map(([, v]: [string, string]) => v)
      .join('')

    expect(streamed).toContain('Straight answer.')
    expect(streamed).not.toContain('<think>')
  })

  it('accumulates streamed tool_calls in the standard OpenAI delta shape', async () => {
    mockGetToolSchemas.mockReturnValue([
      { type: 'function', function: { name: 'calculator__add', description: 'Add' } },
    ])
    // First chunk carries id + name, subsequent chunks append arguments —
    // exactly the shape confirmed against a live MTPLX server.
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        mockResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"calculator__add","arguments":""}}]}}]}\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":2,"}}]}}]}\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"b\\":3}"}}]}}]}\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
          'data: [DONE]\n',
        ]),
      ),
    )

    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    // The tool call was recognised and dispatched — the renderer is told a tool
    // started, and a follow-up completion request was made for the synthesis turn.
    const toolStarts = mockWebContents.send.mock.calls.filter(
      ([channel]: [string]) => channel === IPC_CHANNELS.CHAT_STREAM_TOOL_START,
    )
    expect(toolStarts.length).toBeGreaterThan(0)
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1)
  })
})

// ─── HTTP error labelling ─────────────────────────────────────────────────────

describe('MTPLX error labelling', () => {
  it('names MTPLX (not LM Studio) in the HTTP error surfaced to the renderer', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'boom',
      }),
    )

    await chatService.send(makePayload(), 'Qwen3-30B-A3B-MLX-4bit', mockWebContents)

    const errorSends = mockWebContents.send.mock.calls
      .filter(([channel]: [string]) => channel === IPC_CHANNELS.CHAT_ERROR)
      .map(([, v]: [string, unknown]) => JSON.stringify(v))
      .join(' ')

    expect(errorSends).toContain('MTPLX')
    expect(errorSends).not.toContain('LM Studio')
  })
})
