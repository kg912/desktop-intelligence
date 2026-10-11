/**
 * Audit pins — exact-value guards written against the UNCHANGED source before
 * the ponytail-audit cleanups (getOpenRouterContextLength branch collapse,
 * stripThinkBlocks loop, buildMessages final-loop merge). Any behaviour drift
 * in those refactors fails here.
 */

export const mockReadSettings = vi.fn()
vi.mock('../SettingsStore', () => ({
  readSettings: () => mockReadSettings(),
  writeSettings: vi.fn(),
}))

vi.mock('../BraveSearchService', () => ({
  resolveBraveApiKey: () => undefined,
  buildWebSearchAddendum: (loops: number) => `[Web Search Addendum: loops=${loops}]`,
  braveSearch: vi.fn(),
  augmentAndFormatResults: vi.fn(),
}))

vi.mock('../DatabaseService', () => ({
  getCompactedSummary: () => null,
  clearCompactedSummary: vi.fn(),
  saveMessage: vi.fn(),
  getChatMessages: vi.fn().mockReturnValue([]),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData' },
  net: { fetch: vi.fn() },
}))

import { getOpenRouterContextLength, chatService } from '../ChatService'

const build = (payload: unknown, isCloud: boolean) =>
  (chatService as any).buildMessages(payload, isCloud) as Array<Record<string, unknown>>

beforeEach(() => {
  mockReadSettings.mockReturnValue({ braveSearchEnabled: false, keepSearchResultsInContext: true })
})

// ── P1 getOpenRouterContextLength ────────────────────────────────────────────

describe('P1 getOpenRouterContextLength', () => {
  it.each([
    ['deepseek/deepseek-v4-flash', 131072],
    ['anthropic/claude-sonnet-4', 200000],
    ['google/gemini-2.5-pro', 1000000],
    ['meta-llama/llama-3.3-70b', 131072],
    ['qwen/qwen3-235b', 131072],
    ['mistralai/mistral-large', 131072],
    ['x-ai/grok-4', 131072],
    ['microsoft/phi-4', 131072],
    ['some/unknown-model', 131072],
    ['', 131072],
    ['ANTHROPIC/CLAUDE-OPUS', 200000],
  ])('%s → %i', (id, expected) => {
    expect(getOpenRouterContextLength(id)).toBe(expected)
  })

  it('precedence: deepseek before claude, claude before gemini', () => {
    expect(getOpenRouterContextLength('x/deepseek-claude')).toBe(131072)
    expect(getOpenRouterContextLength('x/claude-gemini')).toBe(200000)
  })
})

// ── P2 buildMessages wire shape ──────────────────────────────────────────────

describe.each([false, true])('P2 buildMessages (isCloud=%s)', (isCloud) => {
  it('strips EOS from history and last user; vision parts in order; tool fields kept', () => {
    const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'brave_search', arguments: '{}' } }]
    const payload = {
      chatId: 'pin-chat',
      messages: [
        { role: 'user', content: 'hi<|EndOfText|> there' }, // literal lowercase <|endoftext|> in user/tool history makes tiktoken throw in countTokens (pre-existing)
        { role: 'assistant', content: 'call<|im_end|>', tool_calls: toolCalls },
        { role: 'tool', content: 'res<|eot_id|>', tool_call_id: 'call_1' },
        { role: 'assistant', content: 'done<|end|>' },
        { role: 'user', content: 'look<|IM_END|> at <|end|>this' },
      ],
      attachments: [
        { kind: 'image', dataUrl: 'data:image/png;base64,AAA' },
        { kind: 'pdf', name: 'x.pdf' },
        { kind: 'image', dataUrl: 'data:image/png;base64,BBB' },
      ],
    }
    const out = build(payload, isCloud)
    expect(out[0].role).toBe('system')
    expect(out.slice(1)).toEqual([
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'call', tool_calls: toolCalls },
      { role: 'tool', content: 'res', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'done' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
        ],
      },
    ])
  })

  it('without images the last user message stays a string, EOS-stripped', () => {
    const out = build({ chatId: 'pin-chat', messages: [{ role: 'user', content: 'q<|eot_id|>' }] }, isCloud)
    expect(out.slice(1)).toEqual([{ role: 'user', content: 'q' }])
  })

  it('non-string content in the standard path passes through unchanged (same reference)', () => {
    const arr = [{ type: 'text', text: 'keep<|im_end|>' }]
    const out = build({
      chatId: 'pin-chat',
      messages: [
        { role: 'user', content: arr },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next' },
      ],
    }, isCloud)
    expect(out[1].content).toBe(arr)
    expect(out[1].content).toEqual([{ type: 'text', text: 'keep<|im_end|>' }])
    expect(Object.keys(out[1])).toEqual(['role', 'content'])
  })
})

// ── P3 stripThinkBlocks (via assistant history in buildMessages) ─────────────

describe.each([false, true])('P3 stripThinkBlocks via buildMessages (isCloud=%s)', (isCloud) => {
  const assistantOut = (content: string): unknown => {
    const out = build({
      chatId: 'pin-chat',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content },
        { role: 'user', content: 'q2' },
      ],
    }, isCloud)
    return out.find((m) => m.role === 'assistant')!.content
  }

  it.each([
    ['closed <think>', 'A<think>x</think>B', 'AB'],
    ['unclosed <think> cut from open tag', 'Hi <think>partial', 'Hi'],
    ['two </think> split at the LAST', '<think>a</think>b</think>Answer', 'Answer'],
    ['Gemma closed', 'Pre<|channel>thought\nreason<channel|>Answer', 'PreAnswer'],
    ['Gemma unclosed', 'Ans <|channel>thought\nmore', 'Ans'],
    ['Gemma two closes split at the LAST', '<|channel>thought\na<channel|>b<channel|>Z', 'Z'],
    ['both formats', '<think>q</think>Mid <|channel>thought\ng<channel|> End', 'Mid  End'],
    ['EOS inside think', '<think>a<|im_end|>b</think>Answer<|endoftext|>', 'Answer'],
    ['EOS splitting a close tag is stripped first', '<think>r</th<|eot_id|>ink>Ans', 'Ans'],
    ['trim keeps inner whitespace', '  Before  <think>x</think>  After  ', 'Before    After'],
    ['no tags', 'plain answer', 'plain answer'],
    ['only a think block', '<think>all reasoning</think>', ''],
  ])('%s', (_name, input, expected) => {
    expect(assistantOut(input)).toBe(expected)
  })
})
