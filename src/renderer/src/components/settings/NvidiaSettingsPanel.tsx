/**
 * NvidiaSettingsPanel
 *
 * Lets the user switch between LM Studio and NVIDIA Build as the active
 * inference backend and configure the NVIDIA API key + model identifier.
 *
 * Switching providers requires an app restart — a banner is shown as soon
 * as the saved provider differs from the currently-running provider.
 */
import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, Eye, EyeOff, CheckCircle2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { BackendProvider } from '../../../../../shared/types'

interface BackendSettings {
  provider:     BackendProvider
  nvidiaApiKey: string
  nvidiaModel:  string
}

// The provider that was active when the app last started — used to decide
// whether to show the restart banner. We read it once from the IPC response
// on first mount; here we default to lmstudio conservatively.
let bootProvider: BackendProvider = 'lmstudio'

export function NvidiaSettingsPanel() {
  const [settings, setSettings]           = useState<BackendSettings>({
    provider:     'lmstudio',
    nvidiaApiKey: '',
    nvidiaModel:  'deepseek-ai/deepseek-v4-pro',
  })
  const [saved, setSaved]                 = useState(false)
  const [showKey, setShowKey]             = useState(false)
  const [loading, setLoading]             = useState(true)
  const [restartNeeded, setRestartNeeded] = useState(false)

  // Load saved settings on mount
  useEffect(() => {
    window.api.getBackendSettings().then((s) => {
      bootProvider = s.provider
      setSettings(s)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // Derive restart banner: show when saved provider != boot provider
  useEffect(() => {
    setRestartNeeded(settings.provider !== bootProvider)
  }, [settings.provider])

  const handleSave = useCallback(async () => {
    await window.api.saveBackendSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [settings])

  const update = <K extends keyof BackendSettings>(key: K, value: BackendSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  if (loading) {
    return <div className="text-sm text-content-muted">Loading…</div>
  }

  return (
    <div className="space-y-6">

      {/* Restart banner */}
      {restartNeeded && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-950/40 border border-amber-800/50">
          <AlertTriangle size={16} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-amber-300">
            Restart required for backend change to take effect.
          </p>
        </div>
      )}

      {/* Provider selector */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-content-primary">
          Inference Backend
        </label>
        <p className="text-xs text-content-muted">
          LM Studio runs models locally. NVIDIA Build uses the NVIDIA cloud API.
          Switching requires a restart.
        </p>
        <div className="flex gap-2 mt-2">
          {(['lmstudio', 'nvidia'] as BackendProvider[]).map((p) => (
            <button
              key={p}
              onClick={() => update('provider', p)}
              className={cn(
                'flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-colors',
                settings.provider === p
                  ? 'bg-accent-950/60 border-accent-700/60 text-accent-300'
                  : 'bg-surface-hover border-surface-border/40 text-content-secondary hover:text-content-primary',
              )}
            >
              {p === 'lmstudio' ? 'LM Studio' : 'NVIDIA Build'}
            </button>
          ))}
        </div>
      </div>

      {/* NVIDIA-specific fields — only visible when nvidia is selected */}
      {settings.provider === 'nvidia' && (
        <div className="space-y-4 pt-2 border-t border-surface-border/30">

          {/* API Key */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-content-primary">
              NVIDIA API Key
            </label>
            <p className="text-xs text-content-muted">
              Starts with <span className="font-mono">nvapi-</span>. Get one at{' '}
              <button
                onClick={() => window.api.openExternal('https://build.nvidia.com')}
                className="text-accent-500 hover:text-accent-400 underline underline-offset-2"
              >
                build.nvidia.com
              </button>
              .
            </p>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={settings.nvidiaApiKey}
                onChange={(e) => update('nvidiaApiKey', e.target.value)}
                placeholder="nvapi-…"
                className={cn(
                  'w-full px-3 py-2 pr-10 rounded-lg text-sm font-mono',
                  'border border-surface-border/50',
                  'placeholder:text-content-muted',
                  'focus:outline-none focus:ring-1 focus:ring-accent-600/60',
                )}
                style={{ background: '#111', color: '#f5f5f5' }}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-content-muted hover:text-content-primary transition-colors"
                tabIndex={-1}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Model ID */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-content-primary">
              Model
            </label>
            <p className="text-xs text-content-muted">
              NVIDIA Build model identifier, e.g.{' '}
              <span className="font-mono">deepseek-ai/deepseek-v4-pro</span>.
            </p>
            <input
              type="text"
              value={settings.nvidiaModel}
              onChange={(e) => update('nvidiaModel', e.target.value)}
              placeholder="deepseek-ai/deepseek-v4-pro"
              className={cn(
                'w-full px-3 py-2 rounded-lg text-sm font-mono',
                'border border-surface-border/50',
                'placeholder:text-content-muted',
                'focus:outline-none focus:ring-1 focus:ring-accent-600/60',
              )}
              style={{ background: '#111', color: '#f5f5f5' }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>
      )}

      {/* Save button */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          className={cn(
            'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            'bg-accent-700 hover:bg-accent-600 text-white',
          )}
        >
          Save
        </button>
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-emerald-400">
            <CheckCircle2 size={14} />
            Saved
          </span>
        )}
      </div>
    </div>
  )
}
