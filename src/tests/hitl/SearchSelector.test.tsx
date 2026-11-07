/**
 * specs/search-selector.md §6: the input-bar search selector (states, menu, saving, keyboard, multi-agent rules,
 * run lock, responsive label), the multi-agent provider display (run chip, worker Tools line, tool-call rows) and
 * the secrets rule for the selector. Mockup: specs/designs/search-selector-mockups.html (tabs 2–4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react'

// Same Preact-signals shim as InputBar.test.tsx (jsdom has no signals runtime).
vi.mock('@preact/signals-react/runtime', () => {
  const { useState, useEffect, useRef } = require('react')
  return {
    useSignals: () => {},
    useSignal: (init: any) => {
      const ref = useRef<any>(null)
      const [, forceUpdate] = useState(0)
      if (!ref.current) {
        ref.current = {
          _val: init,
          get value() { return this._val },
          set value(v) { this._val = v; forceUpdate((x: number) => x + 1) },
          peek() { return this._val },
        }
      }
      return ref.current
    },
    useSignalEffect: (cb: any) => { useEffect(() => { cb() }) },
    useComputed: (cb: any) => ({ get value() { return cb() }, peek() { return cb() } }),
  }
})

import { SearchSelector, MENU_WIDTH } from '../../renderer/src/components/layout/SearchSelector'
import { InputBar } from '../../renderer/src/components/layout/InputBar'
import { ModelStoreProvider } from '../../renderer/src/store/ModelStore'
import { MCPSettingsPanel } from '../../renderer/src/components/settings/MCPSettingsPanel'
import { MultiAgentSidebarView } from '../../renderer/src/components/chat/MultiAgentSidebarView'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent, McpToolPermissionRequest } from '../../shared/types'
import type { WebSearchSettingsPayload } from '../../shared/webSearch'

const EXA_KEY = 'exa-selector-key-SECRET-0b7f'
const BASE: WebSearchSettingsPayload = {
  braveEnabled: true, braveApiKey: 'brave-selector-key-SECRET', maxSearchLoops: 4, keepSearchResultsInContext: false,
  webSearchProvider: 'exa', exaApiKey: EXA_KEY, exaSearchType: 'auto', exaContentMode: 'highlights',
  exaMaxCharacters: 3000, exaNumResults: 5, exaFreshness: 'default',
}
let saved: WebSearchSettingsPayload
let save: ReturnType<typeof vi.fn>

beforeEach(() => {
  saved = { ...BASE }
  // The fake main process: a save merges the patch, the next read returns it (Settings reads the same fields).
  save = vi.fn(async (patch: Partial<WebSearchSettingsPayload>) => { saved = { ...saved, ...patch } })
  ;(window as any).api = {
    mcpGetSettings: vi.fn(async () => ({ ...saved })),
    mcpSaveSettings: save,
    getBackendSettings: vi.fn(async () => ({ provider: 'openrouter' })),
    setBypassPermissions: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
  }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const button = (): HTMLElement => screen.getByTestId('search-selector')
async function renderSelector(over: Partial<WebSearchSettingsPayload> = {}, props: Partial<Parameters<typeof SearchSelector>[0]> = {}) {
  saved = { ...BASE, ...over }
  const onOpenSettings = vi.fn()
  const r = render(<SearchSelector multiAgent={false} onOpenSettings={onOpenSettings} {...props} />)
  await waitFor(() => expect(button().getAttribute('aria-label')).toMatch(over.braveEnabled === false ? /off/ : /Web search/))
  // The state cache is module-level: wait for this test's read, not a previous test's value.
  await waitFor(() => expect((window as any).api.mcpGetSettings).toHaveBeenCalled())
  await act(async () => {})
  return { ...r, onOpenSettings }
}
const openMenu = async (): Promise<HTMLElement> => {
  fireEvent.click(button())
  return await screen.findByTestId('search-menu')
}
const options = (menu: HTMLElement): HTMLElement[] => within(menu).getAllByRole('menuitemradio')

describe('search selector: button states', () => {
  it.each([
    [{ webSearchProvider: 'brave' as const }, 'brave', 'Brave', 'Web search: Brave'],
    [{ exaSearchType: 'lite' as const }, 'exa', 'Exa · fast', 'Web search: Exa, Fast'],
    [{ exaSearchType: 'auto' as const }, 'exa', 'Exa · balanced', 'Web search: Exa, Balanced'],
    [{ exaSearchType: 'deep-lite' as const }, 'exa', 'Exa · deep-lite', 'Web search: Exa, Deep-lite'],
    [{ exaSearchType: 'deep' as const }, 'exa', 'Exa · deep', 'Web search: Exa, Deep'],
    [{ exaApiKey: '  ' }, 'warn', 'Exa · key needed', 'Web search: Exa, key needed'],
    [{ braveEnabled: false }, 'off', 'Search off', 'Web search: off'],
  ])('%o → %s "%s"', async (over, tone, label, name) => {
    await renderSelector(over)
    expect(button().dataset.tone).toBe(tone)
    expect(button().querySelector('.ib-label')?.textContent).toBe(label)
    expect(button().getAttribute('aria-label')).toBe(name)
    expect(button().title).toBe(name)
  })
})

describe('search selector: menu', () => {
  it('order: header, Brave heading-option, Exa heading, Fast, Balanced (DEFAULT), Deep-lite, Deep, settings link; the saved one is checked', async () => {
    await renderSelector({ exaSearchType: 'deep' })
    const menu = await openMenu()
    expect(menu.textContent).toMatch(/^Web searchsaved to Settings/)
    expect(options(menu).map((o) => o.querySelector('b')?.textContent)).toEqual(['Brave', 'Fast', 'Balanced', 'Deep-lite', 'Deep'])
    expect(options(menu).map((o) => o.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'false', 'true'])
    expect(within(menu).getByText('Neural search · page text included')).toBeTruthy()
    expect(within(menu).getByTestId('search-option-exa-auto').textContent).toContain('DEFAULT')
    expect(within(menu).getByTestId('search-option-exa-auto').textContent).toContain('~1 s · $7 / 1k')
    expect(within(menu).getByTestId('search-option-brave').textContent).toContain('$5 / 1k')
    expect(menu.lastElementChild?.textContent).toBe('Web Search settings›')
  })

  it('a pick saves only the changed fields through the settings IPC, closes, refocuses the button, and Settings shows it', async () => {
    await renderSelector({ exaSearchType: 'auto' })
    fireEvent.click(within(await openMenu()).getByTestId('search-option-exa-deep'))
    expect(save).toHaveBeenCalledWith({ webSearchProvider: 'exa', exaSearchType: 'deep' })
    expect(screen.queryByTestId('search-menu')).toBeNull()
    expect(document.activeElement).toBe(button())
    expect(button().querySelector('.ib-label')?.textContent).toBe('Exa · deep')
    fireEvent.click(within(await openMenu()).getByTestId('search-option-brave'))
    expect(save).toHaveBeenLastCalledWith({ webSearchProvider: 'brave' })
    cleanup()
    // Settings > Web Search reads the same saved fields: the pick is there.
    render(<MCPSettingsPanel />)
    await waitFor(() => expect(screen.getByTestId('pane-brave')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Brave Search/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a change made in Settings shows on the next open (read on every open)', async () => {
    await renderSelector({ exaSearchType: 'auto' })
    saved = { ...saved, exaSearchType: 'lite' }
    await openMenu()
    await waitFor(() => expect(button().querySelector('.ib-label')?.textContent).toBe('Exa · fast'))
  })

  it('search off: the menu says so and a pick turns web search on', async () => {
    await renderSelector({ braveEnabled: false })
    const menu = await openMenu()
    expect(within(menu).getByText('Web search is off in Settings. Picking a provider turns it on.')).toBeTruthy()
    expect(options(menu).every((o) => o.getAttribute('aria-checked') === 'false')).toBe(true)
    fireEvent.click(within(menu).getByTestId('search-option-exa-auto'))
    expect(save).toHaveBeenCalledWith({ webSearchProvider: 'exa', exaSearchType: 'auto', braveEnabled: true })
    expect(button().dataset.tone).toBe('exa')
  })

  it('no Exa key: the Exa options are disabled (not hidden) and "Add API key" opens Settings; Brave stays pickable', async () => {
    const { onOpenSettings } = await renderSelector({ exaApiKey: '' })
    const menu = await openMenu()
    expect(['lite', 'auto', 'deep-lite', 'deep'].map((t) => within(menu).getByTestId(`search-option-exa-${t}`).getAttribute('aria-disabled'))).toEqual(['true', 'true', 'true', 'true'])
    fireEvent.click(within(menu).getByTestId('search-option-exa-deep'))
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(within(menu).getByText('Add API key'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('search-menu')).toBeNull()
  })

  it('"Web Search settings ›" opens Settings', async () => {
    const { onOpenSettings } = await renderSelector()
    fireEvent.click(within(await openMenu()).getByTestId('search-open-settings'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('clamps inside a narrow bar: width shrinks to the bar minus 8 px each side', async () => {
    render(<div className="ib-cq"><div data-testid="bar"><SearchSelector multiAgent={false} /></div></div>)
    await waitFor(() => expect(button()).toBeTruthy())
    const rects = new Map<Element, Partial<DOMRect>>([
      [screen.getByTestId('bar'), { left: 100, top: 500, width: 300, height: 90 }],
      [button(), { left: 300, top: 560, width: 24, height: 18 }],
    ])
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { left: 0, top: 0, width: 0, height: 0, ...rects.get(this) } as DOMRect
    })
    const menu = await openMenu()
    expect(MENU_WIDTH).toBe(300)
    expect(menu.style.width).toBe('284px')
    expect(menu.style.left).toBe('108px')
    expect(menu.style.bottom).toBe(`${window.innerHeight - 500 + 8}px`)
  })
})

describe('search selector: keyboard and outside click', () => {
  it('Esc closes and returns focus; arrows move between enabled items only; outside mousedown closes', async () => {
    await renderSelector({ exaApiKey: '' })
    let menu = await openMenu()
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByTestId('search-option-brave')))
    // Only Brave is enabled without an Exa key: arrows stay on it.
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(menu).getByTestId('search-option-brave'))
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByTestId('search-menu')).toBeNull()
    expect(document.activeElement).toBe(button())

    menu = await openMenu()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('search-menu')).toBeNull()
  })

  it('multi-agent: arrows go Brave ↔ Balanced, skipping the locked depths', async () => {
    await renderSelector({ exaSearchType: 'auto' }, { multiAgent: true })
    const menu = await openMenu()
    const balanced = within(menu).getByTestId('search-option-exa-auto')
    await waitFor(() => expect(document.activeElement).toBe(balanced))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(menu).getByTestId('search-option-brave'))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(balanced)
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(within(menu).getByTestId('search-option-brave'))
  })
})

describe('search selector: multi-agent mode and the run lock', () => {
  it('a saved Deep shows the effective Balanced; Fast, Deep-lite and Deep are locked; the saved depth is kept until an explicit pick', async () => {
    await renderSelector({ exaSearchType: 'deep' }, { multiAgent: true })
    expect(button().querySelector('.ib-label')?.textContent).toBe('Exa · balanced')
    expect(button().getAttribute('aria-label')).toBe('Web search: Exa, Balanced')
    const menu = await openMenu()
    for (const t of ['lite', 'deep-lite', 'deep']) {
      const o = within(menu).getByTestId(`search-option-exa-${t}`)
      expect(o.getAttribute('aria-disabled')).toBe('true')
      expect(o.title).toBe('Multi-agent runs use Balanced')
    }
    expect(within(menu).getByTestId('search-option-exa-auto').getAttribute('aria-checked')).toBe('true')
    expect(within(menu).getByTestId('search-ma-note').textContent).toContain('Your saved depth, Deep, is kept for normal chats.')
    fireEvent.click(within(menu).getByTestId('search-option-exa-deep'))
    expect(save).not.toHaveBeenCalled()
    expect(saved.exaSearchType).toBe('deep')
    fireEvent.click(within(menu).getByTestId('search-option-exa-auto'))
    expect(save).toHaveBeenCalledWith({ webSearchProvider: 'exa', exaSearchType: 'auto' })
  })

  it('locked during an active run: aria-disabled, "Applies to the next run", never opens', async () => {
    await renderSelector({}, { multiAgent: true, locked: true })
    expect(button().getAttribute('aria-disabled')).toBe('true')
    expect(button().title).toBe('Applies to the next run')
    expect(button().getAttribute('aria-label')).toBe('Web search: Exa, Balanced')
    fireEvent.click(button())
    expect(screen.queryByTestId('search-menu')).toBeNull()
  })

  it('secrets: the selector renders and saves no API key', async () => {
    await renderSelector({ exaSearchType: 'deep' })
    fireEvent.click(within(await openMenu()).getByTestId('search-option-exa-auto'))
    const out = document.body.innerHTML + JSON.stringify(save.mock.calls)
    expect(out).not.toContain(EXA_KEY)
    expect(out).not.toContain(BASE.braveApiKey)
  })
})

describe('search selector in the input bar (responsive)', () => {
  it('sits right after the Multi-Agent button; the 420 px container rule hides its label and chevron; title and aria-label keep the text', async () => {
    render(<ModelStoreProvider><InputBar /></ModelStoreProvider>)
    const sel = await screen.findByTestId('search-selector')
    await waitFor(() => expect(screen.getByText('Multi-Agent')).toBeTruthy())
    expect(screen.getByText('Multi-Agent').closest('button')?.nextElementSibling).toBe(sel)
    expect(sel.querySelector('.ib-label')?.textContent).toBe('Exa · balanced')
    expect(sel.title).toBe('Web search: Exa, Balanced')
    const css = document.querySelector('[data-inputbar-styles]')?.textContent ?? ''
    const narrow = css.slice(css.indexOf('@container (max-width: 420px)'))
    // jsdom does not evaluate container queries: check the rule itself (no new breakpoint was added).
    expect(narrow).toMatch(/^@container \(max-width: 420px\) \{[\s\S]*\.ib-label \{[\s\S]*clip: rect\(0 0 0 0\)[\s\S]*\.ib-caret \{ display: none; \}\s*\}/)
    expect(css.match(/@container/g)).toHaveLength(2)
    expect(sel.querySelector('svg.ib-caret')).toBeTruthy()
  })
})

// ── Multi-agent provider display (mockup tab 4) ─────────────────────────────

let seq = 0
const ev = (e: Record<string, unknown>): AgentEvent => ({ runId: 'run-1', seq: ++seq, ts: 1_000 * seq, ...e }) as AgentEvent
const steps = [{ id: '1.1', label: 'Find winter opening hours', stage: 'worker', role: 'Researcher', model: 'openai/gpt-4o', phase: 1 }]
const runConfig = (webSearch: unknown) => ({
  type: 'run_config', models: DEFAULT_MULTI_AGENT_CONFIG.models, sources: {}, catalogueChecked: true, maxAgents: 2, budgetCapUsd: 0.5,
  reflectionPassThreshold: 3, maxRetriesPerAgent: 2, reasoningEffort: 'medium', tools: ['builtin__web_search', 'builtin__get_ticker_price'], webSearch,
})
const call = (id: string, search?: unknown) => [
  { type: 'tool_start', agentId: '1.1', attempt: 0, callId: id, tool: 'web_search', server: 'builtin', argsPreview: '{"query":"hours"}' },
  { type: 'tool_done', agentId: '1.1', attempt: 0, callId: id, ok: true, durationMs: 1700, resultPreview: '[1] Opening hours', resultChars: 16654, ...(search ? { search } : {}) },
]
const dockProps = {
  task: 't', config: { ...DEFAULT_MULTI_AGENT_CONFIG, budgetCapUsd: 0.5 }, readOnly: false,
  estimate: { minUsd: 0.04, maxUsd: 0.18, unpricedModels: [] }, permissionRequests: [] as McpToolPermissionRequest[],
  onRespondPermission: vi.fn(), onApprove: vi.fn(), onCancel: vi.fn(), onAbort: vi.fn(), focusAgentId: null as string | null, onSelectAgent: vi.fn(), onClose: vi.fn(),
}
function runView(extra: Array<Record<string, unknown>>) {
  seq = 0
  return reduceRunEvents('run-1', [ev({ type: 'orchestrator_plan', steps }), ...extra.map(ev)])
}
const expand = (id: string) => fireEvent.click(within(screen.getByTestId(`agent-card-${id}`)).getByRole('button', { expanded: false }))

describe('multi-agent provider display', () => {
  const exa = { provider: 'exa', type: 'auto', ms: 1600, costUsd: 0.007, results: 5 }

  it('run chip (snapshot), search count and summed cost; worker Tools line; chip on the tool row; expanded row details and Sent to model', () => {
    const v = runView([runConfig({ provider: 'exa', type: 'auto' }), { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm', attempt: 0 },
      ...call('c1', exa), ...call('c2', { ...exa, ms: 1200 })])
    render(<MultiAgentSidebarView {...dockProps} view={v} />)
    const group = screen.getByTestId('run-web-search')
    expect(within(group).getByTestId('provider-chip').textContent).toBe('Exa · balanced')
    expect(group.textContent).toBe('Web searchExa · balanced2 searches · $0.014')
    expand('1.1')
    const tools = screen.getByTestId('agent-tools-1.1')
    expect(tools.textContent).toBe('Tools: web_searchExa, +1')
    expect(within(tools).getByTestId('provider-chip').dataset.provider).toBe('exa')
    const trace = screen.getByTestId('agent-trace-1.1')
    const rows = within(trace).getAllByText('web_search').map((e) => e.closest('button')!)
    expect(rows.map((r) => within(r).getByTestId('provider-chip').textContent)).toEqual(['Exa', 'Exa'])
    fireEvent.click(rows[0])
    expect(within(trace).getByTestId('tool-search-meta').textContent).toBe('exa · type auto · 1.6 s · $0.007 · 5 results')
    const sent = within(trace).getByText('Sent to model · 16,654 chars')
    expect(sent.getAttribute('aria-expanded')).toBe('false')
    expect(within(trace).queryByText('[1] Opening hours')).toBeNull()
    fireEvent.click(sent)
    expect(within(trace).getByText('[1] Opening hours')).toBeTruthy()
  })

  it('Brave: chip "Brave", no cost; a running call shows the run snapshot chip before its record arrives', () => {
    const v = runView([runConfig({ provider: 'brave' }), { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm', attempt: 0 },
      ...call('c1', { provider: 'brave', ms: 13_700, costUsd: null, results: 5 }), call('c2')[0]])
    render(<MultiAgentSidebarView {...dockProps} view={v} />)
    expect(screen.getByTestId('run-web-search').textContent).toBe('Web searchBrave1 search')
    expand('1.1')
    const trace = screen.getByTestId('agent-trace-1.1')
    const rows = within(trace).getAllByText('web_search').map((e) => e.closest('button')!)
    expect(rows.map((r) => within(r).getByTestId('provider-chip').textContent)).toEqual(['Brave', 'Brave'])
    fireEvent.click(rows[0])
    expect(within(trace).getByTestId('tool-search-meta').textContent).toBe('brave · 5 results · 13.7 s')
  })

  it('the run chip is the snapshot: a later Settings change does not reach a run view; no snapshot (older trace) shows no group', () => {
    const v = runView([runConfig({ provider: 'exa', type: 'auto' })])
    saved = { ...saved, webSearchProvider: 'brave' }
    const { unmount } = render(<MultiAgentSidebarView {...dockProps} view={v} />)
    expect(within(screen.getByTestId('run-web-search')).getByTestId('provider-chip').textContent).toBe('Exa · balanced')
    unmount()
    render(<MultiAgentSidebarView {...dockProps} view={runView([runConfig(undefined)])} />)
    expect(screen.queryByTestId('run-web-search')).toBeNull()
    expand('1.1')
    expect(screen.getByTestId('agent-tools-1.1').textContent).toBe('Tools: web_search, +1')
  })
})
