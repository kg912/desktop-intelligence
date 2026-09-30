import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_MULTI_AGENT_CONFIG, type MultiAgentConfig, type SidecarStatus } from '../../../../shared/types'
import {
  DEFAULT_CATALOGUE_FILTER,
  filterModelCatalogue,
  formatPricePerMillion,
  type CatalogueFilter,
  type OpenRouterModelInfo,
} from '../../../../shared/multiAgentModels'

const ROLES: Array<{ key: keyof MultiAgentConfig['models']; label: string; hint: string }> = [
  { key: 'orchestrator', label: 'Orchestrator', hint: 'Plans the run — needs reliable JSON output.' },
  { key: 'worker', label: 'Worker agents', hint: 'Used by every worker in a run — drives most of the cost.' },
  { key: 'reflection', label: 'Reflection', hint: 'Scores each worker output 1–5.' },
  { key: 'synthesizer', label: 'Synthesizer', hint: 'Writes the final answer — needs long context.' },
]

const MIN_CONTEXT_OPTIONS = [0, 8_000, 32_000, 64_000, 128_000, 200_000]

type Config = MultiAgentConfig & { sidecarPort: number }

export function MultiAgentSettingsPanel() {
  const [config, setConfig] = useState<Config>({ ...DEFAULT_MULTI_AGENT_CONFIG, sidecarPort: 7823 })
  const [catalogue, setCatalogue] = useState<OpenRouterModelInfo[]>([])
  const [catalogueError, setCatalogueError] = useState<string | null>(null)
  const [filter, setFilter] = useState<CatalogueFilter>(DEFAULT_CATALOGUE_FILTER)
  const [status, setStatus] = useState<SidecarStatus>('stopped')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void window.api.getMultiAgentConfig().then(setConfig)
    void window.api.getMultiAgentSidecarStatus().then(setStatus).catch(() => {})
    void window.api
      .getMultiAgentCatalogue()
      .then(({ models, error }) => {
        setCatalogue(models)
        setCatalogueError(error)
      })
      .catch((err: unknown) => setCatalogueError(err instanceof Error ? err.message : 'Could not load OpenRouter models'))
  }, [])

  const filtered = useMemo(() => filterModelCatalogue(catalogue, filter), [catalogue, filter])
  const byId = useMemo(() => new Map(catalogue.map((m) => [m.id, m])), [catalogue])

  const update = <K extends keyof Config>(key: K, value: Config[K]) => setConfig((c) => ({ ...c, [key]: value }))
  const save = async () => {
    setSaving(true)
    try {
      await window.api.saveMultiAgentConfig(config)
      setNotice('Saved — applies to the next multi-agent run.')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-content-primary">Multi-Agent Orchestration</h2>
        <p className="mt-1 text-xs text-content-muted">
          OpenRouter only. Role models, guardrails and approval defaults for multi-agent runs.
          Sidecar: <span data-testid="sidecar-status" className="text-content-secondary">{status}</span>
        </p>
      </div>

      <section className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Slider label="Max agents" value={config.maxAgents} min={1} max={8} onChange={(v) => update('maxAgents', v)} />
        <label className="text-xs text-content-secondary">
          Per-run budget cap (USD)
          <input
            type="number" min={0} step="0.05" value={config.budgetCapUsd}
            onChange={(e) => update('budgetCapUsd', Math.max(0, Number(e.target.value) || 0))}
            className="mt-1 block w-full rounded border border-surface-border bg-surface-elevated px-2 py-1.5 text-content-primary"
          />
        </label>
        <Slider label="Reflection pass threshold" value={config.reflectionPassThreshold} min={1} max={5} onChange={(v) => update('reflectionPassThreshold', v)} />
        <Slider label="Max retries per agent" value={config.maxRetriesPerAgent} min={1} max={5} onChange={(v) => update('maxRetriesPerAgent', v)} />
        <label className="text-xs text-content-secondary">
          Approval timeout (minutes)
          <input
            type="number" min={1} max={60} value={Math.round(config.hitlTimeoutMs / 60_000)}
            onChange={(e) => update('hitlTimeoutMs', Math.min(60, Math.max(1, Number(e.target.value) || 5)) * 60_000)}
            className="mt-1 block w-full rounded border border-surface-border bg-surface-elevated px-2 py-1.5 text-content-primary"
          />
          <span className="mt-1 block text-[10px] text-content-muted">Unanswered tool approvals are auto-denied after this.</span>
        </label>
        <label className="text-xs text-content-secondary">
          Sidecar port
          <input
            type="number" min={1024} max={65535} value={config.sidecarPort}
            onChange={(e) => update('sidecarPort', Number(e.target.value))}
            className="mt-1 block w-full rounded border border-surface-border bg-surface-elevated px-2 py-1.5 text-content-primary"
          />
          <span className="mt-1 block text-[10px] text-content-muted">Loopback only. A busy port falls back to a free one.</span>
        </label>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-4 text-xs text-content-secondary">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={filter.requireTools} onChange={(e) => setFilter((f) => ({ ...f, requireTools: e.target.checked }))} />
            Requires tool-call support
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={filter.sortByPrice} onChange={(e) => setFilter((f) => ({ ...f, sortByPrice: e.target.checked }))} />
            Sort by price
          </label>
          <label className="flex items-center gap-1.5">
            Min context
            <select
              value={filter.minContext}
              onChange={(e) => setFilter((f) => ({ ...f, minContext: Number(e.target.value) }))}
              className="rounded border border-surface-border bg-surface-elevated px-1.5 py-0.5 text-content-primary"
            >
              {MIN_CONTEXT_OPTIONS.map((n) => <option key={n} value={n}>{n === 0 ? 'any' : `${n / 1000}k`}</option>)}
            </select>
          </label>
          <span className="text-content-muted">{filtered.length} of {catalogue.length} models</span>
        </div>
        {catalogueError && <p className="text-xs text-amber-400">{catalogueError}</p>}

        {ROLES.map(({ key, label, hint }) => {
          const selected = config.models[key]
          const inList = !selected || filtered.some((m) => m.id === selected)
          return (
            <label key={key} className="block text-xs text-content-secondary">
              {label} model
              <select
                value={selected}
                onChange={(e) => update('models', { ...config.models, [key]: e.target.value })}
                className="mt-1 block w-full rounded border border-surface-border bg-surface-elevated px-2 py-1.5 text-content-primary"
              >
                <option value="">Use active OpenRouter model</option>
                {!inList && (
                  <option value={selected}>
                    {selected}{byId.get(selected) ? ` — ${formatPricePerMillion(byId.get(selected)!)}` : ' (not in catalogue)'}
                  </option>
                )}
                {filtered.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id} — {formatPricePerMillion(m)} · {Math.round(m.contextLength / 1000)}k ctx
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] text-content-muted">{hint}</span>
            </label>
          )
        })}
      </section>

      <label className="flex items-center gap-2 text-xs text-content-secondary">
        <input type="checkbox" checked={config.requirePermissions} onChange={(e) => update('requirePermissions', e.target.checked)} />
        Ask before every worker tool call (unless the agent is trusted for the run)
      </label>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="rounded bg-accent-700 px-3 py-1.5 text-xs text-white hover:bg-accent-600 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save multi-agent defaults'}
        </button>
        {notice && <span className="text-xs text-content-muted">{notice}</span>}
      </div>
    </div>
  )
}

function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="text-xs text-content-secondary">
      <span className="flex justify-between">
        {label} <span className="tabular-nums text-content-primary">{value}</span>
      </span>
      <input
        type="range" min={min} max={max} step={1} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 block w-full accent-red-700"
      />
    </label>
  )
}
