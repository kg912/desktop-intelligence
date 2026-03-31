import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { cn } from '../../lib/utils'

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none ${
        checked ? 'bg-red-700' : 'bg-surface-border'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

export function MCPSettingsPanel() {
  // Persisted values — what's actually saved
  const [saved, setSaved] = useState({ braveEnabled: false, braveApiKey: '' })
  // Draft values — what the user is currently editing
  const [draft, setDraft] = useState({ braveEnabled: false, braveApiKey: '' })

  const [showKey, setShowKey] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [saveMsg, setSaveMsg] = useState<'saved' | 'error' | null>(null)

  useEffect(() => {
    window.api.mcpGetSettings()
      .then(s => {
        setSaved(s)
        setDraft(s)
      })
      .catch(console.error)
  }, [])

  const isDirty = draft.braveEnabled !== saved.braveEnabled || draft.braveApiKey !== saved.braveApiKey

  const handleToggle = (v: boolean) => setDraft(d => ({ ...d, braveEnabled: v }))
  const handleKeyChange = (v: string) => setDraft(d => ({ ...d, braveApiKey: v }))

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      await window.api.mcpSaveSettings({
        braveEnabled: draft.braveEnabled,
        braveApiKey:  draft.braveApiKey,
      })
      setSaved({ ...draft })
      setSaveMsg('saved')
      setTimeout(() => setSaveMsg(null), 2500)
    } catch {
      setSaveMsg('error')
    } finally {
      setSaving(false)
    }
  }

  // Active state reflects saved values — what actually affects chat
  const keyIsActive = saved.braveEnabled && saved.braveApiKey.trim().length > 0

  return (
    <div className="space-y-8">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-content-muted">Web Search</h2>

      <div className="rounded-xl border border-surface-border/60 overflow-hidden" style={{ background: '#141414' }}>
        {/* Card header */}
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-orange-950/40 flex items-center justify-center">
              <Search size={15} className="text-orange-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Brave Search</p>
              <p className="text-xs text-content-muted">Real-time web search · Built-in</p>
            </div>
          </div>
          <Toggle checked={draft.braveEnabled} onChange={handleToggle} />
        </div>

        {/* Description */}
        <div className="px-5 pb-4 border-t border-surface-border/30">
          <p className="text-xs text-content-muted leading-relaxed pt-3">
            When enabled, models that support tool calling will automatically search
            the web for current information when needed. Brave Search is built into
            the app — no installation required.
          </p>
        </div>

        {/* Save button for toggle-only changes (no key section visible) */}
        {isDirty && !draft.braveEnabled && (
          <div className="px-5 pb-4 flex justify-end border-t border-surface-border/30 pt-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-red-800 hover:bg-red-700 text-white transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}

        {/* API key section — only when toggle is ON */}
        {draft.braveEnabled && (
          <div className="px-5 pb-5 space-y-3 border-t border-surface-border/30 pt-4">
            <label className="text-xs font-medium text-content-secondary">API Key</label>

            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={draft.braveApiKey}
                onChange={e => handleKeyChange(e.target.value)}
                placeholder="BSA..."
                className="flex-1 border border-surface-border rounded-lg px-3 py-2 text-sm font-mono text-white placeholder:text-content-muted focus:outline-none focus:border-red-800"
                style={{ background: '#111' }}
              />
              <button
                onClick={() => setShowKey(v => !v)}
                className="px-3 py-2 text-xs text-content-muted border border-surface-border rounded-lg hover:text-white"
                style={{ background: '#111' }}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>

            <p className="text-xs text-content-muted">
              Get your API key at{' '}
              <a
                href="https://brave.com/search/api"
                target="_blank"
                rel="noreferrer"
                className="text-red-500 hover:underline"
              >
                brave.com/search/api
              </a>
              {' '}· $5 per 1,000 queries
            </p>

            {!draft.braveApiKey && (
              <p className="text-xs text-amber-500">⚠ Enter your API key to activate web search</p>
            )}
            {keyIsActive && !isDirty && (
              <p className="text-xs text-emerald-500">✓ Web search active</p>
            )}
            {isDirty && (
              <p className="text-xs text-amber-400">⚠ You have unsaved changes</p>
            )}

            {/* Save button */}
            <div className="flex items-center justify-between pt-1">
              {saveMsg === 'saved' && (
                <span className="text-xs text-emerald-500">✓ Settings saved</span>
              )}
              {saveMsg === 'error' && (
                <span className="text-xs text-red-500">Failed to save</span>
              )}
              {saveMsg === null && <span />}

              <button
                onClick={handleSave}
                disabled={!isDirty || saving}
                className={cn(
                  'px-4 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  isDirty && !saving
                    ? 'bg-red-800 hover:bg-red-700 text-white'
                    : 'bg-surface-border text-content-muted cursor-not-allowed'
                )}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-content-muted mb-3">Compatible Models</h2>
        <p className="text-xs text-content-muted leading-relaxed">
          Tool calling works with models trained for function calling. Confirmed working:
          Qwen3.5-35B-A3B-6bit, GLM-4.7-Flash. The app detects tool call responses
          automatically — no manual configuration needed per model.
        </p>
      </div>
    </div>
  )
}
