/**
 * BackendSettingsPanel (NvidiaSettingsPanel.tsx)
 *
 * Three-way provider selector: LM Studio | Ollama | NVIDIA Build
 *
 * - LM Studio: no extra fields (managed via the Model tab)
 * - Ollama: base URL + optional API key + model dropdown (live-fetched from /api/tags)
 * - NVIDIA Build: API key + free-text model ID (legacy, no enumeration API)
 *
 * Switching providers requires an app restart — a banner appears as soon as
 * the in-memory provider differs from the one that was active at boot.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { AlertTriangle, Eye, EyeOff, RefreshCw, TrendingUp, Type, Image, Video, AudioLines, FileText } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { BackendProvider, BackendSettings } from '../../../../../shared/types'

// ── OpenRouter account stats ─────────────────────────────────────────────────
interface ORCredits { total_credits: number; total_usage: number }

function OpenRouterStats({ apiKey }: { apiKey: string }) {
  const [credits, setCredits] = useState<ORCredits | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const fetchStats = useCallback(async (key: string) => {
    if (!key) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.getOpenRouterStats(key)
      if (result.error) throw new Error(result.error)
      setCredits(result.credits)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchStats(apiKey) }, [apiKey, fetchStats])

  const balance = credits ? (credits.total_credits - credits.total_usage).toFixed(2) : null

  if (!apiKey) return null

  return (
    <div className="space-y-2 pt-3 border-t border-surface-border/30">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-content-secondary uppercase tracking-wider">Account</span>
        {!error && (
          <button
            onClick={() => fetchStats(apiKey)}
            disabled={loading}
            className="flex items-center gap-1 text-xs text-content-muted hover:text-content-primary transition-colors disabled:opacity-40"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Fetching…' : 'Refresh'}
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-center justify-between py-1">
          <span className="text-xs text-content-muted">Account stats are not available at the moment</span>
          <button
            onClick={() => fetchStats(apiKey)}
            disabled={loading}
            className="flex items-center gap-1 text-xs text-accent-500 hover:text-accent-400 transition-colors disabled:opacity-40 ml-3 flex-shrink-0"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Retry
          </button>
        </div>
      )}

      {!error && credits && (
        <div className="rounded-lg p-2.5" style={{ background: '#141414', border: '0.5px solid #222' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-content-muted uppercase tracking-wider font-medium">
              <TrendingUp size={10} aria-hidden />
              Credits remaining
            </div>
            <div className="text-sm font-medium text-content-primary font-mono">
              ${balance}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Captured once on first IPC response — tells us which provider was running
// when the app started so we know whether a restart banner is needed.
let bootProvider: BackendProvider = 'lmstudio'

const PROVIDER_LABELS: Record<BackendProvider, string> = {
  lmstudio:   'LM Studio',
  ollama:     'Ollama',
  openrouter: 'OpenRouter',
  nvidia:     'NVIDIA Build',
}

export function NvidiaSettingsPanel() {
  const [settings, setSettings] = useState<BackendSettings>({
    provider:         'lmstudio',
    nvidiaApiKey:     '',
    nvidiaModel:      'mistralai/mistral-medium-3.5-128b',
    ollamaApiKey:     '',
    ollamaModel:      '',
    ollamaBaseUrl:    'https://ollama.com',
    openrouterApiKey: '',
    openrouterModel:  'anthropic/claude-sonnet-4',
  })
  const [loading, setLoading]           = useState(true)
  const [restartNeeded, setRestartNeeded] = useState(false)
  // Track the last-persisted snapshot to know when something has actually changed
  const [savedSettings, setSavedSettings] = useState<BackendSettings | null>(null)

  // NVIDIA key visibility
  const [showNvidiaKey, setShowNvidiaKey] = useState(false)
  // Ollama key visibility
  const [showOllamaKey, setShowOllamaKey] = useState(false)
  // OpenRouter key visibility
  const [showOpenRouterKey, setShowOpenRouterKey] = useState(false)

  // Ollama model list state
  const [ollamaModels, setOllamaModels]               = useState<string[]>([])
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false)
  const [ollamaModelsError, setOllamaModelsError]     = useState<string | null>(null)

  // OpenRouter model list state
  const [openRouterModels, setOpenRouterModels]               = useState<string[]>([])
  const [openRouterModalities, setOpenRouterModalities]       = useState<Record<string, string[]>>({})
  const [openRouterPricing, setOpenRouterPricing]             = useState<Record<string, { prompt: number | null; completion: number | null; cacheRead: number | null }>>({})
  const [openRouterModelsLoading, setOpenRouterModelsLoading] = useState(false)
  const [openRouterModelsError, setOpenRouterModelsError]     = useState<string | null>(null)

  // Debounce timer ref for auto-fetch on baseUrl/apiKey change
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Load persisted settings on mount ─────────────────────────
  useEffect(() => {
    window.api.getBackendSettings().then((s) => {
      bootProvider = s.provider
      setSettings(s)
      setSavedSettings(s)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // ── Restart banner ────────────────────────────────────────────
  useEffect(() => {
    setRestartNeeded(settings.provider !== bootProvider)
  }, [settings.provider])

  // ── Fetch Ollama models ───────────────────────────────────────
  const fetchOllamaModels = useCallback(async (baseUrl: string, apiKey: string) => {
    setOllamaModelsLoading(true)
    setOllamaModelsError(null)
    try {
      const result = await window.api.getOllamaModels(baseUrl, apiKey)
      if (result.error) {
        setOllamaModelsError(result.error)
        setOllamaModels([])
      } else {
        setOllamaModels(result.models)
        setOllamaModelsError(null)
        // Auto-select first model if nothing saved yet
        if (!settings.ollamaModel && result.models.length > 0) {
          setSettings((prev) => ({ ...prev, ollamaModel: result.models[0] }))
        }
      }
    } catch (err) {
      setOllamaModelsError(err instanceof Error ? err.message : String(err))
      setOllamaModels([])
    } finally {
      setOllamaModelsLoading(false)
    }
  }, [settings.ollamaModel])

  // Auto-fetch when switching to Ollama, or after settings load
  useEffect(() => {
    if (settings.provider !== 'ollama' || loading) return
    fetchOllamaModels(settings.ollamaBaseUrl, settings.ollamaApiKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider, loading])

  // ── Fetch OpenRouter models ───────────────────────────────────
  const fetchOpenRouterModels = useCallback(async (apiKey: string) => {
    if (!apiKey) return
    setOpenRouterModelsLoading(true)
    setOpenRouterModelsError(null)
    try {
      const result = await window.api.getOpenRouterModels(apiKey)
      if (result.error) {
        setOpenRouterModelsError(result.error)
        setOpenRouterModels([])
        setOpenRouterModalities({})
        setOpenRouterPricing({})
      } else {
        setOpenRouterModels(result.models)
        setOpenRouterModalities(result.modalities ?? {})
        setOpenRouterPricing(result.pricing ?? {})
        setOpenRouterModelsError(null)
        if (!settings.openrouterModel && result.models.length > 0) {
          setSettings((prev) => ({ ...prev, openrouterModel: result.models[0] }))
        }
      }
    } catch (err) {
      setOpenRouterModelsError(err instanceof Error ? err.message : String(err))
      setOpenRouterModels([])
      setOpenRouterModalities({})
      setOpenRouterPricing({})
    } finally {
      setOpenRouterModelsLoading(false)
    }
  }, [settings.openrouterModel])

  // Auto-fetch when switching to OpenRouter, or after settings load
  useEffect(() => {
    if (settings.provider !== 'openrouter' || loading) return
    fetchOpenRouterModels(settings.openrouterApiKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider, loading])

  // Debounced re-fetch when baseUrl or apiKey changes while Ollama is selected
  useEffect(() => {
    if (settings.provider !== 'ollama' || loading) return
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current)
    fetchTimerRef.current = setTimeout(() => {
      fetchOllamaModels(settings.ollamaBaseUrl, settings.ollamaApiKey)
    }, 800)
    return () => {
      if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ollamaBaseUrl, settings.ollamaApiKey])

  // Debounced re-fetch when API key changes while OpenRouter is selected
  useEffect(() => {
    if (settings.provider !== 'openrouter' || loading) return
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current)
    fetchTimerRef.current = setTimeout(() => {
      fetchOpenRouterModels(settings.openrouterApiKey)
    }, 800)
    return () => {
      if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.openrouterApiKey])

  // ── Save & Restart ───────────────────────────────────────────
  const handleSave = useCallback(async () => {
    await window.api.saveBackendSettings(settings)
    setSavedSettings(settings)
    // Restart the app so the new backend takes effect immediately
    await window.api.restartApp()
  }, [settings])

  const update = <K extends keyof BackendSettings>(key: K, value: BackendSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  if (loading) {
    return <div className="text-sm text-content-muted">Loading…</div>
  }

  // Shared input class
  const inputCls = cn(
    'w-full px-3 py-2 rounded-lg text-sm font-mono',
    'border border-surface-border/50',
    'placeholder:text-content-muted',
    'focus:outline-none focus:ring-1 focus:ring-accent-600/60',
  )

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

      {/* 3-way provider toggle */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-content-primary">
          Inference Backend
        </label>
        <p className="text-xs text-content-muted">
          LM Studio runs models locally. Ollama connects to Ollama Cloud or a local Ollama
          instance. NVIDIA Build uses the NVIDIA cloud API. Switching requires a restart.
        </p>
        <div className="flex gap-2 mt-2">
          {(['lmstudio', 'ollama', 'openrouter', 'nvidia'] as BackendProvider[]).map((p) => (
            <button
              key={p}
              onClick={() => update('provider', p)}
              className={cn(
                'flex-1 py-2 px-2 rounded-lg text-sm font-medium border transition-colors',
                settings.provider === p
                  ? 'bg-accent-950/60 border-accent-700/60 text-accent-300'
                  : 'bg-surface-hover border-surface-border/40 text-content-secondary hover:text-content-primary',
              )}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* ── Ollama fields ──────────────────────────────────────── */}
      {settings.provider === 'ollama' && (
        <div className="space-y-4 pt-2 border-t border-surface-border/30">

          {/* Base URL */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-content-primary">Base URL</label>
            <p className="text-xs text-content-muted">
              Use <span className="font-mono">https://ollama.com</span> for Ollama Cloud,
              or <span className="font-mono">http://localhost:11434</span> for a local instance.
            </p>
            <input
              type="text"
              value={settings.ollamaBaseUrl}
              onChange={(e) => update('ollamaBaseUrl', e.target.value)}
              placeholder="https://ollama.com"
              className={inputCls}
              style={{ background: '#111', color: '#f5f5f5' }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {/* API Key */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-content-primary">API Key</label>
            <p className="text-xs text-content-muted">
              Required for Ollama Cloud. Not required for local instances.
            </p>
            <div className="relative">
              <input
                type={showOllamaKey ? 'text' : 'password'}
                value={settings.ollamaApiKey}
                onChange={(e) => update('ollamaApiKey', e.target.value)}
                placeholder="ollama_…"
                className={cn(inputCls, 'pr-10')}
                style={{ background: '#111', color: '#f5f5f5' }}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowOllamaKey((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-content-muted hover:text-content-primary transition-colors"
                tabIndex={-1}
              >
                {showOllamaKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Model — dropdown when available, text input as fallback */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-content-primary">Model</label>
              <button
                type="button"
                onClick={() => fetchOllamaModels(settings.ollamaBaseUrl, settings.ollamaApiKey)}
                disabled={ollamaModelsLoading}
                className="flex items-center gap-1 text-xs text-content-muted hover:text-content-primary transition-colors disabled:opacity-40"
              >
                <RefreshCw size={11} className={ollamaModelsLoading ? 'animate-spin' : ''} />
                {ollamaModelsLoading ? 'Fetching…' : 'Refresh'}
              </button>
            </div>

            {ollamaModels.length > 0 ? (
              <select
                value={settings.ollamaModel}
                onChange={(e) => update('ollamaModel', e.target.value)}
                className={cn(inputCls, 'cursor-pointer')}
                style={{ background: '#111', color: '#f5f5f5' }}
              >
                {settings.ollamaModel && !ollamaModels.includes(settings.ollamaModel) && (
                  <option value={settings.ollamaModel}>{settings.ollamaModel}</option>
                )}
                {ollamaModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={settings.ollamaModel}
                onChange={(e) => update('ollamaModel', e.target.value)}
                placeholder={ollamaModelsLoading ? 'Fetching models…' : 'e.g. qwen3:32b'}
                disabled={ollamaModelsLoading}
                className={cn(inputCls, ollamaModelsLoading && 'opacity-50')}
                style={{ background: '#111', color: '#f5f5f5' }}
                spellCheck={false}
                autoComplete="off"
              />
            )}

            {ollamaModelsError && (
              <p className="text-xs text-red-400 mt-1">
                Could not fetch models: {ollamaModelsError}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── OpenRouter fields ─────────────────────────────────── */}
      {settings.provider === 'openrouter' && (
        <div className="space-y-4 pt-2 border-t border-surface-border/30">

          {/* API Key */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-content-primary">OpenRouter API Key</label>
            <p className="text-xs text-content-muted">
              Starts with <span className="font-mono">sk-or-</span>. Get one at{' '}
              <button
                onClick={() => window.api.openExternal('https://openrouter.ai/keys')}
                className="text-accent-500 hover:text-accent-400 underline underline-offset-2"
              >
                openrouter.ai/keys
              </button>.{' '}
              Free tier: 20 RPM / 50 requests per day on free models (<span className="font-mono">:free</span> suffix).
            </p>
            <div className="relative">
              <input
                type={showOpenRouterKey ? 'text' : 'password'}
                value={settings.openrouterApiKey}
                onChange={(e) => update('openrouterApiKey', e.target.value)}
                placeholder="sk-or-…"
                className={cn(inputCls, 'pr-10')}
                style={{ background: '#111', color: '#f5f5f5' }}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowOpenRouterKey((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-content-muted hover:text-content-primary transition-colors"
                tabIndex={-1}
              >
                {showOpenRouterKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Model */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-content-primary">Model</label>
              <button
                type="button"
                onClick={() => fetchOpenRouterModels(settings.openrouterApiKey)}
                disabled={openRouterModelsLoading || !settings.openrouterApiKey}
                className="flex items-center gap-1 text-xs text-content-muted hover:text-content-primary transition-colors disabled:opacity-40"
              >
                <RefreshCw size={11} className={openRouterModelsLoading ? 'animate-spin' : ''} />
                {openRouterModelsLoading ? 'Fetching…' : 'Refresh'}
              </button>
            </div>
            <p className="text-xs text-content-muted">
              Enter any model slug, e.g.{' '}
              <span className="font-mono">anthropic/claude-sonnet-4</span> or{' '}
              <span className="font-mono">openai/gpt-4.1</span>. Browse at{' '}
              <button
                onClick={() => window.api.openExternal('https://openrouter.ai/models')}
                className="text-accent-500 hover:text-accent-400 underline underline-offset-2"
              >
                openrouter.ai/models
              </button>.
            </p>

            {openRouterModels.length > 0 ? (
              <select
                value={settings.openrouterModel}
                onChange={(e) => update('openrouterModel', e.target.value)}
                className={cn(inputCls, 'cursor-pointer')}
                style={{ background: '#111', color: '#f5f5f5' }}
              >
                {settings.openrouterModel && !openRouterModels.includes(settings.openrouterModel) && (
                  <option value={settings.openrouterModel}>{settings.openrouterModel}</option>
                )}
                {openRouterModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={settings.openrouterModel}
                onChange={(e) => update('openrouterModel', e.target.value)}
                placeholder="anthropic/claude-sonnet-4"
                className={inputCls}
                style={{ background: '#111', color: '#f5f5f5' }}
                spellCheck={false}
                autoComplete="off"
              />
            )}

            {openRouterModelsError && (
              <p className="text-xs text-red-400 mt-1">
                Could not fetch models: {openRouterModelsError}
              </p>
            )}

            {/* Unified model spec card: modality icons + pricing */}
            {(() => {
              const mods = openRouterModalities[settings.openrouterModel] ?? []
              const p    = openRouterPricing[settings.openrouterModel]
              if (mods.length === 0 && !p) return null
              const MODALITY_ICONS: Record<string, React.ReactNode> = {
                text:  <Type       size={11} />,
                image: <Image      size={11} />,
                audio: <AudioLines size={11} />,
                video: <Video      size={11} />,
                file:  <FileText   size={11} />,
              }
              const fmt = (n: number | null) =>
                n === null ? null : n === 0 ? 'free' : `${(n * 1_000_000).toPrecision(4)}`
              const prices = p ? [
                { tag: 'in',     val: fmt(p.prompt) },
                { tag: 'out',    val: fmt(p.completion) },
                { tag: 'cached', val: fmt(p.cacheRead) },
              ] : []
              return (
                <div
                  className="flex items-stretch overflow-hidden rounded-lg"
                  style={{ border: '0.5px solid rgba(255,255,255,0.09)', background: '#111' }}
                >
                  {mods.length > 0 && (
                    <div
                      className="flex flex-col justify-center gap-1.5 px-3 py-2.5"
                      style={{ borderRight: '0.5px solid rgba(255,255,255,0.07)', minWidth: 60 }}
                    >
                      <span style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace' }}>Inputs</span>
                      <div className="flex gap-1">
                        {mods.map((mod) => {
                          const icon = MODALITY_ICONS[mod]
                          if (!icon) return null
                          const isText = mod === 'text'
                          return (
                            <span
                              key={mod}
                              title={mod.charAt(0).toUpperCase() + mod.slice(1)}
                              className="inline-flex items-center justify-center rounded"
                              style={{
                                width: 22, height: 22,
                                background: isText ? 'rgba(255,255,255,0.05)' : 'rgba(229,57,53,0.1)',
                                border: `0.5px solid ${isText ? 'rgba(255,255,255,0.1)' : 'rgba(229,57,53,0.25)'}`,
                                color: isText ? 'rgba(255,255,255,0.35)' : 'rgba(229,57,53,0.65)',
                              }}
                            >
                              {icon}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {prices.length > 0 && (
                    <div className="flex flex-1">
                      {prices.map((item, i) => (
                        <div
                          key={item.tag}
                          className="flex flex-col justify-center gap-0.5 px-3 py-2.5 flex-1"
                          style={{ borderRight: i < prices.length - 1 ? '0.5px solid rgba(255,255,255,0.05)' : undefined }}
                        >
                          <span style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace' }}>{item.tag}</span>
                          <span
                            className="font-mono font-medium"
                            style={{
                              fontSize: 12,
                              color: item.val === null ? 'rgba(255,255,255,0.15)' : item.val === 'free' ? 'rgba(46,204,113,0.7)' : 'rgba(255,255,255,0.75)',
                            }}
                          >
                            {item.val ?? 'n/a'}
                          </span>
                          {item.val !== null && (
                            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.18)', fontFamily: 'monospace' }}>/ M tok</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>

          {/* Account stats — fetched on tab focus */}
          <OpenRouterStats apiKey={settings.openrouterApiKey} />
        </div>
      )}

      {/* ── NVIDIA fields ──────────────────────────────────────── */}
      {settings.provider === 'nvidia' && (
        <div className="space-y-4 pt-2 border-t border-surface-border/30">

          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-hover border border-surface-border/30">
            <AlertTriangle size={13} className="text-content-muted flex-shrink-0" />
            <p className="text-xs text-content-muted">
              Most free-tier models have been removed or are heavily rate-limited.
              Ollama is recommended instead.
            </p>
          </div>

          {/* API Key */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-content-primary">NVIDIA API Key</label>
            <p className="text-xs text-content-muted">
              Starts with <span className="font-mono">nvapi-</span>. Get one at{' '}
              <button
                onClick={() => window.api.openExternal('https://build.nvidia.com')}
                className="text-accent-500 hover:text-accent-400 underline underline-offset-2"
              >
                build.nvidia.com
              </button>.
            </p>
            <div className="relative">
              <input
                type={showNvidiaKey ? 'text' : 'password'}
                value={settings.nvidiaApiKey}
                onChange={(e) => update('nvidiaApiKey', e.target.value)}
                placeholder="nvapi-…"
                className={cn(inputCls, 'pr-10')}
                style={{ background: '#111', color: '#f5f5f5' }}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowNvidiaKey((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-content-muted hover:text-content-primary transition-colors"
                tabIndex={-1}
              >
                {showNvidiaKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Model ID */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-content-primary">Model</label>
            <p className="text-xs text-content-muted">
              NVIDIA Build model identifier, e.g.{' '}
              <span className="font-mono">mistralai/mistral-medium-3.5-128b</span>.
            </p>
            <input
              type="text"
              value={settings.nvidiaModel}
              onChange={(e) => update('nvidiaModel', e.target.value)}
              placeholder="mistralai/mistral-medium-3.5-128b"
              className={inputCls}
              style={{ background: '#111', color: '#f5f5f5' }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>
      )}

      {/* Save & Restart */}
      {(() => {
        const hasChanged = savedSettings !== null &&
          JSON.stringify(settings) !== JSON.stringify(savedSettings)
        return (
          <div className="flex justify-center pt-2">
            <button
              onClick={handleSave}
              disabled={!hasChanged}
              className={cn(
                'px-5 py-2 rounded-lg text-sm font-medium transition-colors',
                hasChanged
                  ? 'bg-accent-700 hover:bg-accent-600 text-white cursor-pointer'
                  : 'bg-surface-hover border border-surface-border/40 text-content-muted cursor-not-allowed opacity-50',
              )}
            >
              Save &amp; Restart
            </button>
          </div>
        )
      })()}
    </div>
  )
}
