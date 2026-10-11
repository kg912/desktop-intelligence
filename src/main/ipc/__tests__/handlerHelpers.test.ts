import {
  cloudModelState,
  daemonReady,
  buildLmsLoadArgs,
  definedOnly,
  stripEosFromMessages,
} from '../handlerHelpers'

describe('cloudModelState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
  })
  afterEach(() => vi.useRealTimers())

  const state = (id: string, owned_by: string) => ({
    status: 'ready',
    modelInfo: { id, object: 'model', created: 0, owned_by },
    lastChecked: 1_700_000_000_000,
    error: null,
    pollIntervalMs: 0,
  })

  it.each([
    ['nvidia', {}, state('mistralai/mistral-medium-3.5-128b', 'nvidia')],
    ['nvidia', { nvidiaModel: 'n/m' }, state('n/m', 'nvidia')],
    ['ollama', {}, state('ollama', 'ollama')],
    ['ollama', { ollamaModel: 'llama3' }, state('llama3', 'ollama')],
    ['openrouter', {}, state('anthropic/claude-sonnet-4', 'openrouter')],
    ['openrouter', { openrouterModel: 'x/y' }, state('x/y', 'openrouter')],
    ['anything-else', { nvidiaModel: 'n', ollamaModel: 'o' }, state('anthropic/claude-sonnet-4', 'openrouter')],
  ])('%s %j', (bp, s, expected) => {
    expect(cloudModelState(s, bp)).toEqual(expected)
  })
})

describe('daemonReady', () => {
  it('returns a fresh ready state each call', () => {
    const a = daemonReady()
    expect(a).toEqual({ phase: 'ready', error: null, stderr: null })
    expect(daemonReady()).not.toBe(a)
  })
})

describe('buildLmsLoadArgs', () => {
  it('without GPU offload', () => {
    expect(buildLmsLoadArgs('m/id', false, 32768)).toEqual(['m/id', '--context-length', '32768'])
    expect(buildLmsLoadArgs('m/id', undefined, 4096)).toEqual(['m/id', '--context-length', '4096'])
  })
  it('with GPU offload', () => {
    expect(buildLmsLoadArgs('m/id', true, 65536)).toEqual(['m/id', '--gpu', 'max', '--context-length', '65536'])
  })
})

describe('definedOnly', () => {
  it('drops undefined, keeps null/0/empty/false, preserves key order', () => {
    const out = definedOnly({ a: undefined, b: null, c: 0, d: '', e: false, f: 'x', g: undefined })
    expect(out).toEqual({ b: null, c: 0, d: '', e: false, f: 'x' })
    expect(Object.keys(out)).toEqual(['b', 'c', 'd', 'e', 'f'])
    expect('a' in out).toBe(false)
  })
})

describe('stripEosFromMessages', () => {
  it('strips every EOS form (case-insensitive) and keeps other fields', () => {
    const m = { role: 'tool', content: 'a<|endoftext|>b<|IM_END|>c<|eot_id|>d<|end|>e', tool_call_id: 't1' }
    const [out] = stripEosFromMessages([m])
    expect(out).toEqual({ role: 'tool', content: 'abcde', tool_call_id: 't1' })
    expect(out).not.toBe(m)
    expect(m.content).toBe('a<|endoftext|>b<|IM_END|>c<|eot_id|>d<|end|>e')
  })

  it('returns the same reference for unchanged and non-string content', () => {
    const clean = { role: 'user', content: 'hello' }
    const arr = { role: 'user', content: [{ type: 'text', text: '<|endoftext|>' }] }
    const out = stripEosFromMessages([clean, arr])
    expect(out[0]).toBe(clean)
    expect(out[1]).toBe(arr)
  })

  it('leaves EOS in non-content fields', () => {
    const m = { role: 'assistant', content: 'ok', tool_calls: [{ id: '<|end|>' }] }
    expect(stripEosFromMessages([m])[0]).toBe(m)
  })

  it('is stable across repeated calls (global regex lastIndex)', () => {
    for (let i = 0; i < 3; i++) {
      expect(stripEosFromMessages([{ content: 'x<|end|>' }])[0].content).toBe('x')
    }
  })
})
