/**
 * Exa spec section 4: Settings > Web Search over IPC. Old settings files load with defaults; a save
 * is validated and clamped in the main process (bad enum values dropped, numbers clamped).
 */
import { describe, it, expect } from 'vitest'
import { sanitizeWebSearchPatch, webSearchSettingsPayload } from '../handlerHelpers'

describe('webSearchSettingsPayload', () => {
  it('an old settings file (Brave fields only) loads with Brave selected and the Exa defaults', () => {
    expect(webSearchSettingsPayload({ braveSearchEnabled: true, braveSearchApiKey: 'BSA1', maxSearchLoops: 3 })).toEqual({
      braveEnabled: true, braveApiKey: 'BSA1', maxSearchLoops: 3, keepSearchResultsInContext: false,
      webSearchProvider: 'brave', exaApiKey: '', exaSearchType: 'auto', exaContentMode: 'highlights',
      exaMaxCharacters: 3000, exaNumResults: 5, exaFreshness: 'default',
    })
  })

  it('an empty file gives every default', () => {
    expect(webSearchSettingsPayload({})).toMatchObject({ braveEnabled: false, braveApiKey: '', maxSearchLoops: 4, webSearchProvider: 'brave' })
  })

  it('saved Exa values come back as saved; out-of-range values on disk are clamped for display', () => {
    expect(webSearchSettingsPayload({ webSearchProvider: 'exa', exaApiKey: 'k', exaSearchType: 'deep', exaContentMode: 'text', exaMaxCharacters: 99_999, exaNumResults: 2, exaFreshness: '24h' }))
      .toMatchObject({ webSearchProvider: 'exa', exaApiKey: 'k', exaSearchType: 'deep', exaContentMode: 'text', exaMaxCharacters: 10000, exaNumResults: 3, exaFreshness: '24h' })
  })
})

describe('sanitizeWebSearchPatch', () => {
  it('maps a full valid save onto AppSettings field names', () => {
    expect(sanitizeWebSearchPatch({
      braveEnabled: true, braveApiKey: 'b', maxSearchLoops: 2, keepSearchResultsInContext: true,
      webSearchProvider: 'exa', exaApiKey: 'e', exaSearchType: 'deep-lite', exaContentMode: 'text', exaMaxCharacters: 1500, exaNumResults: 8, exaFreshness: 'always',
    })).toEqual({
      braveSearchEnabled: true, braveSearchApiKey: 'b', maxSearchLoops: 2, keepSearchResultsInContext: true,
      webSearchProvider: 'exa', exaApiKey: 'e', exaSearchType: 'deep-lite', exaContentMode: 'text', exaMaxCharacters: 1500, exaNumResults: 8, exaFreshness: 'always',
    })
  })

  it('drops unknown enum values (the saved value stays) and clamps numbers', () => {
    expect(sanitizeWebSearchPatch({
      webSearchProvider: 'bing' as never, exaSearchType: 'deep-research' as never, exaContentMode: 'summary' as never, exaFreshness: 'hourly' as never,
      exaMaxCharacters: 50, exaNumResults: 40, maxSearchLoops: 99,
    })).toEqual({ exaMaxCharacters: 1000, exaNumResults: 10, maxSearchLoops: 8 })
    expect(sanitizeWebSearchPatch({ maxSearchLoops: 0, exaNumResults: Number.NaN, exaMaxCharacters: '3000' as never })).toEqual({ maxSearchLoops: 1 })
  })

  it('leaves out undefined fields and wrong types, so writeSettings never erases a key', () => {
    expect(sanitizeWebSearchPatch({ exaApiKey: 'only-this' })).toEqual({ exaApiKey: 'only-this' })
    expect(sanitizeWebSearchPatch({ braveEnabled: 'yes' as never, braveApiKey: 5 as never })).toEqual({})
    expect(sanitizeWebSearchPatch({})).toEqual({})
  })
})
