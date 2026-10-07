/**
 * Multi-agent workers' built-in tools: the ticker tool is always offered and
 * reuses ChatService's TICKER_TOOL schema; Brave is still gated by settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const settings = { braveSearchEnabled: true, braveSearchApiKey: 'brave-key' }
vi.mock('electron', () => ({ app: { getPath: () => '/mock/userData' }, net: { fetch: vi.fn() } }))
vi.mock('../SettingsStore', () => ({ readSettings: () => settings, writeSettings: vi.fn() }))
vi.mock('../DatabaseService', () => ({ getCompactedSummary: () => null, clearCompactedSummary: vi.fn(), saveMessage: vi.fn(), getChatMessages: () => [] }))
const fetchTickerPrice = vi.fn()
vi.mock('../ChatService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ChatService')>()),
  fetchTickerPrice: (symbol: string) => fetchTickerPrice(symbol),
}))

import { workerBuiltinTools } from '../WorkerBuiltinTools'
import { TICKER_TOOL } from '../ChatService'

const names = () => workerBuiltinTools.getToolSchemas().map((t) => t.function.name)

beforeEach(() => {
  settings.braveSearchEnabled = true
  settings.braveSearchApiKey = 'brave-key'
  fetchTickerPrice.mockReset()
})

describe('workerBuiltinTools', () => {
  it('always offers the ticker tool; Brave only when enabled and keyed', () => {
    expect(names()).toEqual(['builtin__brave_web_search', 'builtin__get_ticker_price'])
    settings.braveSearchEnabled = false
    expect(names()).toEqual(['builtin__get_ticker_price'])
    settings.braveSearchEnabled = true
    settings.braveSearchApiKey = ''
    expect(names()).toEqual(['builtin__get_ticker_price'])
  })

  it('reuses TICKER_TOOL description and parameters, only renamed', () => {
    const tool = workerBuiltinTools.getToolSchemas().find((t) => t.function.name === 'builtin__get_ticker_price')!
    expect(tool.function.description).toBe(TICKER_TOOL.function.description)
    expect(tool.function.parameters).toEqual(TICKER_TOOL.function.parameters)
  })

  it('returns fetchTickerPrice text', async () => {
    fetchTickerPrice.mockResolvedValue('NVDA: $180.00')
    await expect(workerBuiltinTools.call('get_ticker_price', { symbol: 'NVDA' })).resolves.toBe('NVDA: $180.00')
    expect(fetchTickerPrice).toHaveBeenCalledWith('NVDA')
  })

  it('rejects an empty or non-string symbol and unknown tools', async () => {
    await expect(workerBuiltinTools.call('get_ticker_price', { symbol: ' ' })).rejects.toThrow('get_ticker_price needs a non-empty string symbol')
    await expect(workerBuiltinTools.call('get_ticker_price', { symbol: 42 })).rejects.toThrow('get_ticker_price needs a non-empty string symbol')
    await expect(workerBuiltinTools.call('get_ticker_price', {})).rejects.toThrow('get_ticker_price needs a non-empty string symbol')
    await expect(workerBuiltinTools.call('exec', {})).rejects.toThrow('Unknown built-in tool: exec')
    expect(fetchTickerPrice).not.toHaveBeenCalled()
  })
})
