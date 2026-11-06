import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import {
  buildExaRequest, effectiveSearchRounds, isDeepExaType, normalizeWebSearchSettings,
  EXA_MODES, EXA_TYPES, EXA_MAX_CHARACTERS_RANGE, EXA_NUM_RESULTS_RANGE, DEEP_SEARCH_MAX_ROUNDS,
} from '../../../../shared/webSearch'
import type { WebSearchProvider, WebSearchSettingsPayload } from '../../../../shared/webSearch'

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors duration-200 focus:outline-none ${
        checked ? 'bg-red-700' : 'bg-surface-border'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-ma-text shadow transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

/** "Br" / "Ex" provider tile (mockup tab 1). */
function Tile({ provider }: { provider: WebSearchProvider }) {
  return (
    <div className={cn(
      'w-8 h-8 rounded-lg grid place-items-center font-mono text-xs font-semibold flex-none',
      provider === 'exa' ? 'bg-[#7aa2f7]/[0.12] text-[#7aa2f7]' : 'bg-[#fb923c]/[0.12] text-[#fb923c]',
    )}>
      {provider === 'exa' ? 'Ex' : 'Br'}
    </div>
  )
}

const Section = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('px-5 pt-4 pb-[18px] border-t border-white/[0.05] flex flex-col gap-2.5 min-w-0', className)}>{children}</div>
)
const Label = ({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) => (
  <label htmlFor={htmlFor} className="text-xs font-medium text-content-secondary">{children}</label>
)
const Muted = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p data-testid={testId} className="text-xs text-content-muted leading-relaxed">{children}</p>
)
const Kv = ({ k, v }: { k: string; v: ReactNode }) => (
  <div className="flex justify-between gap-3 font-mono text-[11.5px] text-content-muted"><span>{k}</span><b className="text-white font-medium">{v}</b></div>
)

const segBtn = (on: boolean): string => cn(
  'text-left rounded-[10px] p-3 flex gap-2.5 items-start min-w-0 border-[0.5px] transition-colors',
  on ? 'border-red-600/60 bg-red-600/[0.12]' : 'border-white/[0.09] bg-[#111] hover:border-white/[0.18]',
)

const EMPTY: WebSearchSettingsPayload = {
  braveEnabled: false, braveApiKey: '', maxSearchLoops: 4, keepSearchResultsInContext: false,
  webSearchProvider: 'brave', exaApiKey: '', exaSearchType: 'auto', exaContentMode: 'highlights',
  exaMaxCharacters: 3000, exaNumResults: 5, exaFreshness: 'default',
}

function KeyField({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="flex gap-2">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 border border-surface-border rounded-lg px-3 py-2 text-sm font-mono text-white placeholder:text-content-muted focus:outline-none focus:border-red-800"
        style={{ background: '#111' }}
      />
      <button
        onClick={() => setShow((v) => !v)}
        className="px-3 py-2 text-xs text-content-muted border border-surface-border rounded-lg hover:text-white"
        style={{ background: '#111' }}
      >
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  )
}

export function MCPSettingsPanel() {
  // Persisted values — what's actually saved; draft — what the user is editing.
  const [saved, setSaved] = useState<WebSearchSettingsPayload>(EMPTY)
  const [draft, setDraft] = useState<WebSearchSettingsPayload>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<'saved' | 'error' | null>(null)

  useEffect(() => {
    window.api.mcpGetSettings()
      .then((s) => { const v = { ...EMPTY, ...s }; setSaved(v); setDraft(v) })
      .catch(console.error)
  }, [])

  const isDirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const set = <K extends keyof WebSearchSettingsPayload>(k: K, v: WebSearchSettingsPayload[K]): void => setDraft((d) => ({ ...d, [k]: v }))

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      await window.api.mcpSaveSettings(draft)
      setSaved({ ...draft })
      setSaveMsg('saved')
      setTimeout(() => setSaveMsg(null), 2500)
    } catch {
      setSaveMsg('error')
    } finally {
      setSaving(false)
    }
  }

  const isExa = draft.webSearchProvider === 'exa'
  const ws = normalizeWebSearchSettings(draft)
  const mode = EXA_MODES[ws.exaSearchType]
  const lite = ws.exaSearchType === 'lite'
  const deep = isDeepExaType(ws.exaSearchType)
  const rounds = effectiveSearchRounds(draft.maxSearchLoops, ws)
  // Active state reflects saved values — what actually affects chat.
  const savedKey = saved.webSearchProvider === 'exa' ? saved.exaApiKey : saved.braveApiKey
  const draftKey = isExa ? draft.exaApiKey : draft.braveApiKey
  const keyIsActive = saved.braveEnabled && saved.webSearchProvider === draft.webSearchProvider && savedKey.trim().length > 0
  const keyStatus = !draftKey.trim()
    ? <p className="text-xs text-amber-500">⚠ Enter your API key to activate web search</p>
    : keyIsActive && !isDirty ? <p className="text-xs text-emerald-500">✓ Web search active</p> : null

  return (
    <div className="space-y-8">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-content-muted">Web Search</h2>

      <div className="rounded-xl border border-surface-border/60 overflow-hidden" style={{ background: '#141414' }}>
        {/* Card header */}
        <div className="flex items-center justify-between gap-3.5 px-5 py-4">
          <div className="flex items-center gap-3">
            <Tile provider={draft.webSearchProvider} />
            <div>
              <p className="text-sm font-medium text-white">Web search</p>
              <p className="text-xs text-content-muted">Models that support tool calling search the web when needed</p>
            </div>
          </div>
          <Toggle checked={draft.braveEnabled} onChange={(v) => set('braveEnabled', v)} label="Enable web search" />
        </div>

        {draft.braveEnabled && (
          <>
            <Section>
              <Label>Provider</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="group" aria-label="Provider">
                {(['brave', 'exa'] as const).map((p) => (
                  <button key={p} data-provider={p} aria-pressed={draft.webSearchProvider === p} onClick={() => set('webSearchProvider', p)} className={segBtn(draft.webSearchProvider === p)}>
                    <Tile provider={p} />
                    <div>
                      <p className="text-[13px] font-medium text-white">{p === 'exa' ? 'Exa' : 'Brave Search'}</p>
                      <p className="text-xs text-content-muted">{p === 'exa' ? 'Neural search, page text included · from $4 / 1k' : 'Snippets, DI fetches top pages · $5 / 1k'}</p>
                    </div>
                  </button>
                ))}
              </div>
              <Muted>Only the selected provider is used. Keys for both can stay saved.</Muted>
            </Section>

            {!isExa && (
              <div data-testid="pane-brave">
                <Section>
                  <Label htmlFor="brave-key">API key</Label>
                  <KeyField id="brave-key" value={draft.braveApiKey} onChange={(v) => set('braveApiKey', v)} placeholder="BSA..." />
                  <Muted>
                    Get your API key at{' '}
                    <a href="https://brave.com/search/api" target="_blank" rel="noreferrer" className="text-red-500 hover:underline">brave.com/search/api</a>
                    {' '}· $5 per 1,000 queries
                  </Muted>
                  {keyStatus}
                  <Muted>Page fetch: on. Results are fetched in parallel (5 s timeout) because Brave snippets are short.</Muted>
                </Section>
              </div>
            )}

            {isExa && (
              <div data-testid="pane-exa">
                <Section>
                  <Label htmlFor="exa-key">API key</Label>
                  <KeyField id="exa-key" value={draft.exaApiKey} onChange={(v) => set('exaApiKey', v)} placeholder="exa_..." />
                  <Muted>
                    Create a key at{' '}
                    <a href="https://dashboard.exa.ai/api-keys" target="_blank" rel="noreferrer" className="text-red-500 hover:underline">dashboard.exa.ai/api-keys</a>
                    {' '}· new accounts start with free credits
                  </Muted>
                  {keyStatus}
                </Section>

                <Section>
                  <Label>Search depth</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Search depth">
                    {EXA_TYPES.map((t) => {
                      const m = EXA_MODES[t]
                      const on = ws.exaSearchType === t
                      return (
                        <button key={t} role="radio" aria-checked={on} data-type={t} onClick={() => set('exaSearchType', t)} className={cn(segBtn(on), 'flex-col gap-1')}>
                          <div className="flex justify-between gap-2 w-full items-baseline">
                            <b className="font-medium text-[13px] text-white">
                              {m.label}{t === 'auto' && <span className="ml-1.5 font-mono text-[9.5px] font-medium text-red-500 tracking-[0.04em]">DEFAULT</span>}
                            </b>
                            <span className="font-mono text-[11px] text-content-muted">{m.latency}</span>
                          </div>
                          <span className="font-mono text-[11px] text-content-muted">type: {t} · {m.price}</span>
                          <p className="text-[11.5px] text-content-muted leading-[1.45]">{m.desc}</p>
                        </button>
                      )
                    })}
                  </div>
                </Section>

                <Section>
                  <Label>What the model receives per result</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="group" aria-label="Content mode">
                    {([['highlights', 'Highlights', 'Query-relevant excerpts. Smallest context. Recommended.'], ['text', 'Full text', 'Page body, capped per result. Larger context.']] as const).map(([c, title, desc]) => (
                      <button key={c} data-content={c} aria-pressed={ws.exaContentMode === c} onClick={() => set('exaContentMode', c)} className={segBtn(ws.exaContentMode === c)}>
                        <div><p className="text-[13px] font-medium text-white">{title}</p><p className="text-xs text-content-muted">{desc}</p></div>
                      </button>
                    ))}
                  </div>
                  {ws.exaContentMode === 'text' && (
                    <div data-testid="max-chars">
                      <Kv k="Max characters per page" v={ws.exaMaxCharacters} />
                      <input type="range" aria-label="Max characters per page" min={EXA_MAX_CHARACTERS_RANGE[0]} max={EXA_MAX_CHARACTERS_RANGE[1]} step={500}
                        value={ws.exaMaxCharacters} onChange={(e) => set('exaMaxCharacters', Number(e.target.value))} className="w-full accent-red-700 cursor-pointer" />
                    </div>
                  )}
                  <Muted>Page text arrives with the results in one request. DI does not fetch pages itself when Exa is selected.</Muted>
                </Section>

                <Section>
                  <Kv k="Results per search" v={ws.exaNumResults} />
                  <input type="range" aria-label="Results per search" min={EXA_NUM_RESULTS_RANGE[0]} max={EXA_NUM_RESULTS_RANGE[1]} step={1}
                    value={ws.exaNumResults} onChange={(e) => set('exaNumResults', Number(e.target.value))} className="w-full accent-red-700 cursor-pointer" />
                  <div className="flex items-center justify-between gap-2 mt-1 flex-wrap">
                    <Label htmlFor="exa-fresh">Page freshness</Label>
                    <select
                      id="exa-fresh"
                      value={lite ? 'default' : ws.exaFreshness}
                      disabled={lite}
                      onChange={(e) => set('exaFreshness', e.target.value as WebSearchSettingsPayload['exaFreshness'])}
                      className="rounded-lg border-[0.5px] border-white/[0.09] bg-[#111] px-2.5 py-[7px] text-xs text-white disabled:opacity-40 focus:outline-none focus:border-red-800"
                    >
                      <option value="default">Default (cache, fetch if needed)</option>
                      <option value="24h">Newer than 24 hours</option>
                      <option value="always">Always fetch fresh</option>
                    </select>
                  </div>
                  <Muted testId="fresh-note">
                    {lite ? 'Fast serves cached pages only, so freshness control is off.' : 'Use “Always fetch fresh” for prices, scores and other live pages. It adds latency.'}
                  </Muted>
                </Section>

                <Section>
                  <div className="flex items-center justify-between gap-2">
                    <Label>Request preview</Label>
                    <span className="font-mono text-[10px] text-content-muted border-[0.5px] border-white/[0.09] rounded px-1.5 py-px">POST /search</span>
                  </div>
                  <pre data-testid="request-preview" className="m-0 max-w-full overflow-x-auto rounded-lg border-[0.5px] border-white/[0.09] bg-[#0c0c0c] p-3 font-mono text-[11px] leading-[1.55] text-white/60">
                    {JSON.stringify(buildExaRequest(ws, '<written by the model>', '<goal of this search turn>'), null, 2)}
                  </pre>
                  <Muted>
                    {lite ? 'Fast rejects outputSchema, systemPrompt and maxAgeHours with a 400, so DI never sends them in this mode.'
                      : deep ? 'The brief is passed to your model next to the sources, labelled as a synthesis to verify.'
                      : 'No synthesis step. Your model reads the results directly.'}
                  </Muted>
                  <Kv k="Cost" v={`$${mode.dollars.toFixed(3)} per search · up to $${(mode.dollars * rounds).toFixed(3)} per answer`} />
                </Section>
              </div>
            )}

            {/* Shared */}
            <Section>
              <Kv k="Max search rounds" v={draft.maxSearchLoops} />
              <input type="range" aria-label="Max search rounds" min={1} max={8} step={1} value={draft.maxSearchLoops}
                onChange={(e) => set('maxSearchLoops', Number(e.target.value))} className="w-full accent-red-700 cursor-pointer" />
              <Muted>How many times the model can search mid-response before being forced to answer. Default is 4.</Muted>
              {isExa && deep && draft.maxSearchLoops > DEEP_SEARCH_MAX_ROUNDS && (
                <p className="text-xs text-amber-500" data-testid="deep-rounds-warning">
                  ⚠ {mode.label} takes {mode.latency} per round. {draft.maxSearchLoops} rounds could wait up to {draft.maxSearchLoops * (ws.exaSearchType === 'deep' ? 15 : 4)} s. DI caps deep modes at {DEEP_SEARCH_MAX_ROUNDS} rounds.
                </p>
              )}
              {!(isExa && deep) && draft.maxSearchLoops > 5 && (
                <p className="text-xs text-amber-500">⚠ High value — each extra search round adds seconds and uses quota.</p>
              )}
            </Section>
            <Section>
              <div className="flex items-center justify-between gap-3.5">
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-white">Prior search results in context</p>
                  <Muted>Keep earlier results in the context window for multi-turn research, at the cost of more tokens.</Muted>
                </div>
                <Toggle checked={draft.keepSearchResultsInContext} onChange={(v) => set('keepSearchResultsInContext', v)} label="Prior search results in context" />
              </div>
            </Section>
          </>
        )}

        {/* Save */}
        <div className="px-5 py-3 border-t border-white/[0.05] flex items-center justify-between">
          {saveMsg === 'saved' && <span className="text-xs text-emerald-500">✓ Settings saved</span>}
          {saveMsg === 'error' && <span className="text-xs text-red-500">Failed to save</span>}
          {saveMsg === null && (isDirty ? <span className="text-xs text-amber-400">⚠ You have unsaved changes</span> : <span />)}
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className={cn(
              'px-4 py-1.5 rounded-lg text-xs font-medium transition-colors',
              isDirty && !saving ? 'bg-red-800 hover:bg-red-700 text-white' : 'bg-surface-border text-content-muted cursor-not-allowed',
            )}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-content-muted mb-3">Compatible Models</h2>
        <p className="text-xs text-content-muted leading-relaxed">
          Tool calling works with models trained for function calling. Confirmed working:
          Qwen3.5-35B-A3B-6bit, GLM-4.7-Flash, Gemma 4 26B A4B. The app detects tool call responses
          automatically — no manual configuration needed per model.
        </p>
      </div>
    </div>
  )
}
