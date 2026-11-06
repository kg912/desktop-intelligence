/**
 * Exa spec section 9: buildExaRequest per type (exact bodies), settings defaults and clamping,
 * isWebSearchReady for every provider/key combination, round and worker depth caps.
 */
import { describe, it, expect } from 'vitest'
import {
  buildExaRequest, effectiveSearchRounds, isWebSearchReady, isWebSearchToolName, normalizeWebSearchSettings,
  webSearchApiKey, workerExaType, EXA_SYNTHESIS_DESCRIPTION,
} from '../webSearch'
import type { WebSearchSettings } from '../webSearch'

const base: WebSearchSettings = {
  provider: 'exa', exaSearchType: 'auto', exaContentMode: 'highlights', exaMaxCharacters: 3000, exaNumResults: 5, exaFreshness: 'default',
}
const LITE_REJECTS = ['outputSchema', 'systemPrompt', 'maxAgeHours', 'summary', 'livecrawl', 'additionalQueries']

describe('buildExaRequest', () => {
  it('lite: exact body, never a parameter lite rejects (even with freshness set)', () => {
    for (const exaFreshness of ['default', '24h', 'always'] as const) {
      const body = buildExaRequest({ ...base, exaSearchType: 'lite', exaFreshness }, 'gpu prices')
      expect(body).toEqual({ query: 'gpu prices', type: 'lite', numResults: 5, contents: { highlights: true } })
      const json = JSON.stringify(body)
      for (const key of LITE_REJECTS) expect(json).not.toContain(key)
    }
  })

  it('auto: no outputSchema; freshness maps to maxAgeHours 24 and 0', () => {
    expect(buildExaRequest(base, 'q')).toEqual({ query: 'q', type: 'auto', numResults: 5, contents: { highlights: true } })
    expect(buildExaRequest({ ...base, exaFreshness: '24h' }, 'q').contents).toEqual({ highlights: true, maxAgeHours: 24 })
    expect(buildExaRequest({ ...base, exaFreshness: 'always' }, 'q').contents).toEqual({ highlights: true, maxAgeHours: 0 })
  })

  it('deep-lite and deep: text outputSchema with the spec description', () => {
    for (const type of ['deep-lite', 'deep'] as const) {
      expect(buildExaRequest({ ...base, exaSearchType: type }, 'q')).toEqual({
        query: 'q', type, numResults: 5, contents: { highlights: true },
        outputSchema: { type: 'text', description: EXA_SYNTHESIS_DESCRIPTION },
      })
    }
    expect(EXA_SYNTHESIS_DESCRIPTION).toBe('Concise evidence brief: key facts, figures and dates')
  })

  it('text mode sends maxCharacters instead of highlights', () => {
    expect(buildExaRequest({ ...base, exaContentMode: 'text', exaMaxCharacters: 4500 }, 'q').contents).toEqual({ text: { maxCharacters: 4500 } })
  })

  it('objective is trimmed and sent when non-empty; an explicit type overrides the setting (workers)', () => {
    expect(buildExaRequest(base, 'q', '  find NASA sources ')).toEqual({ query: 'q', objective: 'find NASA sources', type: 'auto', numResults: 5, contents: { highlights: true } })
    expect(buildExaRequest(base, 'q', '   ')).not.toHaveProperty('objective')
    expect(buildExaRequest({ ...base, exaSearchType: 'deep' }, 'q', undefined, 'auto')).toEqual({ query: 'q', type: 'auto', numResults: 5, contents: { highlights: true } })
  })

  it('numResults is clamped to 3-10 through the settings', () => {
    expect(buildExaRequest(normalizeWebSearchSettings({ webSearchProvider: 'exa', exaNumResults: 1 }), 'q').numResults).toBe(3)
    expect(buildExaRequest(normalizeWebSearchSettings({ webSearchProvider: 'exa', exaNumResults: 25 }), 'q').numResults).toBe(10)
    expect(buildExaRequest(normalizeWebSearchSettings({ webSearchProvider: 'exa', exaNumResults: 7.4 }), 'q').numResults).toBe(7)
  })
})

describe('normalizeWebSearchSettings', () => {
  it('an old settings file without the new fields gives Brave with the Exa defaults', () => {
    expect(normalizeWebSearchSettings({})).toEqual({
      provider: 'brave', exaSearchType: 'auto', exaContentMode: 'highlights', exaMaxCharacters: 3000, exaNumResults: 5, exaFreshness: 'default',
    })
  })

  it('clamps numbers and replaces unknown values with defaults', () => {
    expect(normalizeWebSearchSettings({
      webSearchProvider: 'google', exaSearchType: 'deep-research', exaContentMode: 'summary',
      exaMaxCharacters: 50_000, exaNumResults: 0, exaFreshness: 'hourly',
    })).toEqual({ provider: 'brave', exaSearchType: 'auto', exaContentMode: 'highlights', exaMaxCharacters: 10000, exaNumResults: 3, exaFreshness: 'default' })
    expect(normalizeWebSearchSettings({ exaMaxCharacters: 10, exaNumResults: Number.NaN }).exaMaxCharacters).toBe(1000)
    expect(normalizeWebSearchSettings({ exaNumResults: Number.NaN }).exaNumResults).toBe(5)
    expect(normalizeWebSearchSettings({ exaMaxCharacters: '4000' }).exaMaxCharacters).toBe(3000)
  })

  it('keeps every valid value', () => {
    expect(normalizeWebSearchSettings({
      webSearchProvider: 'exa', exaSearchType: 'deep-lite', exaContentMode: 'text', exaMaxCharacters: 1000, exaNumResults: 10, exaFreshness: 'always',
    })).toEqual({ provider: 'exa', exaSearchType: 'deep-lite', exaContentMode: 'text', exaMaxCharacters: 1000, exaNumResults: 10, exaFreshness: 'always' })
  })
})

describe('isWebSearchReady', () => {
  const cases: Array<[string, Parameters<typeof isWebSearchReady>[0], boolean, string | null]> = [
    ['brave (default provider) with a key', { braveSearchEnabled: true, braveSearchApiKey: 'bk' }, true, 'bk'],
    ['brave with only an Exa key', { braveSearchEnabled: true, webSearchProvider: 'brave', exaApiKey: 'ek' }, false, null],
    ['brave key of spaces', { braveSearchEnabled: true, braveSearchApiKey: '   ' }, false, null],
    ['exa with a key (trimmed)', { braveSearchEnabled: true, webSearchProvider: 'exa', exaApiKey: ' ek ' }, true, 'ek'],
    ['exa with only a Brave key', { braveSearchEnabled: true, webSearchProvider: 'exa', braveSearchApiKey: 'bk' }, false, null],
    ['exa with both keys', { braveSearchEnabled: true, webSearchProvider: 'exa', braveSearchApiKey: 'bk', exaApiKey: 'ek' }, true, 'ek'],
    ['disabled with both keys', { braveSearchEnabled: false, webSearchProvider: 'exa', braveSearchApiKey: 'bk', exaApiKey: 'ek' }, false, 'ek'],
    ['nothing saved', {}, false, null],
  ]
  for (const [name, s, ready, key] of cases) {
    it(name, () => {
      expect(isWebSearchReady(s)).toBe(ready)
      expect(webSearchApiKey(s)).toBe(key)
    })
  }
})

describe('round and depth caps', () => {
  it('deep types cap single-chat rounds at 2; other types and Brave keep the setting', () => {
    expect(effectiveSearchRounds(4, { provider: 'exa', exaSearchType: 'deep' })).toBe(2)
    expect(effectiveSearchRounds(4, { provider: 'exa', exaSearchType: 'deep-lite' })).toBe(2)
    expect(effectiveSearchRounds(1, { provider: 'exa', exaSearchType: 'deep' })).toBe(1)
    expect(effectiveSearchRounds(4, { provider: 'exa', exaSearchType: 'auto' })).toBe(4)
    expect(effectiveSearchRounds(4, { provider: 'brave', exaSearchType: 'deep' })).toBe(4)
  })

  it('workers run the lower of the selected type and auto', () => {
    expect(workerExaType('lite')).toBe('lite')
    expect(workerExaType('auto')).toBe('auto')
    expect(workerExaType('deep-lite')).toBe('auto')
    expect(workerExaType('deep')).toBe('auto')
  })

  it('web_search and the legacy brave_web_search are both web search tool names', () => {
    expect([isWebSearchToolName('web_search'), isWebSearchToolName('brave_web_search'), isWebSearchToolName('builtin__web_search'), isWebSearchToolName(undefined)])
      .toEqual([true, true, false, false])
  })
})
