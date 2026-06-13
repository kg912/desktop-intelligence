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

describe('buildMessages — ragContext budget arithmetic', () => {
  // ── Regression: thinking mode (the exact production failure) ──────────────

  it('[regression] thinking mode: 6000-token ragContext is NOT truncated on 32k context', () => {
    // This is the exact scenario that failed: thinking mode sets maxOutputTokens=32768
    // which equalled contextLength, collapsing the old formula to the 512 floor.
    mockReadSettings.mockReturnValue({ braveSearchEnabled: false, contextLength: 32768 })
    const rag6k = '<attached_file_context>\n' + textOfTokens(6000) + '\n</attached_file_context>'
    const result = buildMsg({
      chatId: 'rt1',
      messages: [{ role: 'user', content: 'What are the benchmarking results?' }],
      ragContext: rag6k,
      thinkingMode: 'thinking',
    })
    const sysMsgs = result.filter((m) => m.role === 'system' && m.content.includes('attached_file_context'))
    expect(sysMsgs.length).toBe(1)
    // Must NOT contain the truncation marker
    expect(sysMsgs[0].content).not.toContain('[context truncated to fit window]')
    // Must be the full original content
    expect(sysMsgs[0].content).toBe(rag6k)
  })

  // ── Truncation uses correct budget, not a fixed 512 ───────────────────────

  it('truncation budget scales with context, never collapses to fixed 512', () => {
    // thinking mode at 32k context + 20k-token ragContext: old code truncated to
    // 512*4=2048 chars.  New code uses outputReservation=16384 → budget ~7000 tokens
    // → approxChars ~28000, well above the old 2048 ceiling.
    mockReadSettings.mockReturnValue({ braveSearchEnabled: false, contextLength: 32768 })
    const rag20k = '<attached_file_context>\n' + textOfTokens(20000) + '\n</attached_file_context>'
    const result = buildMsg({
      chatId: 'rt2',
      messages: [{ role: 'user', content: 'Summarise.' }],
      ragContext: rag20k,
      thinkingMode: 'thinking',
    })
    const sysMsgs = result.filter((m) => m.role === 'system' && m.content.includes('attached_file_context'))
    expect(sysMsgs.length).toBe(1)
    // Must be truncated (ragContext is 20k tokens, budget is ~7k)
    expect(sysMsgs[0].content).toContain('[context truncated to fit window]')
    // Truncated length must be >> old fixed 512*4=2048 chars
    expect(sysMsgs[0].content.length).toBeGreaterThan(512 * 8)
  })

  // ── Priority ordering: old history trimmed before ragContext is touched ────

  it('old conversation history is trimmed before ragContext is touched', () => {
    // Build a history where old messages are very large (well over historyBudget)
    // and only the last user message is small.  ragContext should survive intact.
    mockReadSettings.mockReturnValue({ braveSearchEnabled: false, contextLength: 32768 })
    const OLD_UNIQUE = 'SHOULD_BE_TRIMMED_OLD_HISTORY_MARKER'
    // ~12000-token old turn — far exceeds historyBudget (~7000) for 32k context
    const oldContent = textOfTokens(12000)
    const rag = '<attached_file_context>\nRAG_UNIQUE_MARKER\n</attached_file_context>'
    const result = buildMsg({
      chatId: 'rt3',
      messages: [
        { role: 'user',      content: OLD_UNIQUE + ' ' + oldContent },
        { role: 'assistant', content: oldContent },
        { role: 'user',      content: 'What is in the document?' },
      ],
      ragContext: rag,
    })
    const allContent = result.map((m) => m.content as string).join('\n')
    // Old messages must have been trimmed (too large for historyBudget)
    expect(allContent).not.toContain(OLD_UNIQUE)
    // ragContext must be present and intact — no truncation marker
    const ragMsg = result.find((m) => m.role === 'system' && m.content.includes('RAG_UNIQUE_MARKER'))
    expect(ragMsg).toBeDefined()
    expect(ragMsg!.content).not.toContain('[context truncated to fit window]')
    expect(ragMsg!.content).toBe(rag)
  })
})

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
