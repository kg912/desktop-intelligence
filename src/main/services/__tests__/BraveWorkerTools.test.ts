/**
 * Multi-agent workers' built-in web search: offered only when web search is
 * enabled and configured, executed through the same Brave search + page
 * augmentation as the single-chat brave_web_search path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const settings = { braveSearchEnabled: true, braveSearchApiKey: 'brave-key' }
vi.mock('electron', () => ({ net: { fetch: vi.fn(async () => { throw new Error('offline') }) } }))
vi.mock('../SettingsStore', () => ({ readSettings: () => settings }))

import { braveWorkerTools } from '../BraveSearchService'

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

  it('refuses unknown built-ins, an empty query and a missing key', async () => {
    await expect(braveWorkerTools.call('exec', {})).rejects.toThrow('Unknown built-in tool: exec')
    await expect(braveWorkerTools.call('brave_web_search', { query: ' ' })).rejects.toThrow('brave_web_search needs a non-empty query')
    settings.braveSearchApiKey = ''
    await expect(braveWorkerTools.call('brave_web_search', { query: 'x' })).rejects.toThrow('Brave Search is not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
