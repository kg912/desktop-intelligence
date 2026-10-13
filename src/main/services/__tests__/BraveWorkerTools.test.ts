/**
 * Multi-agent workers' built-in web search: offered only when web search is
 * enabled and configured, executed through the same Brave search + page
 * augmentation as the single-chat brave_web_search path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const settings = { braveSearchEnabled: true, braveSearchApiKey: 'brave-key' }
const netFetch = vi.hoisted(() => ({ impl: async (): Promise<unknown> => { throw new Error('offline') } }))
vi.mock('electron', () => ({ net: { fetch: vi.fn((...a: unknown[]) => (netFetch.impl as (...x: unknown[]) => Promise<unknown>)(...a)) } }))
vi.mock('../SettingsStore', () => ({ readSettings: () => settings }))

import { augmentAndFormatResults, braveWorkerTools } from '../BraveSearchService'

const fetchMock = vi.fn()
beforeEach(() => {
  settings.braveSearchEnabled = true
  settings.braveSearchApiKey = 'brave-key'
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('braveWorkerTools', () => {
  it('offers builtin__brave_web_search only when enabled and a key is saved', () => {
    expect(braveWorkerTools.getToolSchemas().map((t) => t.function.name)).toEqual(['builtin__brave_web_search'])
    settings.braveSearchEnabled = false
    expect(braveWorkerTools.getToolSchemas()).toEqual([])
    settings.braveSearchEnabled = true
    settings.braveSearchApiKey = '  '
    expect(braveWorkerTools.getToolSchemas()).toEqual([])
  })

  it('searches with the saved key (5 results) and formats like single chat, falling back to snippets', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ web: { results: [{ title: 'Hotel **Füssen**', url: 'https://h.example', description: 'Near the castle' }] } }) })
    const text = await braveWorkerTools.call('brave_web_search', { query: 'hotels Füssen' })
    expect(text).toBe('[1] Hotel Füssen\nhttps://h.example\nNear the castle')
    const url = new URL(fetchMock.mock.calls[0][0] as string)
    expect(url.searchParams.get('q')).toBe('hotels Füssen')
    expect(url.searchParams.get('count')).toBe('5')
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers['X-Subscription-Token']).toBe('brave-key')
  })

  it('spec A Phase 7: with a fetched page, the worker result keeps Brave\'s snippet as the first body line; single chat does not', async () => {
    const page = '<html><body><p>' + 'The castle is open daily from nine to six, and tickets must be booked online in advance. '.repeat(3) + '</p></body></html>'
    netFetch.impl = async () => ({ ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => page })
    try {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ web: { results: [{ title: 'Castle', url: 'https://c.example', description: 'Opening hours' }] } }) })
      const worker = await braveWorkerTools.call('brave_web_search', { query: 'castle hours' })
      expect(worker.split('\n').slice(0, 4)).toEqual(['[1] Castle', 'https://c.example', 'Opening hours', expect.stringContaining('The castle is open daily')])
      const single = await augmentAndFormatResults([{ title: 'Castle', url: 'https://c.example', description: 'Opening hours' }])
      expect(single.split('\n')[2]).toContain('The castle is open daily')
    } finally {
      netFetch.impl = async () => { throw new Error('offline') }
    }
  })

  it('refuses unknown built-ins, an empty query and a missing key', async () => {
    await expect(braveWorkerTools.call('exec', {})).rejects.toThrow('Unknown built-in tool: exec')
    await expect(braveWorkerTools.call('brave_web_search', { query: ' ' })).rejects.toThrow('brave_web_search needs a non-empty query')
    settings.braveSearchApiKey = ''
    await expect(braveWorkerTools.call('brave_web_search', { query: 'x' })).rejects.toThrow('Brave Search is not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
