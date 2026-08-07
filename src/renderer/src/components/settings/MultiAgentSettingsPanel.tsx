import { useEffect, useState } from 'react'
import { DEFAULT_MULTI_AGENT_CONFIG, type MultiAgentConfig } from '../../../../shared/types'

const ROLES: Array<keyof MultiAgentConfig['models']> = ['orchestrator', 'worker', 'reflection', 'synthesizer']

export function MultiAgentSettingsPanel() {
  const [config, setConfig] = useState<MultiAgentConfig>(DEFAULT_MULTI_AGENT_CONFIG)
  const [models, setModels] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void window.api.getMultiAgentConfig().then(setConfig)
    void window.api.getBackendSettings().then((settings) => {
      if (!settings.openrouterApiKey) return
      return window.api.getOpenRouterModels(settings.openrouterApiKey).then((result) => setModels(result.models ?? []))
    }).catch((err) => setNotice(err instanceof Error ? err.message : 'Could not load OpenRouter models'))
  }, [])

  const update = <K extends keyof MultiAgentConfig>(key: K, value: MultiAgentConfig[K]) => setConfig((current) => ({ ...current, [key]: value }))
  const save = async () => {
    setSaving(true)
    try { await window.api.saveMultiAgentConfig(config); setNotice('Saved for future multi-agent runs.') }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Save failed') }
    finally { setSaving(false) }
  }
  return <div className="space-y-6">
    <div><h2 className="text-base font-semibold text-content-primary">Multi-Agent Orchestration</h2><p className="mt-1 text-xs text-content-muted">OpenRouter role models and run guardrails. These defaults are applied when you enable Multi-Agent mode.</p></div>
    <div className="grid grid-cols-2 gap-4">
      <label className="text-xs text-content-secondary">Max agents (1–8)<input type="number" min={1} max={8} value={config.maxAgents} onChange={(e) => update('maxAgents', Math.max(1, Math.min(8, Number(e.target.value))))} className="mt-1 block w-full rounded border border-surface-border bg-surface-elevated px-2 py-1.5 text-content-primary" /></label>
      <label className="text-xs text-content-secondary">Budget cap (USD)<input type="number" min={0} step="0.01" value={config.budgetCapUsd} onChange={(e) => update('budgetCapUsd', Math.max(0, Number(e.target.value)))} className="mt-1 block w-full rounded border border-surface-border bg-surface-elevated px-2 py-1.5 text-content-primary" /></label>
      <label className="text-xs text-content-secondary">Reflection threshold (1–5)<input type="number" min={1} max={5} value={config.reflectionPassThreshold} onChange={(e) => update('reflectionPassThreshold', Math.max(1, Math.min(5, Number(e.target.value))))} className="mt-1 block w-full rounded border border-surface-border bg-surface-elevated px-2 py-1.5 text-content-primary" /></label>
      <label className="text-xs text-content-secondary">Retries per agent<input type="number" min={0} max={5} value={config.maxRetriesPerAgent} onChange={(e) => update('maxRetriesPerAgent', Math.max(0, Math.min(5, Number(e.target.value))))} className="mt-1 block w-full rounded border border-surface-border bg-surface-elevated px-2 py-1.5 text-content-primary" /></label>
    </div>
    <div className="space-y-3">{ROLES.map((role) => <label key={role} className="block text-xs capitalize text-content-secondary">{role} model<select value={config.models[role]} onChange={(e) => update('models', { ...config.models, [role]: e.target.value })} className="mt-1 block w-full rounded border border-surface-border bg-surface-elevated px-2 py-1.5 text-content-primary"><option value="">Use active OpenRouter model</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>)}</div>
    <label className="flex items-center gap-2 text-xs text-content-secondary"><input type="checkbox" checked={config.requirePermissions} onChange={(e) => update('requirePermissions', e.target.checked)} /> Require permission approvals for worker tools</label>
    <div className="flex items-center gap-3"><button onClick={() => void save()} disabled={saving} className="rounded bg-accent-700 px-3 py-1.5 text-xs text-white hover:bg-accent-600 disabled:opacity-50">{saving ? 'Saving…' : 'Save multi-agent defaults'}</button>{notice && <span className="text-xs text-content-muted">{notice}</span>}</div>
  </div>
}
