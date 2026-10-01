import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_MULTI_AGENT_CONFIG, type MultiAgentConfig, type ReasoningEffort, type SidecarStatus } from '../../../../shared/types'
import {
  DEFAULT_CATALOGUE_FILTER,
  filterModelCatalogue,
  type CatalogueFilter,
  type OpenRouterModelInfo,
} from '../../../../shared/multiAgentModels'
import { RunModelsSummary } from './RunModelsSummary'
import { Checkbox, Field, NumberInput, RangeSlider, Segmented, Select } from '../ui/controls'
import { ModelSelect } from '../ui/ModelSelect'

const ROLES: Array<{ key: keyof MultiAgentConfig['models']; label: string; hint: string }> = [
  { key: 'orchestrator', label: 'Orchestrator', hint: 'Plans the run. Needs reliable JSON output.' },
  { key: 'worker', label: 'Worker agents', hint: 'Every worker in a run uses this. It drives most of the cost.' },
  { key: 'reflection', label: 'Reflection', hint: 'Scores each worker output from 1 to 5.' },
  { key: 'synthesizer', label: 'Synthesizer', hint: 'Writes the final answer. Needs long context.' },
]

const MIN_CONTEXT_OPTIONS = [0, 8_000, 32_000, 64_000, 128_000, 200_000]
const EFFORTS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
]

type Config = MultiAgentConfig & { sidecarPort: number }

export function MultiAgentSettingsPanel() {
  const [config, setConfig] = useState<Config>({ ...DEFAULT_MULTI_AGENT_CONFIG, sidecarPort: 7823 })
  const [savedConfig, setSavedConfig] = useState<Config | null>(null)
  const [activeModel, setActiveModel] = useState('')
  const [catalogue, setCatalogue] = useState<OpenRouterModelInfo[]>([])
  const [catalogueError, setCatalogueError] = useState<string | null>(null)
  const [filter, setFilter] = useState<CatalogueFilter>(DEFAULT_CATALOGUE_FILTER)
  const [status, setStatus] = useState<SidecarStatus>('stopped')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void window.api.getMultiAgentConfig().then((c) => {
      setConfig(c)
      setSavedConfig(c)
    })
    void window.api.getBackendSettings().then((s) => setActiveModel(s?.openrouterModel ?? '')).catch(() => {})
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
  const catalogueIds = useMemo(() => (catalogue.length ? new Set(catalogue.map((m) => m.id)) : null), [catalogue])
  const unsaved = savedConfig !== null && JSON.stringify(savedConfig) !== JSON.stringify(config)

  const update = <K extends keyof Config>(key: K, value: Config[K]) => setConfig((c) => ({ ...c, [key]: value }))
  const save = async () => {
    setSaving(true)
    try {
      await window.api.saveMultiAgentConfig(config)
      setSavedConfig(config)
      setNotice('Saved. Applies to the next run.')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid grid-cols-2 gap-x-7 gap-y-[22px] text-ma-text" data-testid="multi-agent-settings">
      <div className="col-span-2">
        <h2 className="text-[20px] font-semibold">Multi-Agent Orchestration</h2>
        <p className="mt-1 text-[13px] text-ma-mute">
          OpenRouter only. Defaults for every multi-agent run. Sidecar{' '}
          <b data-testid="sidecar-status" className={status === 'running' ? 'font-medium text-ma-ok' : 'font-medium text-ma-soft'}>{status}</b>
        </p>
      </div>

      <div className="col-span-2">
        <RunModelsSummary models={config.models} activeModel={activeModel} catalogueIds={catalogueIds} />
      </div>

      <Field label="Max agents" value={config.maxAgents}>
        <RangeSlider aria-label="Max agents" value={config.maxAgents} min={1} max={8} onChange={(v) => update('maxAgents', v)} />
      </Field>
      <Field label="Per-run budget cap (USD)" htmlFor="ma-budget" help="Output length is limited only by this budget and the model's context window.">
        <NumberInput id="ma-budget" min={0} step="0.05" value={config.budgetCapUsd}
          onChange={(e) => update('budgetCapUsd', Math.max(0, Number(e.target.value) || 0))} />
      </Field>
      <Field label="Reflection pass threshold" value={config.reflectionPassThreshold}>
        <RangeSlider aria-label="Reflection pass threshold" value={config.reflectionPassThreshold} min={1} max={5} onChange={(v) => update('reflectionPassThreshold', v)} />
      </Field>
      <Field label="Max retries per agent" value={config.maxRetriesPerAgent}>
        <RangeSlider aria-label="Max retries per agent" value={config.maxRetriesPerAgent} min={0} max={5} onChange={(v) => update('maxRetriesPerAgent', v)} />
      </Field>
      <Field label="Approval timeout (minutes)" htmlFor="ma-timeout" help="Unanswered tool approvals are auto-denied after this.">
        <NumberInput id="ma-timeout" min={1} max={60} value={Math.round(config.hitlTimeoutMs / 60_000)}
          onChange={(e) => update('hitlTimeoutMs', Math.min(60, Math.max(1, Number(e.target.value) || 5)) * 60_000)} />
      </Field>
      <Field label="Sidecar port" htmlFor="ma-port" help="Loopback only. A busy port falls back to a free one.">
        <NumberInput id="ma-port" min={1024} max={65535} value={config.sidecarPort} onChange={(e) => update('sidecarPort', Number(e.target.value))} />
      </Field>
      <Field className="col-span-2" label="Worker reasoning" help="Requested from models that support it. Shown in each agent's trace; costs tokens.">
        <Segmented label="Worker reasoning" value={config.reasoningEffort} options={EFFORTS} onChange={(v) => update('reasoningEffort', v)} />
      </Field>

      <div className="col-span-2 border-t-[0.5px] border-white/5 pt-2.5 text-[13px] text-ma-mute">Models</div>
      <div className="col-span-2 flex flex-wrap items-center gap-[18px]">
        <Checkbox label="Requires tool-call support" checked={filter.requireTools} onChange={(e) => setFilter((f) => ({ ...f, requireTools: e.target.checked }))} />
        <Checkbox label="Sort by price" checked={filter.sortByPrice} onChange={(e) => setFilter((f) => ({ ...f, sortByPrice: e.target.checked }))} />
        <label className="flex items-center gap-2 text-[13px] text-ma-soft">
          Min context
          <Select aria-label="Min context" value={filter.minContext} className="!h-[30px] !w-[92px] font-mono text-[12.5px]"
            onChange={(e) => setFilter((f) => ({ ...f, minContext: Number(e.target.value) }))}>
            {MIN_CONTEXT_OPTIONS.map((n) => <option key={n} value={n}>{n === 0 ? 'any' : `${n / 1000}k`}</option>)}
          </Select>
        </label>
        <span className="ml-auto text-[12.5px] text-ma-mute">{filtered.length} of {catalogue.length} models</span>
      </div>
      {catalogueError && <p className="col-span-2 text-[12.5px] text-ma-amber">{catalogueError}</p>}

      {ROLES.map(({ key, label, hint }) => (
        <Field key={key} label={label} help={hint}>
          <ModelSelect label={`${label} model`} value={config.models[key]} models={filtered}
            onChange={(id) => update('models', { ...config.models, [key]: id })} />
        </Field>
      ))}

      <Checkbox className="col-span-2" label="Ask before every worker tool call, unless the agent is trusted for the run"
        checked={config.requirePermissions} onChange={(e) => update('requirePermissions', e.target.checked)} />

      <div className="col-span-2 flex items-center gap-3.5">
        <button onClick={() => void save()} disabled={saving}
          className="h-[34px] rounded-[7px] bg-ma-red px-4 text-[12.5px] font-medium text-white hover:bg-[#d8322e] disabled:opacity-50">
          {saving ? 'Saving…' : 'Save multi-agent defaults'}
        </button>
        {unsaved ? <span className="text-[12px] text-ma-mute">Unsaved changes</span> : notice && <span className="text-[12px] text-ma-mute">{notice}</span>}
      </div>
    </div>
  )
}
