import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatService } from '../ChatService'
import { IPC_CHANNELS } from '../../../shared/types'
import type { ChatSendPayload } from '../../../shared/types'

// ────────────────────────────────────────────────────────────────────────────
// Vitest Hoisted Mocks Setup
// ────────────────────────────────────────────────────────────────────────────

const {
  mockFetch,
  mockReadSettings,
  mockStartSession,
  mockEndSession,
  mockGetToolSchemas,
  mockCallTool,
  mockBraveSearch,
  mockAugmentAndFormatResults,
  MockMcpDeniedError,
  mockGetCompactedSummary,
  mockClearCompactedSummary,
} = vi.hoisted(() => {
  class MockMcpDeniedError extends Error {
    userNote: string
    constructor(note: string) {
      super(note)
      this.name = 'McpDeniedError'
      this.userNote = note
    }
  }

  return {
    mockFetch: vi.fn(),
    mockReadSettings: vi.fn(),
    mockStartSession: vi.fn().mockReturnValue('mock-obs-session-id'),
    mockEndSession: vi.fn().mockResolvedValue(undefined),
    mockGetToolSchemas: vi.fn().mockReturnValue([]),
    mockCallTool: vi.fn(),
    mockBraveSearch: vi.fn(),
    mockAugmentAndFormatResults: vi.fn((results) => results.map((r: any) => r.title).join('\n')),
    MockMcpDeniedError,
    mockGetCompactedSummary: vi.fn().mockReturnValue(null),
    mockClearCompactedSummary: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData' },
  net: {
    fetch: (...args: any[]) => mockFetch(...args),
  },
}))

vi.mock('../SettingsStore', () => ({
  readSettings: () => mockReadSettings(),
  writeSettings: vi.fn(),
}))

vi.mock('../ObservabilityService', () => ({
  observabilityService: {
    startSession: (...args: any[]) => mockStartSession(...args),
    endSession: (...args: any[]) => mockEndSession(...args),
    capture: vi.fn(),
  },
}))

vi.mock('../McpServerManager', () => ({
  mcpServerManager: {
    getToolSchemas: () => mockGetToolSchemas(),
    callTool: (...args: any[]) => mockCallTool(...args),
    drainPendingPermissions: vi.fn(),
  },
  McpDeniedError: MockMcpDeniedError,
  buildApprovedToolResult: (text: string) => text,
  buildDeniedToolMessage: (note: string) => `Denied: ${note}`,
}))

vi.mock('../BraveSearchService', () => ({
  braveSearch: (...args: any[]) => mockBraveSearch(...args),
  augmentAndFormatResults: (...args: any[]) => mockAugmentAndFormatResults(...args),
  resolveBraveApiKey: vi.fn().mockReturnValue('mock-api-key'),
}))

vi.mock('../DatabaseService', () => ({
  getCompactedSummary: (...args: any[]) => mockGetCompactedSummary(...args),
  clearCompactedSummary: (...args: any[]) => mockClearCompactedSummary(...args),
}))

// Helper: simulated reader for mock net.fetch streams
const createMockReader = (chunks: string[]) => {
  let index = 0
  const encoder = new TextEncoder()
  return {
    read: async () => {
      if (index >= chunks.length) {
        return { done: true, value: undefined }
      }
      const val = encoder.encode(chunks[index++])
      return { done: false, value: val }
    },
  }
}

const mockResponse = (chunks: string[]) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  body: {
    getReader: () => createMockReader(chunks),
  },
})

// ────────────────────────────────────────────────────────────────────────────
// End-To-End ChatService Loop Tests
// ────────────────────────────────────────────────────────────────────────────

describe('ChatService Agent Loop E2E integration', () => {
  let mockWebContents: any
  let llmResponseQueue: any[] = []

  const queueLlmResponse = (chunks: string[]) => {
    llmResponseQueue.push(mockResponse(chunks))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockClear()
    mockCallTool.mockClear()
    mockBraveSearch.mockClear()
    llmResponseQueue = []
    
    mockWebContents = {
      isDestroyed: vi.fn().mockReturnValue(false),
      send: vi.fn(),
    }
    // Set standard settings defaults
    mockReadSettings.mockReturnValue({
      backendProvider: 'lmstudio',
      maxSearchLoops: 2,
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 1024,
      repeatPenalty: 1.1,
      braveSearchEnabled: true,
    })

    // Setup URL-aware fetch mock: isolates LLM calls from stock ticker fetches
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('completions') || url.includes('/api/chat')) {
        const nextResponse = llmResponseQueue.shift()
        return Promise.resolve(nextResponse || mockResponse([]))
      }

      if (url.includes('yahoo.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            chart: {
              result: [{
                meta: {
                  regularMarketPrice: 180.5,
                  chartPreviousClose: 178.0,
                  regularMarketOpen: 179.0,
                  regularMarketDayHigh: 181.0,
                  regularMarketDayLow: 178.5,
                  regularMarketVolume: 50000000,
                  marketCap: 2800000000000,
                  currency: 'USD',
                  exchangeName: 'NASDAQ',
                }
              }]
            }
          })
        })
      }

      return Promise.resolve(mockResponse([]))
    })
  })

  afterEach(() => {
    chatService.abort()
  })

  it('Scenario 1: Simple Streaming Completion (No Tools / Searches)', async () => {
    const mockSSEChunks = [
      'data: {"choices": [{"delta": {"reasoning_content": "Thinking about standard greetings..."}}]}\n',
      'data: {"choices": [{"delta": {"content": "\\n"}}]}\n',
      'data: {"choices": [{"delta": {"content": "Hello! "}}]}\n',
      'data: {"choices": [{"delta": {"content": "How can I help you?"}}]}\n',
      'data: [DONE]\n'
    ]

    queueLlmResponse(mockSSEChunks)

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-1',
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'qwen3.5-35b',
      thinkingMode: 'thinking',
    }

    await chatService.send(payload, 'qwen3.5-35b', mockWebContents)

    // Assert fetch call details
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [endpoint, reqOptions] = mockFetch.mock.calls[0]
    expect(endpoint).toBe('http://localhost:1234/v1/chat/completions')
    const requestBody = JSON.parse(reqOptions.body)
    expect(requestBody.model).toBe('qwen3.5-35b')
    expect(requestBody.thinking.type).toBe('enabled')

    // Assert that the IPC events are properly sent downstream to renderer in sequence
    const sendCalls = mockWebContents.send.mock.calls
    
    // Chunk events:
    const streamedChunks = sendCalls
      .filter(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_CHUNK)
      .map(([, val]) => val)

    // Asserts correct structure formatting (thought block accordion + text)
    const consolidated = streamedChunks.join('')
    expect(consolidated).toContain('<think>Thinking about standard greetings...')
    expect(consolidated).toContain('</think>\n')
    expect(consolidated).toContain('Hello! ')
    expect(consolidated).toContain('How can I help you?')

    // Completion / End event:
    const endEvent = sendCalls.find(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_END)
    expect(endEvent).toBeDefined()
    const stats = endEvent![1]
    expect(stats.totalTokens).toBeGreaterThan(0)
    expect(stats.aborted).toBe(false)
  })

  it('Scenario 2: Native Tool Call Execution (Brave Search)', async () => {
    const mockSSEChunks1 = [
      'data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-search-1", "function": {"name": "brave_web_search", "arguments": "{\\"query\\":\\"apple stock\\"}"}}]}}]}\n',
      'data: [DONE]\n'
    ]
    const mockSSEChunks2 = [
      'data: {"choices": [{"delta": {"content": "Apple Stock is up today."}}]}\n',
      'data: [DONE]\n'
    ]

    queueLlmResponse(mockSSEChunks1)
    queueLlmResponse(mockSSEChunks2)

    mockBraveSearch.mockResolvedValue([
      { title: 'Apple stock is at $180', url: 'https://finance.com/apple' }
    ])

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-2',
      messages: [{ role: 'user', content: 'What is apple stock price today?' }],
      model: 'qwen3.5-35b',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'qwen3.5-35b', mockWebContents)

    // Assert that the Agent Loop runs end to end, calling LLM twice
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockBraveSearch).toHaveBeenCalledWith('apple stock', 'mock-api-key', 5)

    const sendCalls = mockWebContents.send.mock.calls
    
    // Assert correct tool call lifecycle IPC events are fired
    const toolStart = sendCalls.find(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_TOOL_START)
    expect(toolStart).toBeDefined()
    expect(toolStart![1].query).toBe('apple stock')

    const toolDone = sendCalls.find(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_TOOL_DONE)
    expect(toolDone).toBeDefined()
    expect(toolDone![1].query).toBe('apple stock')
    expect(toolDone![1].formattedContent).toContain('Apple stock is at $180')

    const finalAnswer = sendCalls
      .filter(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_CHUNK)
      .map(([, val]) => val)
    expect(finalAnswer.join('')).toContain('Apple Stock is up today.')
  })

  it('Scenario 3: Max Search Loops Guard Verification', async () => {
    const mockSearchCallChunks = [
      'data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-search-x", "function": {"name": "brave_web_search", "arguments": "{\\"query\\":\\"weather\\"}"}}]}}]}\n',
      'data: [DONE]\n'
    ]
    const mockFinalAnswerChunks = [
      'data: {"choices": [{"delta": {"content": "Sunny weather."}}]}\n',
      'data: [DONE]\n'
    ]

    queueLlmResponse(mockSearchCallChunks)
    queueLlmResponse(mockFinalAnswerChunks)

    mockBraveSearch.mockResolvedValue([
      { title: 'Sunny in Cupertino', url: 'https://weather.com' }
    ])

    // Set max loops strictly to 1
    mockReadSettings.mockReturnValue({
      backendProvider: 'lmstudio',
      maxSearchLoops: 1,
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 1024,
      repeatPenalty: 1.1,
      braveSearchEnabled: true,
    })

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-3',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      model: 'qwen3.5-35b',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'qwen3.5-35b', mockWebContents)

    // First call uses tools normally. Second call forces synthesis.
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const secondFetchOptions = mockFetch.mock.calls[1][1]
    const secondBody = JSON.parse(secondFetchOptions.body)

    // Ensure the tool options are stripped on the final loop turn to force synthesis
    expect(secondBody.tools).toBeUndefined()
    
    // Ensure loop-limit system instructions were appended
    const lastMsg = secondBody.messages[secondBody.messages.length - 1]
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content).toContain('used all permitted web searches')
  })

  it('Scenario 4: Stream Repetition Loop Abort Safety Net', async () => {
    const mockRepeatingChunks = [
      'data: {"choices": [{"delta": {"content": "Infinite loop test.\\n"}}]}\n',
      'data: {"choices": [{"delta": {"content": "Infinite loop test.\\n"}}]}\n',
      'data: {"choices": [{"delta": {"content": "Infinite loop test.\\n"}}]}\n',
      'data: {"choices": [{"delta": {"content": "Infinite loop test.\\n"}}]}\n',
      'data: [DONE]\n'
    ]

    queueLlmResponse(mockRepeatingChunks)

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-4',
      messages: [{ role: 'user', content: 'Repetition abort test' }],
      model: 'qwen3.5-35b',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'qwen3.5-35b', mockWebContents)

    // Aborted stream should terminate cleanly
    expect(mockFetch).toHaveBeenCalledTimes(1)
    
    const sendCalls = mockWebContents.send.mock.calls
    const endEvent = sendCalls.find(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_END)
    expect(endEvent).toBeDefined()
    expect(endEvent![1].aborted).toBe(false) 
    expect(endEvent![1].totalTokens).toBeGreaterThan(0)
  })

  it('Scenario 5: Alternative Backend Providers (NVIDIA, OpenRouter, Ollama)', async () => {
    // 5.1 NVIDIA Build Provider
    mockFetch.mockClear()
    mockWebContents.send.mockClear()
    llmResponseQueue = []
    
    mockReadSettings.mockReturnValue({
      backendProvider: 'nvidia',
      nvidiaApiKey: 'nvapi-mock-key',
      maxOutputTokens: 2048,
    })

    const sseChunks = [
      'data: {"choices": [{"delta": {"content": "NVIDIA output."}}]}\n',
      'data: [DONE]\n'
    ]
    queueLlmResponse(sseChunks)

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-5-nvidia',
      messages: [{ role: 'user', content: 'Nvidia test' }],
      model: 'qwen3.5-35b-nvidia',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'qwen3.5-35b-nvidia', mockWebContents)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [endpointNvidia, optionsNvidia] = mockFetch.mock.calls[0]
    expect(endpointNvidia).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
    expect(optionsNvidia.headers['Authorization']).toBe('Bearer nvapi-mock-key')

    // 5.2 OpenRouter Provider
    mockFetch.mockClear()
    mockWebContents.send.mockClear()
    llmResponseQueue = []

    mockReadSettings.mockReturnValue({
      backendProvider: 'openrouter',
      openrouterApiKey: 'or-mock-key',
      maxOutputTokens: 2048,
    })
    queueLlmResponse(sseChunks)

    payload.chatId = 'chat-uuid-5-or'
    await chatService.send(payload, 'qwen3.5-35b-or', mockWebContents)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [endpointOr, optionsOr] = mockFetch.mock.calls[0]
    expect(endpointOr).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(optionsOr.headers['Authorization']).toBe('Bearer or-mock-key')

    // 5.3 Ollama Native NDJSON Provider
    mockFetch.mockClear()
    mockWebContents.send.mockClear()
    llmResponseQueue = []

    mockReadSettings.mockReturnValue({
      backendProvider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
    })

    const mockOllamaChunks = [
      '{"message": {"content": "Ollama text step 1\\n"}, "done": false}\n',
      '{"message": {"content": "Ollama step 2"}, "done": false}\n',
      '{"done": true, "eval_count": 15, "prompt_eval_count": 10}\n'
    ]
    queueLlmResponse(mockOllamaChunks)

    payload.chatId = 'chat-uuid-5-ollama'
    await chatService.send(payload, 'ollama-model', mockWebContents)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [endpointOllama, optionsOllama] = mockFetch.mock.calls[0]
    expect(endpointOllama).toBe('http://localhost:11434/api/chat')

    const bodyOllama = JSON.parse(optionsOllama.body)
    expect(bodyOllama.think).toBe(false)
    expect(bodyOllama.model).toBe('ollama-model')

    const sendCalls = mockWebContents.send.mock.calls
    const consolidated = sendCalls
      .filter(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_CHUNK)
      .map(([, val]) => val)
      .join('')
    expect(consolidated).toContain('Ollama text step 1\nOllama step 2')
  })

  it('Scenario 6: MCP Tool Permissions (Approval, Denials, Registry Blocks)', async () => {
    // 6.1 Approved MCP Tool Call
    const mockSSEChunks1 = [
      'data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-mcp-1", "function": {"name": "calculator__add", "arguments": "{\\"a\\":2,\\"b\\":3}"}}]}}]}\n',
      'data: [DONE]\n'
    ]
    const mockSSEChunks2 = [
      'data: {"choices": [{"delta": {"content": "Math result is 5."}}]}\n',
      'data: [DONE]\n'
    ]

    queueLlmResponse(mockSSEChunks1)
    queueLlmResponse(mockSSEChunks2)

    // Set schema so calculator__add is registered
    mockGetToolSchemas.mockReturnValue([
      { function: { name: 'calculator__add', description: 'Add two numbers' } }
    ])
    mockCallTool.mockResolvedValue({ text: '5', userNote: 'Approved' })

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-6-approved',
      messages: [{ role: 'user', content: 'What is 2+3?' }],
      model: 'qwen3.5-35b',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'qwen3.5-35b', mockWebContents)

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockCallTool).toHaveBeenCalledWith('calculator', 'add', { a: 2, b: 3 }, 'chat-uuid-6-approved')

    // 6.2 Blocked Unregistered Tool Call
    mockFetch.mockClear()
    mockCallTool.mockClear()
    mockWebContents.send.mockClear()
    llmResponseQueue = []

    const mockSSEChunksUnreg = [
      'data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-unreg-1", "function": {"name": "ghost_server__do_magic", "arguments": "{}"}}]}}]}\n',
      'data: [DONE]\n'
    ]
    queueLlmResponse(mockSSEChunksUnreg)
    mockGetToolSchemas.mockReturnValue([]) // Ghost tool is NOT in schema

    payload.chatId = 'chat-uuid-6-unregistered'
    await chatService.send(payload, 'qwen3.5-35b', mockWebContents)

    expect(mockCallTool).not.toHaveBeenCalled()
    const sendCallsUnreg = mockWebContents.send.mock.calls
    const toolStartUnreg = sendCallsUnreg.find(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_TOOL_START)
    expect(toolStartUnreg).toBeUndefined()

    // 6.3 Registered but Denied Tool Call (Throws McpDeniedError)
    mockFetch.mockClear()
    mockCallTool.mockClear()
    mockWebContents.send.mockClear()
    llmResponseQueue = []

    const mockSSEChunksDenied = [
      'data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-denied-1", "function": {"name": "fs__delete_file", "arguments": "{\\"path\\":\\"/etc/hosts\\"}"}}]}}]}\n',
      'data: [DONE]\n'
    ]
    const mockSSEChunksFinal = [
      'data: {"choices": [{"delta": {"content": "File deletion was denied."}}]}\n',
      'data: [DONE]\n'
    ]

    queueLlmResponse(mockSSEChunksDenied)
    queueLlmResponse(mockSSEChunksFinal)

    mockGetToolSchemas.mockReturnValue([
      { function: { name: 'fs__delete_file', description: 'Delete file' } }
    ])

    // User rejects the permission dialog
    mockCallTool.mockRejectedValue(new MockMcpDeniedError('Access denied by user'))

    payload.chatId = 'chat-uuid-6-denied'
    await chatService.send(payload, 'qwen3.5-35b', mockWebContents)

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const secondFetchBody = JSON.parse(mockFetch.mock.calls[1][1].body)
    const toolResultMessage = secondFetchBody.messages.find((m: any) => m.role === 'tool')
    expect(toolResultMessage).toBeDefined()
    expect(toolResultMessage.content).toContain('Denied: Access denied by user')
  })

  it('Scenario 7: Built-in Yahoo Finance stock ticker quote fetcher integration', async () => {
    const mockSSEChunks1 = [
      'data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-ticker-1", "function": {"name": "get_ticker_price", "arguments": "{\\"symbol\\":\\"AAPL\\"}"}}]}}]}\n',
      'data: [DONE]\n'
    ]
    const mockSSEChunks2 = [
      'data: {"choices": [{"delta": {"content": "Apple stock price is in the context."}}]}\n',
      'data: [DONE]\n'
    ]

    queueLlmResponse(mockSSEChunks1)
    queueLlmResponse(mockSSEChunks2)

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-7-ticker',
      messages: [{ role: 'user', content: 'Price of AAPL?' }],
      model: 'qwen3.5-35b',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'qwen3.5-35b', mockWebContents)

    // 2 LLM requests + 1 stock query fetch = 3 fetch calls total
    expect(mockFetch).toHaveBeenCalledTimes(3)
    
    const fetchUrls = mockFetch.mock.calls.map(([url]) => url)
    const yahooCall = fetchUrls.find((url) => url.includes('yahoo1.finance.yahoo.com') || url.includes('query1.finance.yahoo.com'))
    expect(yahooCall).toBeDefined()
    expect(yahooCall).toContain('AAPL')

    const sendCalls = mockWebContents.send.mock.calls
    const tickerDone = sendCalls.find(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_TICKER_DONE)
    expect(tickerDone).toBeDefined()
    expect(tickerDone![1].symbol).toBe('AAPL')
    expect(tickerDone![1].formattedContent).toContain('NASDAQ')
    expect(tickerDone![1].formattedContent).toContain('USD')
  })

  it('Scenario 8: Mid-Stream Tool Call Interception (Text Fallback)', async () => {
    mockFetch.mockClear()
    // LLM streams XML tag brave search tool call text inline in content stream
    const mockSSEChunks1 = [
      'data: {"choices": [{"delta": {"content": "Let me lookup: <tool_call>brave_web_search query=\\"tesla price\\" count=5</tool_call>"}}]}\n',
      'data: [DONE]\n'
    ]
    const mockSSEChunks2 = [
      'data: {"choices": [{"delta": {"content": "Tesla price is up."}}]}\n',
      'data: [DONE]\n'
    ]

    queueLlmResponse(mockSSEChunks1)
    queueLlmResponse(mockSSEChunks2)

    mockBraveSearch.mockResolvedValue([
      { title: 'Tesla stock is $200', url: 'https://finance.com/tesla' }
    ])

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-8-fallback',
      messages: [{ role: 'user', content: 'Tesla price?' }],
      model: 'qwen3.5-35b',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'qwen3.5-35b', mockWebContents)

    // Should perform mid-stream search and call LLM twice
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockBraveSearch).toHaveBeenCalledWith('tesla price', 'mock-api-key', 5)

    const sendCalls = mockWebContents.send.mock.calls
    const toolStart = sendCalls.find(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_TOOL_START)
    expect(toolStart).toBeDefined()
    expect(toolStart![1].query).toBe('tesla price')
  })

  it('Scenario 9: Missing API Keys and Error Responses', async () => {
    mockFetch.mockClear()
    mockWebContents.send.mockClear()

    // 9.1 Nvidia missing key
    mockReadSettings.mockReturnValue({
      backendProvider: 'nvidia',
      nvidiaApiKey: '', // Empty key
    })

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-9-nv-err',
      messages: [{ role: 'user', content: 'Test key' }],
      model: 'nvidia-model',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'nvidia-model', mockWebContents)
    const errEvent = mockWebContents.send.mock.calls.find(([channel]) => channel === IPC_CHANNELS.CHAT_ERROR)
    expect(errEvent).toBeDefined()
    expect(errEvent![1]).toContain('NVIDIA API key is not configured')

    // 9.2 OpenRouter missing key
    mockWebContents.send.mockClear()
    mockReadSettings.mockReturnValue({
      backendProvider: 'openrouter',
      openrouterApiKey: '', // Empty key
    })

    await chatService.send(payload, 'or-model', mockWebContents)
    const errEventOr = mockWebContents.send.mock.calls.find(([channel]) => channel === IPC_CHANNELS.CHAT_ERROR)
    expect(errEventOr).toBeDefined()
    expect(errEventOr![1]).toContain('OpenRouter API key is not configured')

    // 9.3 HTTP Non-ok status code
    mockWebContents.send.mockClear()
    mockReadSettings.mockReturnValue({
      backendProvider: 'lmstudio',
    })

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })

    await chatService.send(payload, 'lm-model', mockWebContents)
    const sendCalls = mockWebContents.send.mock.calls
    const errorEvent = sendCalls.find(([channel]) => channel === IPC_CHANNELS.CHAT_ERROR)
    expect(errorEvent).toBeDefined()
    expect(errorEvent![1]).toContain('LM Studio 500: Internal Server Error')

    // 9.4 Response has no body
    mockWebContents.send.mockClear()
    mockFetch.mockClear()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: null,
    })

    await chatService.send(payload, 'lm-model', mockWebContents)
    const errorEvent2 = mockWebContents.send.mock.calls.find(([channel]) => channel === IPC_CHANNELS.CHAT_ERROR)
    expect(errorEvent2).toBeDefined()
    expect(errorEvent2![1]).toContain('LM Studio returned no response body')
  })

  it('Scenario 10: Ollama Stream Parsing and Ollama Tool Calls', async () => {
    mockFetch.mockClear()
    mockReadSettings.mockReturnValue({
      backendProvider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaApiKey: 'ollama-key',
    })

    // Ollama streams JSON with tool call array
    const mockOllamaChunks = [
      '{"message": {"content": "", "tool_calls": [{"function": {"name": "brave_web_search", "arguments": {"query": "weather today"}}}]}, "done": false}\n',
      '{"done": true}\n'
    ]
    const mockOllamaChunksFinal = [
      '{"message": {"content": "Sunny today."}, "done": true}\n'
    ]

    queueLlmResponse(mockOllamaChunks)
    queueLlmResponse(mockOllamaChunksFinal)

    mockBraveSearch.mockResolvedValue([
      { title: 'Sunny', url: 'https://weather.com' }
    ])

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-10-ollama',
      messages: [{ role: 'user', content: 'Ollama weather' }],
      model: 'ollama-model',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'ollama-model', mockWebContents)

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const [endpoint, options] = mockFetch.mock.calls[0]
    expect(options.headers['Authorization']).toBe('Bearer ollama-key')
  })

  it('Scenario 11: Compacted Summary and Budget Trimming', async () => {
    mockFetch.mockClear()
    // 11.1 Compacted Summary
    mockReadSettings.mockReturnValue({
      backendProvider: 'lmstudio',
    })

    mockGetCompactedSummary.mockReturnValue('This is a compacted summary of previous chat history.')

    const mockSSEChunks = [
      'data: {"choices": [{"delta": {"content": "Answer based on summary."}}]}\n',
      'data: [DONE]\n'
    ]
    queueLlmResponse(mockSSEChunks)

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-11-summary',
      messages: [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second message' },
      ],
      model: 'lm-model',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'lm-model', mockWebContents)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockClearCompactedSummary).toHaveBeenCalledWith('chat-uuid-11-summary')
    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(requestBody.messages[1].role).toBe('assistant')
    expect(requestBody.messages[1].content).toBe('This is a compacted summary of previous chat history.')
    expect(requestBody.messages[2].content).toBe('/no_think\nSecond message')

    // Reset Compacted Summary mock
    mockGetCompactedSummary.mockReturnValue(null)

    // 11.2 Budget Trimming
    mockFetch.mockClear()
    llmResponseQueue = []

    mockReadSettings.mockReturnValue({
      backendProvider: 'lmstudio',
      contextLength: 2500, // extremely small context window
    })

    queueLlmResponse(mockSSEChunks)

    const longMessages = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `Message turn ${i} containing some descriptive text that consumes some virtual token budget. ` +
               `Message turn ${i} containing some descriptive text that consumes some virtual token budget. ` +
               `Message turn ${i} containing some descriptive text that consumes some virtual token budget. ` +
               `Message turn ${i} containing some descriptive text that consumes some virtual token budget.`,
    }))

    payload.messages = longMessages
    await chatService.send(payload, 'lm-model', mockWebContents)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const requestBodyTrimmed = JSON.parse(mockFetch.mock.calls[0][1].body)
    // Should have pruned some older messages
    expect(requestBodyTrimmed.messages.length).toBeLessThan(longMessages.length + 1)
  })

  it('Scenario 12: Vision Multipart Content and Gemma Prefills', async () => {
    mockFetch.mockClear()
    // 12.1 Vision payload content part builder
    mockReadSettings.mockReturnValue({
      backendProvider: 'lmstudio',
    })

    const mockSSEChunks = [
      'data: {"choices": [{"delta": {"content": "I see the image."}}]}\n',
      'data: [DONE]\n'
    ]
    queueLlmResponse(mockSSEChunks)

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-12-vision',
      messages: [{ role: 'user', content: 'What is this image?' }],
      attachments: [{ kind: 'image', dataUrl: 'data:image/png;base64,iVBORw0K', name: 'image.png' }],
      model: 'lm-model',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'lm-model', mockWebContents)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    const lastUserMessage = requestBody.messages[requestBody.messages.length - 1]
    expect(lastUserMessage.role).toBe('user')
    expect(Array.isArray(lastUserMessage.content)).toBe(true)
    expect(lastUserMessage.content[0].type).toBe('text')
    expect(lastUserMessage.content[1].type).toBe('image_url')
    expect(lastUserMessage.content[1].image_url.url).toBe('data:image/png;base64,iVBORw0K')

    // 12.2 Gemma MLX Assistant prefill thought channel prefill
    mockFetch.mockClear()
    llmResponseQueue = []

    queueLlmResponse(mockSSEChunks)
    payload.attachments = []
    payload.thinkingMode = 'thinking'
    payload.model = 'google-gemma-2-9b-mlx'
    
    // Model ID must contain gemma AND mlx
    await chatService.send(payload, 'google-gemma-2-9b-mlx', mockWebContents)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const requestBodyGemma = JSON.parse(mockFetch.mock.calls[0][1].body)
    const lastMessage = requestBodyGemma.messages[requestBodyGemma.messages.length - 1]
    expect(lastMessage.role).toBe('assistant')
    expect(lastMessage.content).toBe('<|channel>thought\n')
  })

  it('Scenario 13: Search Limit Text Fallback Safety Breaker', async () => {
    mockFetch.mockClear()
    mockWebContents.send.mockClear()
    // Set max search rounds to 1
    mockReadSettings.mockReturnValue({
      backendProvider: 'lmstudio',
      maxSearchLoops: 1,
      braveSearchEnabled: true,
    })

    // First turn: model calls tool brave search
    const mockSSEChunks1 = [
      'data: {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call-search-1", "function": {"name": "brave_web_search", "arguments": "{\\"query\\":\\"weather\\"}"}}]}}]}\n',
      'data: [DONE]\n'
    ]

    // Second turn: tools are stripped, but model *still* outputs a tool call in text stream fallback
    const mockSSEChunks2 = [
      'data: {"choices": [{"delta": {"content": "I must search again: <tool_call>brave_web_search query=\\" Cupertino weather \\"</tool_call>"}}]}\n',
      'data: [DONE]\n'
    ]

    queueLlmResponse(mockSSEChunks1)
    queueLlmResponse(mockSSEChunks2)

    mockBraveSearch.mockResolvedValue([
      { title: 'Sunny', url: 'https://weather.com' }
    ])

    const payload: ChatSendPayload = {
      chatId: 'chat-uuid-13-breaker',
      messages: [{ role: 'user', content: 'What is Cupertino weather?' }],
      model: 'qwen3.5-35b',
      thinkingMode: 'fast',
    }

    await chatService.send(payload, 'qwen3.5-35b', mockWebContents)

    // Should only call LLM twice, break on second loop, emit CHAT_ERROR and CHAT_STREAM_END
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const sendCalls = mockWebContents.send.mock.calls
    const chatError = sendCalls.find(([channel]) => channel === IPC_CHANNELS.CHAT_ERROR)
    expect(chatError).toBeDefined()
    expect(chatError![1]).toContain('search limit was reached')

    const endStream = sendCalls.find(([channel]) => channel === IPC_CHANNELS.CHAT_STREAM_END)
    expect(endStream).toBeDefined()
    expect(endStream![1].aborted).toBe(true)
  })
})
