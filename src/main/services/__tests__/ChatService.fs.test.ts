import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IPC_CHANNELS } from '../../../shared/types'
import type { ChatSendPayload } from '../../../shared/types'

// Same mocking style as ChatService.e2e.test.ts, plus a fake fsToolService.
const { mockFetch, mockReadSettings, fsMock, MockMcpDeniedError } = vi.hoisted(() => {
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
    MockMcpDeniedError,
    fsMock: {
      schemas: (_chatId: string): Array<{ type: 'function'; function: { name: string } }> => [],
      grants: [] as Array<{ path: string; access: 'read' | 'write'; askBeforeEdit: boolean }>,
      call: vi.fn(),
      cancelAll: vi.fn(),
    },
  }
})

vi.mock('electron', () => ({ app: { getPath: () => '/mock/userData' }, net: { fetch: (...a: any[]) => mockFetch(...a) } }))
vi.mock('../SettingsStore', () => ({ readSettings: () => mockReadSettings(), writeSettings: vi.fn() }))
vi.mock('../ObservabilityService', () => ({
  observabilityService: { startSession: vi.fn().mockReturnValue('obs'), endSession: vi.fn().mockResolvedValue(undefined), capture: vi.fn() },
}))
vi.mock('../McpServerManager', () => ({
  mcpServerManager: { getToolSchemas: () => [], callTool: vi.fn(), drainPendingPermissions: vi.fn() },
  McpDeniedError: MockMcpDeniedError,
  buildApprovedToolResult: (t: string) => t,
  buildDeniedToolMessage: (n: string) => `Denied: ${n}`,
}))
vi.mock('../BraveSearchService', () => ({ braveSearch: vi.fn(), augmentAndFormatResults: vi.fn(), resolveBraveApiKey: vi.fn().mockReturnValue('') }))
vi.mock('../DatabaseService', () => ({ getCompactedSummary: vi.fn().mockReturnValue(null), clearCompactedSummary: vi.fn() }))
vi.mock('../fs/fsAccessInstance', () => ({
  fsToolService: {
    getToolSchemas: (chatId: string) => fsMock.schemas(chatId),
    effectiveGrants: () => fsMock.grants,
    call: (...a: unknown[]) => fsMock.call(...a),
    cancelAll: () => fsMock.cancelAll(),
  },
}))

import { chatService, MAX_FS_CALLS_PER_TURN } from '../ChatService'
import { FS_TOOLS, FS_REQUEST_TOOL } from '../fs/fsToolSchemas'
import { FsToolError } from '../fs/FsToolService'

const sse = (chunks: string[]) => {
  let i = 0
  const enc = new TextEncoder()
  return { ok: true, status: 200, statusText: 'OK', body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined }) }) } }
}
const toolCalls = (calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): string[] => [
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((c, index) => ({ index, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] })}\n`,
  'data: [DONE]\n',
]
const answer = (text: string): string[] => [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`, 'data: [DONE]\n']

let queue: ReturnType<typeof sse>[]
let wc: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
const bodies = (): any[] => mockFetch.mock.calls.map(([, o]) => JSON.parse(o.body))
const fsNames = (body: any): string[] => (body.tools ?? []).map((t: any) => t.function.name).filter((n: string) => n.startsWith('fs_'))
const sent = (ch: string): any[] => wc.send.mock.calls.filter(([c]) => c === ch).map(([, v]) => v)
const payload = (chatId = 'chat-fs'): ChatSendPayload => ({ chatId, messages: [{ role: 'user', content: 'fix the typo' }], model: 'qwen', thinkingMode: 'fast' })

beforeEach(() => {
  vi.clearAllMocks()
  queue = []
  wc = { isDestroyed: () => false, send: vi.fn() }
  fsMock.schemas = () => []
  fsMock.grants = []
  mockReadSettings.mockReturnValue({ backendProvider: 'lmstudio', maxSearchLoops: 2, maxOutputTokens: 1024 })
  mockFetch.mockImplementation((url: string) => Promise.resolve(url.includes('completions') ? (queue.shift() ?? sse([])) : sse([])))
})
afterEach(() => chatService.abort())

describe('ChatService — file tools offered', () => {
  it('fs disabled or sandbox down: no fs tool and no FILE ACCESS section', async () => {
    queue.push(sse(answer('ok')))
    await chatService.send(payload(), 'qwen', wc as any)
    expect(fsNames(bodies()[0])).toEqual([])
    expect(bodies()[0].messages[0].content).not.toContain('FILE ACCESS\nGranted folders')
  })

  it('no grants: only fs_request_access, and the section says none yet (after the date line)', async () => {
    fsMock.schemas = () => [FS_REQUEST_TOOL]
    queue.push(sse(answer('ok')))
    await chatService.send(payload(), 'qwen', wc as any)
    expect(fsNames(bodies()[0])).toEqual(['fs_request_access'])
    const sys: string = bodies()[0].messages[0].content
    expect(sys).toContain('FILE ACCESS\nGranted folders: none yet\n')
    expect(sys.indexOf('FILE ACCESS\nGranted folders')).toBeGreaterThan(sys.indexOf('Current date'))
  })

  it('with a grant: all seven tools, and the section lists the roots exactly', async () => {
    fsMock.schemas = () => FS_TOOLS
    fsMock.grants = [{ path: '/Users/u/p', access: 'write', askBeforeEdit: true }]
    queue.push(sse(answer('ok')))
    await chatService.send(payload(), 'qwen', wc as any)
    expect(fsNames(bodies()[0])).toEqual(['fs_request_access', 'fs_list', 'fs_glob', 'fs_grep', 'fs_read', 'fs_edit', 'fs_write'])
    expect(bodies()[0].messages[0].content).toContain('Granted folders: /Users/u/p (read and write)\n')
  })
})

describe('ChatService — fs dispatch', () => {
  it('native: dispatches fs_read with the parsed args, sends toolArgs and toolDiff, and feeds the text to the model', async () => {
    fsMock.schemas = () => FS_TOOLS
    fsMock.call.mockResolvedValue({ text: 'File: /p/a.ts — lines 1–1 of 1.', diff: '--- a/a.ts' })
    queue.push(sse(toolCalls([{ id: 'c1', name: 'fs_read', args: { path: '/p/a.ts', offset: 2 } }])), sse(answer('done')))
    await chatService.send(payload(), 'qwen', wc as any)
    expect(fsMock.call).toHaveBeenCalledWith('fs_read', { path: '/p/a.ts', offset: 2 }, { chatId: 'chat-fs', maxChars: null })
    expect(sent(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE)).toEqual([
      { query: 'fs_read', toolName: 'fs_read', results: [], formattedContent: 'File: /p/a.ts — lines 1–1 of 1.', toolArgs: { path: '/p/a.ts', offset: 2 }, toolDiff: '--- a/a.ts' },
    ])
    const toolMsg = bodies()[1].messages.find((m: any) => m.role === 'tool')
    expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'File: /p/a.ts — lines 1–1 of 1.' })
  })

  it('passes the provider limit as maxChars (OpenRouter 50,000)', async () => {
    mockReadSettings.mockReturnValue({ backendProvider: 'openrouter', openrouterApiKey: 'k', openrouterModel: 'm', maxSearchLoops: 2 })
    fsMock.schemas = () => FS_TOOLS
    fsMock.call.mockResolvedValue({ text: 'x' })
    queue.push(sse(toolCalls([{ id: 'c1', name: 'fs_list', args: { path: '/p' } }])), sse(answer('done')))
    await chatService.send(payload(), 'm', wc as any)
    expect(fsMock.call.mock.calls[0][2]).toEqual({ chatId: 'chat-fs', maxChars: 50_000 })
  })

  it('an fs error reaches the model as the plain message and the UI as TOOL_ERROR', async () => {
    fsMock.schemas = () => FS_TOOLS
    fsMock.call.mockRejectedValue(new FsToolError('old_string was not found in /p/a.ts. Read the file again and copy the text exactly.'))
    queue.push(sse(toolCalls([{ id: 'c1', name: 'fs_edit', args: { path: '/p/a.ts', old_string: 'x', new_string: 'y' } }])), sse(answer('done')))
    await chatService.send(payload(), 'qwen', wc as any)
    expect(sent(IPC_CHANNELS.CHAT_STREAM_TOOL_ERROR)).toEqual([
      { query: 'fs_edit', toolName: 'fs_edit', error: 'old_string was not found in /p/a.ts. Read the file again and copy the text exactly.' },
    ])
    expect(bodies()[1].messages.find((m: any) => m.role === 'tool').content).toBe(
      'old_string was not found in /p/a.ts. Read the file again and copy the text exactly.'
    )
  })

  it('a denied edit approval goes through the existing denied path', async () => {
    fsMock.schemas = () => FS_TOOLS
    fsMock.call.mockRejectedValue(new MockMcpDeniedError(''))
    queue.push(sse(toolCalls([{ id: 'c1', name: 'fs_write', args: { path: '/p/a.ts', content: 'x' } }])), sse(answer('done')))
    await chatService.send(payload(), 'qwen', wc as any)
    expect(sent(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE)[0].formattedContent).toBe('[Denied] ')
    expect(bodies()[1].messages.find((m: any) => m.role === 'tool').content).toBe('Denied: ')
  })

  it('fs calls are not screened out when offered, but an unoffered fs tool is (registry screen)', async () => {
    fsMock.schemas = () => [FS_REQUEST_TOOL]
    queue.push(sse(toolCalls([{ id: 'c1', name: 'fs_read', args: { path: '/p/a.ts' } }])), sse(answer('done')))
    await chatService.send(payload(), 'qwen', wc as any)
    expect(fsMock.call).not.toHaveBeenCalled()
  })

  it('parallel fs calls with different arguments all run (not deduplicated by name)', async () => {
    fsMock.schemas = () => FS_TOOLS
    fsMock.call.mockResolvedValue({ text: 'ok' })
    queue.push(
      sse(toolCalls([
        { id: 'a', name: 'fs_read', args: { path: '/p/a.ts' } },
        { id: 'b', name: 'fs_read', args: { path: '/p/b.ts' } },
      ])),
      sse(answer('done'))
    )
    await chatService.send(payload(), 'qwen', wc as any)
    expect(fsMock.call.mock.calls.map((c) => c[1])).toEqual([{ path: '/p/a.ts' }, { path: '/p/b.ts' }])
  })

  it('after an approval mid-turn, the next iteration carries the six file tools', async () => {
    let granted = false
    fsMock.schemas = () => (granted ? FS_TOOLS : [FS_REQUEST_TOOL])
    fsMock.call.mockImplementation(async () => {
      granted = true
      return { text: 'Access granted: /p (read and write, this chat only).' }
    })
    queue.push(sse(toolCalls([{ id: 'r', name: 'fs_request_access', args: { path: '/p', access: 'write', reason: 'fix typo' } }])), sse(answer('done')))
    await chatService.send(payload(), 'qwen', wc as any)
    expect(fsNames(bodies()[0])).toEqual(['fs_request_access'])
    expect(fsNames(bodies()[1])).toEqual(['fs_request_access', 'fs_list', 'fs_glob', 'fs_grep', 'fs_read', 'fs_edit', 'fs_write'])
  })

  it(`caps file tool calls at ${60} per turn and forces the final answer`, async () => {
    expect(MAX_FS_CALLS_PER_TURN).toBe(60)
    fsMock.schemas = () => FS_TOOLS
    fsMock.call.mockResolvedValue({ text: 'ok' })
    const calls = Array.from({ length: 61 }, (_, i) => ({ id: `c${i}`, name: 'fs_read', args: { path: `/p/f${i}.ts` } }))
    queue.push(sse(toolCalls(calls)), sse(answer('done')))
    await chatService.send(payload(), 'qwen', wc as any)
    expect(fsMock.call).toHaveBeenCalledTimes(60)
    const toolMsgs = bodies()[1].messages.filter((m: any) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(61)
    expect(toolMsgs[60].content).toBe('File tool limit for this turn reached. Write your answer now.')
    expect(bodies()[1].tools).toBeUndefined()
  })

  it('text-stream fallback: dispatches an fs call written as text (it used to become "Unknown tool")', async () => {
    fsMock.schemas = () => FS_TOOLS
    fsMock.call.mockResolvedValue({ text: 'listing', diff: undefined })
    queue.push(
      sse(['data: {"choices":[{"delta":{"content":"<tool_call><function=fs_list><parameter=path>/p</parameter><parameter=depth>2</parameter></function></tool_call>"}}]}\n', 'data: [DONE]\n']),
      sse(answer('done'))
    )
    await chatService.send(payload(), 'qwen', wc as any)
    expect(fsMock.call).toHaveBeenCalledWith('fs_list', { path: '/p', depth: 2 }, { chatId: 'chat-fs', maxChars: null })
    expect(sent(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE)).toEqual([
      { query: 'fs_list', toolName: 'fs_list', results: [], formattedContent: 'listing', toolArgs: { path: '/p', depth: 2 } },
    ])
    expect(bodies()[1].messages.find((m: any) => m.role === 'tool').content).toBe('listing')
  })

  it('text-stream fallback: an fs error is the plain message', async () => {
    fsMock.schemas = () => FS_TOOLS
    fsMock.call.mockRejectedValue(new FsToolError('Read the file with fs_read before editing it.'))
    queue.push(
      sse(['data: {"choices":[{"delta":{"content":"<tool_call><function=fs_edit><parameter=path>/p/a</parameter><parameter=old_string>a</parameter><parameter=new_string>b</parameter></function></tool_call>"}}]}\n', 'data: [DONE]\n']),
      sse(answer('done'))
    )
    await chatService.send(payload(), 'qwen', wc as any)
    expect(bodies()[1].messages.find((m: any) => m.role === 'tool').content).toBe('Read the file with fs_read before editing it.')
  })

  it('abort() cancels file work and pending access dialogs', () => {
    chatService.abort()
    expect(fsMock.cancelAll).toHaveBeenCalled()
  })
})
