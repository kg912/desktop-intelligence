/**
 * Exa spec section 9 (UI): Settings > Web Search (provider switch, Fast disables freshness, request preview
 * equals buildExaRequest, save payload) and the search accordion (provider chip, legacy blocks, deep
 * synthesis, footer, Sent to model, searching timer, error chip). Mockup: specs/designs/exa-search-mockups.html.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { MCPSettingsPanel } from '../../renderer/src/components/settings/MCPSettingsPanel'
import { ToolCallNotification, SearchingIndicator } from '../../renderer/src/components/chat/ToolCallNotification'
import { MessageBubble } from '../../renderer/src/components/chat/MessageBubble'
import { buildExaRequest, normalizeWebSearchSettings } from '../../shared/webSearch'
import type { WebSearchSettingsPayload } from '../../shared/webSearch'

afterEach(() => { cleanup(); vi.useRealTimers() })

const SAVED: WebSearchSettingsPayload = {
  braveEnabled: true, braveApiKey: 'BSA-saved', maxSearchLoops: 4, keepSearchResultsInContext: false,
  webSearchProvider: 'brave', exaApiKey: '', exaSearchType: 'auto', exaContentMode: 'highlights',
  exaMaxCharacters: 3000, exaNumResults: 5, exaFreshness: 'default',
}
let save: ReturnType<typeof vi.fn>

beforeEach(() => {
  save = vi.fn(async () => {})
  ;(window as unknown as { api: unknown }).api = {
    mcpGetSettings: vi.fn(async () => ({ ...SAVED })),
    mcpSaveSettings: save,
    openExternal: vi.fn(async () => {}),
  }
})

async function renderPanel(): Promise<void> {
  render(<MCPSettingsPanel />)
  await waitFor(() => expect(screen.getByTestId('pane-brave')).toBeTruthy())
}

const preview = (): unknown => JSON.parse(screen.getByTestId('request-preview').textContent ?? '')

describe('Settings > Web Search', () => {
  it('an old settings payload shows the Brave pane with its saved key and "active"', async () => {
    await renderPanel()
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('BSA-saved')
    expect(screen.getByText('✓ Web search active')).toBeTruthy()
    expect(screen.queryByTestId('pane-exa')).toBeNull()
    expect(screen.getByRole('button', { name: /Brave Search/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('switching the provider shows only that pane; the Exa key prompt shows until a key is typed', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^Ex\s*Exa/ }))
    expect(screen.queryByTestId('pane-brave')).toBeNull()
    expect(screen.getByTestId('pane-exa')).toBeTruthy()
    expect(screen.getByText('⚠ Enter your API key to activate web search')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'exa-typed' } })
    expect(screen.queryByText('⚠ Enter your API key to activate web search')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Brave Search/ }))
    expect(screen.getByTestId('pane-brave')).toBeTruthy()
  })

  it('the request preview equals buildExaRequest for every depth, content mode and freshness', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^Ex\s*Exa/ }))
    const draft = { ...SAVED, webSearchProvider: 'exa' as const }
    const expectPreview = (over: Partial<WebSearchSettingsPayload>): void =>
      expect(preview()).toEqual(buildExaRequest(normalizeWebSearchSettings({ ...draft, ...over }), '<written by the model>', '<goal of this search turn>'))
    expectPreview({})
    fireEvent.change(screen.getByLabelText('Page freshness'), { target: { value: '24h' } })
    expectPreview({ exaFreshness: '24h' })
    expect((preview() as { contents: unknown }).contents).toEqual({ highlights: true, maxAgeHours: 24 })
    fireEvent.click(screen.getByRole('radio', { name: /Deep\s+DEFAULT|^Deep4–15 s/ }))
    expectPreview({ exaFreshness: '24h', exaSearchType: 'deep' })
    expect(preview()).toHaveProperty('outputSchema')
    fireEvent.click(screen.getByRole('button', { name: /Full text/ }))
    fireEvent.change(screen.getByLabelText('Max characters per page'), { target: { value: '6500' } })
    expectPreview({ exaFreshness: '24h', exaSearchType: 'deep', exaContentMode: 'text', exaMaxCharacters: 6500 })
    expect(screen.getByText(/\$0\.012 per search · up to \$0\.024 per answer/)).toBeTruthy() // deep: 2 rounds
  })

  it('Fast disables freshness, never previews maxAgeHours or outputSchema, and explains why', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^Ex\s*Exa/ }))
    fireEvent.change(screen.getByLabelText('Page freshness'), { target: { value: 'always' } })
    fireEvent.click(screen.getByRole('radio', { name: /^Fast/ }))
    const fresh = screen.getByLabelText('Page freshness') as HTMLSelectElement
    expect(fresh.disabled).toBe(true)
    expect(fresh.value).toBe('default')
    expect(preview()).toEqual({ query: '<written by the model>', objective: '<goal of this search turn>', type: 'lite', numResults: 5, contents: { highlights: true } })
    expect(screen.getByTestId('fresh-note').textContent).toBe('Fast serves cached pages only, so freshness control is off.')
    expect(screen.getByText('Fast rejects outputSchema, systemPrompt and maxAgeHours with a 400, so DI never sends them in this mode.')).toBeTruthy()
  })

  it('deep with more than 2 rounds warns about the cap; Save sends the whole draft once', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /^Ex\s*Exa/ }))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'exa-k' } })
    fireEvent.click(screen.getByRole('radio', { name: /^Deep-lite/ }))
    expect(screen.getByTestId('deep-rounds-warning').textContent).toBe('⚠ Deep-lite takes ~3-4 s per round. 4 rounds could wait up to 16 s. DI caps deep modes at 2 rounds.')
    fireEvent.change(screen.getByLabelText('Results per search'), { target: { value: '8' } })
    const button = screen.getByRole('button', { name: 'Save' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { fireEvent.click(button) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ ...SAVED, webSearchProvider: 'exa', exaApiKey: 'exa-k', exaSearchType: 'deep-lite', exaNumResults: 8 })
    expect(screen.getByText('✓ Settings saved')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('turning web search off hides the provider panes and still saves', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('switch', { name: 'Enable web search' }))
    expect(screen.queryByTestId('pane-brave')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(save).toHaveBeenCalledWith({ ...SAVED, braveEnabled: false })
  })
})

const RESULTS = [{ title: 'Webb highlights', url: 'https://esa.example/2025' }, { title: 'NASA Webb', url: 'https://nasa.example/webb' }]
const chip = (): HTMLElement => screen.getByTestId('provider-chip')

describe('search accordion', () => {
  it('a persisted block without provider renders as before, with the Brave chip only', () => {
    render(<ToolCallNotification phase="done" query="apple stock" toolName="brave_web_search" results={RESULTS} formattedContent="[1] …" />)
    expect(screen.getByText('Searched the web')).toBeTruthy()
    expect(screen.getByText('2 results')).toBeTruthy()
    expect(chip().textContent).toBe('Brave')
    expect(chip().getAttribute('data-provider')).toBe('brave')
    expect(screen.getByText('Webb highlights')).toBeTruthy()
    expect(screen.queryByTestId('search-footer')).toBeNull()
    expect(screen.queryByTestId('sent-to-model')).toBeNull()
    expect(screen.queryByTestId('search-synthesis')).toBeNull()
  })

  it('a pre-toolName block (query heuristic) is still a web search', () => {
    render(<ToolCallNotification phase="done" query="weather today" results={RESULTS} />)
    expect(screen.getByText('Searched the web')).toBeTruthy()
    expect(chip().textContent).toBe('Brave')
  })

  it('Exa auto: chip, footer from the response, Sent to model (collapsed) with the exact text', () => {
    render(<ToolCallNotification phase="done" query="JWST" toolName="web_search" results={RESULTS} formattedContent="[1] full text"
      provider="exa" mode="auto" contentMode="highlights" searchTimeMs={1340} costDollars={0.007} />)
    expect(chip().textContent).toBe('Exa · auto')
    expect(screen.getByTestId('search-footer').textContent).toBe('exa · type auto · 1.3 s · $0.007 · highlights')
    const sent = screen.getByTestId('sent-to-model') as HTMLDetailsElement
    expect(sent.open).toBe(false)
    expect(sent.querySelector('pre')?.textContent).toBe('[1] full text')
    expect(screen.queryByTestId('search-synthesis')).toBeNull()
  })

  it('Fast shows "fast"; Sent to model prefers the truncated string the model actually got', () => {
    render(<ToolCallNotification phase="done" query="q" toolName="web_search" results={RESULTS} formattedContent="long" sentToModel="lo[truncated]"
      provider="exa" mode="lite" contentMode="text" searchTimeMs={450} costDollars={0.004} />)
    expect(chip().textContent).toBe('Exa · fast')
    expect(screen.getByTestId('search-footer').textContent).toBe('exa · type lite · 0.5 s · $0.004 · full text')
    expect(screen.getByTestId('sent-to-model').querySelector('pre')?.textContent).toBe('lo[truncated]')
  })

  it('deep: the labelled synthesis with citation chips comes before the results', () => {
    render(<ToolCallNotification phase="done" query="q" toolName="web_search" results={RESULTS} formattedContent="x"
      provider="exa" mode="deep" synthesis={{ text: 'Webb confirmed X [1][3].', citations: [{ title: 'a', url: 'b' }] }} />)
    const s = screen.getByTestId('search-synthesis')
    expect(s.textContent).toBe('EXA SYNTHESIS · VERIFY AGAINST SOURCESWebb confirmed X 13.')
    expect([...s.querySelectorAll('p span')].map((e) => e.textContent)).toEqual(['1', '3'])
    expect(s.compareDocumentPosition(screen.getByText('Webb highlights')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('two searches in one turn (merged group) keep each one\'s synthesis, footer and Sent to model; old blocks get none', () => {
    const block = (id: string, extra: object) => ({ id, type: 'search', query: id, phase: 'done', toolName: 'web_search', results: RESULTS, ...extra })
    const message = { id: 'm', role: 'assistant', content: '', isThinking: false, isStreaming: false, isSearching: false, stats: null, error: null,
      blocks: [
        block('q1', { provider: 'exa', mode: 'deep', contentMode: 'highlights', searchTimeMs: 16_400, costDollars: 0.012,
          synthesis: { text: 'Deep answer [1].' }, formattedContent: 'full 1', sentToModel: 'sent 1' }),
        block('q2', { provider: 'exa', mode: 'deep', contentMode: 'highlights', searchTimeMs: 9_000, formattedContent: 'full 2' }),
        block('q3', {}),
      ] } as never
    render(<MessageBubble message={message} />)
    expect(screen.getByText('6 results · 3 searches')).toBeTruthy()
    expect(screen.getAllByTestId('search-synthesis').map((e) => e.textContent)).toEqual(['EXA SYNTHESIS · VERIFY AGAINST SOURCESDeep answer 1.'])
    expect(screen.getAllByTestId('search-footer').map((e) => e.textContent)).toEqual(['exa · type deep · 16.4 s · $0.012 · highlights', 'exa · type deep · 9.0 s · highlights'])
    expect(screen.getAllByTestId('sent-to-model').map((e) => e.querySelector('pre')?.textContent)).toEqual(['sent 1', 'full 2'])
  })

  it('Brave with provider metadata gets the Brave footer', () => {
    render(<ToolCallNotification phase="done" query="q" toolName="web_search" results={RESULTS} formattedContent="x" provider="brave" searchTimeMs={900} />)
    expect(screen.getByTestId('search-footer').textContent).toBe('brave · 2 results · page fetch on')
  })

  it('error: "Search failed", the chip and the mapped message', () => {
    render(<ToolCallNotification phase="error" query="H100 hourly rate" toolName="web_search" provider="exa" mode="auto"
      error="Exa API error 429: rate limited. Rate limit reached; retry in a moment." />)
    expect(screen.getByText('Search failed')).toBeTruthy()
    expect(chip().textContent).toBe('Exa · auto')
    expect(screen.getByText('Exa API error 429: rate limited. Rate limit reached; retry in a moment.')).toBeTruthy()
  })

  it('searching: Working, the chip and an elapsed timer; deep adds the duration note; old blocks keep plain Working', () => {
    vi.useFakeTimers()
    const { unmount } = render(<SearchingIndicator provider="exa" mode="deep" />)
    expect(screen.getByText('Working')).toBeTruthy()
    expect(chip().textContent).toBe('Exa · deep')
    expect(screen.getByTestId('search-elapsed').textContent).toBe('0.0 s')
    act(() => { vi.advanceTimersByTime(2_500) })
    expect(screen.getByTestId('search-elapsed').textContent).toBe('2.5 s')
    expect(screen.getByText('Deep search usually takes 4–15 s.')).toBeTruthy()
    unmount()
    render(<ToolCallNotification phase="searching" query="old" />)
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.queryByTestId('provider-chip')).toBeNull()
  })
})
