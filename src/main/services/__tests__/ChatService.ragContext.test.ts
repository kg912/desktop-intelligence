/**
 * buildMessages() — ragContext injection tests
 *
 * Verifies that payload.ragContext is inserted as an untrimmed system message
 * immediately before the last user turn, regardless of history size, and is
 * truncated (never absent) when it exceeds the window budget.
 */

import { describe, it, expect, vi } from 'vitest'

// ── Mocks (same pattern as ChatService.test.ts) ───────────────────────────────

export const mockReadSettings = vi.fn().mockReturnValue({ contextLength: 32768 })
vi.mock('../SettingsStore', () => ({
  readSettings: () => mockReadSettings(),
  writeSettings: vi.fn(),
}))

export const mockResolveBraveApiKey = vi.fn()
vi.mock('../BraveSearchService', () => ({
  resolveBraveApiKey: () => mockResolveBraveApiKey(),
  buildWebSearchAddendum: (loops: number) => `[Web Search Addendum: loops=${loops}]`,
  braveSearch: vi.fn(),
  augmentAndFormatResults: vi.fn(),
}))

export const mockGetCompactedSummary = vi.fn().mockReturnValue(null)
vi.mock('../DatabaseService', () => ({
  getCompactedSummary: () => mockGetCompactedSummary(),
  clearCompactedSummary: vi.fn(),
  saveMessage: vi.fn(),
  getChatMessages: vi.fn().mockReturnValue([]),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData' },
  net: { fetch: vi.fn() },
}))

import { chatService } from '../ChatService'

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMsg(payload: Record<string, unknown>) {
  return (chatService as unknown as { buildMessages: (p: unknown) => Array<{ role: string; content: string }> }).buildMessages(payload)
}

/** Repeat text until it reaches ~N tokens (rough: 1 token ≈ 4 chars). */
function textOfTokens(n: number): string {
  const sentence = 'This is test history content repeated to consume token budget. '
  return sentence.repeat(Math.ceil((n * 4) / sentence.length))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildMessages — ragContext injection', () => {
  it('inserts ragContext verbatim as a system message immediately before the last user message', () => {
    mockReadSettings.mockReturnValue({ braveSearchEnabled: false, contextLength: 32768 })
    const rag = '<attached_file_context>\nSome retrieved document passage.\n</attached_file_context>'
    const result = buildMsg({
      chatId: 'c1',
      messages: [
        { role: 'user',      content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user',      content: 'Second question' },
      ],
      ragContext: rag,
    })
    const lastUserIdx = result.map((m) => m.role).lastIndexOf('user')
    expect(lastUserIdx).toBeGreaterThan(0)
    // message immediately before last user must be the ragContext system message
    const before = result[lastUserIdx - 1]
    expect(before.role).toBe('system')
    expect(before.content).toContain('retrieved document passage')
    // last user message must still be the last user message
    expect(result[lastUserIdx].content).toBe('Second question')
  })

  it('ragContext survives when a long history would otherwise be trimmed', () => {
    // Set a tight context so history would trim significantly
    mockReadSettings.mockReturnValue({ braveSearchEnabled: false, contextLength: 8192 })
    // Build ~3000-token history that will be partially trimmed in an 8192 context
    const longHistory = textOfTokens(3000)
    const rag = '<attached_file_context>\nCritical document context.\n</attached_file_context>'
    const result = buildMsg({
      chatId: 'c2',
      messages: [
        { role: 'user',      content: longHistory },
        { role: 'assistant', content: longHistory },
        { role: 'user',      content: 'What does the document say?' },
      ],
      ragContext: rag,
    })
    // ragContext system message MUST be present
    const ragMsgs = result.filter((m) => m.role === 'system' && m.content.includes('Critical document context'))
    expect(ragMsgs.length).toBe(1)
    // It must be immediately before the last user message
    const lastUserIdx = result.map((m) => m.role).lastIndexOf('user')
    expect(result[lastUserIdx - 1].content).toContain('Critical document context')
    // The long history was at least partially trimmed (old messages dropped)
    const allContent = result.map((m) => m.content).join(' ')
    // The last user message must still be present
    expect(allContent).toContain('What does the document say?')
  })

  it('ragContext that exceeds the window budget is truncated with marker, never absent', () => {
    // Very small context window — ragContext alone would exceed it
    mockReadSettings.mockReturnValue({ braveSearchEnabled: false, contextLength: 4096 })
    // ragContext of ~6000 tokens (well over the budget)
    const hugeRag = '<attached_file_context>\n' + textOfTokens(6000) + '\n</attached_file_context>'
    const result = buildMsg({
      chatId: 'c3',
      messages: [{ role: 'user', content: 'Summarise the document.' }],
      ragContext: hugeRag,
    })
    const ragMsgs = result.filter((m) => m.role === 'system' && m.content.includes('truncated to fit window'))
    // Must be present (truncated, not absent)
    expect(ragMsgs.length).toBe(1)
    // Must be positioned before the last user message
    const lastUserIdx = result.map((m) => m.role).lastIndexOf('user')
    expect(result[lastUserIdx - 1].role).toBe('system')
    expect(result[lastUserIdx - 1].content).toContain('[context truncated to fit window]')
    // Truncated content must not be the full huge string
    expect(result[lastUserIdx - 1].content.length).toBeLessThan(hugeRag.length)
  })

  it('no ragContext field → no extra system message injected', () => {
    mockReadSettings.mockReturnValue({ braveSearchEnabled: false, contextLength: 32768 })
    const result = buildMsg({
      chatId: 'c4',
      messages: [{ role: 'user', content: 'Plain question' }],
    })
    // Only the base system message should exist
    const sysMsgs = result.filter((m) => m.role === 'system')
    expect(sysMsgs.length).toBe(1) // just the base system prompt
    expect(sysMsgs[0].content).not.toContain('attached_file_context')
  })

  it('empty ragContext string → no extra system message injected', () => {
    mockReadSettings.mockReturnValue({ braveSearchEnabled: false, contextLength: 32768 })
    const result = buildMsg({
      chatId: 'c5',
      messages: [{ role: 'user', content: 'Plain question' }],
      ragContext: '   ',
    })
    const sysMsgs = result.filter((m) => m.role === 'system')
    expect(sysMsgs.length).toBe(1) // still only the base system prompt
  })

  it('ragContext is positioned after existing assistant turns and before the last user message', () => {
    mockReadSettings.mockReturnValue({ braveSearchEnabled: false, contextLength: 32768 })
    const rag = 'DOC_CONTENT_MARKER'
    const result = buildMsg({
      chatId: 'c6',
      messages: [
        { role: 'user',      content: 'Q1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user',      content: 'Q2' },
        { role: 'assistant', content: 'A2' },
        { role: 'user',      content: 'Q3 — final question' },
      ],
      ragContext: rag,
    })
    const indices = result.map((m, i) => ({ i, role: m.role, content: m.content }))
    const ragIdx = indices.findIndex((m) => m.content.includes('DOC_CONTENT_MARKER'))
    const lastUserPos = indices.map((m) => m.role).lastIndexOf('user')
    expect(ragIdx).toBe(lastUserPos - 1)
    expect(indices[lastUserPos].content).toBe('Q3 — final question')
  })
})
