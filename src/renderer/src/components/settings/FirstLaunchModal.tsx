/**
 * FirstLaunchModal
 *
 * Shown on first launch instead of the ConnectionStatus polling overlay.
 * Supports all 4 providers: LM Studio, Ollama, NVIDIA Build, OpenRouter.
 * Persists provider choice to settings before fetching models so server-side
 * routing reads the correct provider.
 *
 * Design follows the same dark-red aesthetic as ConnectionStatus and SettingsModal.
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { motion } from 'framer-motion'
import { Cpu, RefreshCw, AlertCircle, ChevronDown } from 'lucide-react'
import type { AvailableModel } from '../../../../shared/types'

// ── Constants ──────────────────────────────────────────────────────────────
const PRESETS     = [4096, 8192, 16384, 32768, 65536, 131072]
const MIN_CTX     = 4096
const MAX_CTX     = 131072
const DEFAULT_CTX = 4096

type Provider = 'lmstudio' | 'ollama' | 'nvidia' | 'openrouter'

function fmtCtx(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)
}

// ── Shared style helpers ───────────────────────────────────────────────────
const LABEL_STYLE = {
  display:        'block',
  fontSize:       '10px',
  fontWeight:     600,
  letterSpacing:  '0.1em',
  textTransform:  'uppercase' as const,
  color:          '#525252',
  marginBottom:   '6px',
}

const INPUT_STYLE = {
  width:        '100%',
  background:   '#111',
  border:       '1px solid #3a3a3a',
  color:        '#f5f5f5',
  borderRadius: '8px',
  padding:      '8px 12px',
  fontSize:     '13px',
  outline:      'none',
  boxSizing:    'border-box' as const,
}

const HELPER_STYLE = {
  fontSize:   '12px',
  color:      '#525252',
  marginTop:  '4px',
}

const ERROR_BOX_STYLE = {
  display:      'flex',
  alignItems:   'flex-start',
  gap:          '8px',
  padding:      '10px 12px',
  borderRadius: '8px',
  border:       '1px solid rgba(127,29,29,0.4)',
  background:   'rgba(69,10,10,0.2)',
}

// ── ContextLengthSection — reused for LMS and Ollama ─────────────────────
function ContextLengthSection({
  ctxLength,
  setCtxLength,
  saving,
}: {
  ctxLength: number
  setCtxLength: (n: number) => void
  saving: boolean
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <p style={LABEL_STYLE}>Context Length</p>
        <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#a3a3a3' }}>
          ≈ {fmtCtx(ctxLength)} context
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
        <input
          type="number"
          min={MIN_CTX}
          max={MAX_CTX}
          step={1024}
          value={ctxLength}
          disabled={saving}
          onChange={(e) => {
            const v = Math.max(MIN_CTX, Math.min(MAX_CTX, Number(e.target.value) || MIN_CTX))
            setCtxLength(v)
          }}
          style={{
            width:        '112px',
            background:   '#111',
            border:       '1px solid #3a3a3a',
            color:        '#f5f5f5',
            borderRadius: '8px',
            padding:      '8px 12px',
            fontSize:     '13px',
            fontFamily:   'monospace',
            textAlign:    'center',
            outline:      'none',
            opacity:      saving ? 0.4 : 1,
          }}
        />
        <span style={{ fontSize: '12px', color: '#525252' }}>tokens</span>
      </div>

      <input
        type="range"
        min={MIN_CTX}
        max={MAX_CTX}
        step={1024}
        value={ctxLength}
        disabled={saving}
        onChange={(e) => setCtxLength(Number(e.target.value))}
        className="w-full accent-red-700 disabled:opacity-40"
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', marginBottom: '12px' }}>
        {['4K', '32K', '64K', '128K'].map((l) => (
          <span key={l} style={{ fontSize: '10px', color: '#525252' }}>{l}</span>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {PRESETS.map((p) => (
          <button
            key={p}
            disabled={saving}
            onClick={() => setCtxLength(p)}
            style={ctxLength === p
              ? { background: 'rgba(139,0,0,0.2)', border: '1px solid rgba(185,28,28,0.4)', color: '#f87171', borderRadius: '6px', padding: '4px 10px', fontSize: '12px', fontFamily: 'monospace', cursor: 'pointer', opacity: saving ? 0.3 : 1 }
              : { background: '#111', border: '1px solid #2a2a2a', color: '#525252', borderRadius: '6px', padding: '4px 10px', fontSize: '12px', fontFamily: 'monospace', cursor: 'pointer', opacity: saving ? 0.3 : 1 }
            }
          >
            {fmtCtx(p)}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Props ──────────────────────────────────────────────────────────────────
interface FirstLaunchModalProps {
  onComplete: (modelId: string) => void
}

// ── Component ──────────────────────────────────────────────────────────────
export function FirstLaunchModal({ onComplete }: FirstLaunchModalProps) {

  // ── Provider ──────────────────────────────────────────────────
  const [selectedProvider, setSelectedProvider] = useState<Provider>('lmstudio')

  // ── LM Studio state ───────────────────────────────────────────
  const [models,          setModels]          = useState<AvailableModel[]>([])
  const [loadingList,     setLoadingList]     = useState(true)
  const [listError,       setListError]       = useState<string | null>(null)
  const [selectedId,      setSelectedId]      = useState<string>('')
  const [lmsNotInstalled, setLmsNotInstalled] = useState(false)
  const notInstalledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Ollama state ──────────────────────────────────────────────
  const [ollamaBaseUrl,        setOllamaBaseUrl]        = useState('https://ollama.com')
  const [ollamaApiKey,         setOllamaApiKey]         = useState('')
  const [ollamaModels,         setOllamaModels]         = useState<string[]>([])
  const [ollamaSelectedModel,  setOllamaSelectedModel]  = useState('')
  const [ollamaFetching,       setOllamaFetching]       = useState(false)
  const [ollamaFetchError,     setOllamaFetchError]     = useState<string | null>(null)

  // ── NVIDIA state ──────────────────────────────────────────────
  const [nvidiaApiKey, setNvidiaApiKey] = useState('')
  const [nvidiaModel,  setNvidiaModel]  = useState('mistralai/mistral-medium-3.5-128b')

  // ── OpenRouter state ──────────────────────────────────────────
  const [openrouterApiKey, setOpenrouterApiKey] = useState('')
  const [openrouterModel,  setOpenrouterModel]  = useState('anthropic/claude-sonnet-4')

  // ── Shared context length (LMS + Ollama) ─────────────────────
  const [ctxLength, setCtxLength] = useState<number>(DEFAULT_CTX)

  // ── Save state ────────────────────────────────────────────────
  const [saving,    setSaving]    = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // ── LMS model fetch ───────────────────────────────────────────
  // No dependency on provider — routing is server-side; caller must await
  // saveBackendSettings() before invoking to ensure the file is updated first.
  const fetchModels = useCallback(() => {
    setLoadingList(true)
    setListError(null)
    setSelectedId('')
    setLmsNotInstalled(false)
    if (notInstalledTimerRef.current) {
      clearTimeout(notInstalledTimerRef.current)
      notInstalledTimerRef.current = null
    }
    window.api.getAvailableModels()
      .then((list) => {
        setModels(list)
        if (list.length > 0) {
          const loaded = list.find((m) => m.state === 'loaded')
          setSelectedId((loaded ?? list[0]).id)
        }
        if (list.length === 0) {
          setListError('No models found. Make sure LM Studio is running and has at least one model downloaded.')
        }
      })
      .catch(() => {
        setListError('Could not reach LM Studio. Make sure it is installed and running.')
      })
      .finally(() => setLoadingList(false))
  }, [])

  // ── On mount: read saved provider, then fetch if LMS ─────────
  useEffect(() => {
    window.api.getBackendSettings()
      .then((s) => {
        const p = (s.provider as Provider) || 'lmstudio'
        setSelectedProvider(p)
        if (p === 'lmstudio') {
          fetchModels()
        } else {
          setLoadingList(false)
        }
      })
      .catch(() => {
        fetchModels() // fallback: assume LMS if settings read fails
      })
  }, [fetchModels])

  // ── Daemon subscription: auto-retry model fetch on daemon ready ─
  useEffect(() => {
    if (selectedProvider !== 'lmstudio') return
    const unsub = window.api.onDaemonStateChange((state) => {
      if (state.phase === 'ready' && (loadingList || listError)) {
        fetchModels()
      }
    })
    return unsub
  }, [selectedProvider, loadingList, listError, fetchModels])

  // ── LMS not-installed detection (5-second timer after fetch error) ─
  useEffect(() => {
    if (selectedProvider !== 'lmstudio' || !listError) {
      if (notInstalledTimerRef.current) {
        clearTimeout(notInstalledTimerRef.current)
        notInstalledTimerRef.current = null
      }
      if (!listError) setLmsNotInstalled(false)
      return
    }
    notInstalledTimerRef.current = setTimeout(async () => {
      try {
        const state = await window.api.getDaemonState()
        if (state.phase === 'idle') {
          setLmsNotInstalled(true)
        }
      } catch { /* non-fatal */ }
    }, 5000)
    return () => {
      if (notInstalledTimerRef.current) {
        clearTimeout(notInstalledTimerRef.current)
        notInstalledTimerRef.current = null
      }
    }
  }, [selectedProvider, listError])

  // ── Provider switch ───────────────────────────────────────────
  const handleProviderSwitch = useCallback(async (provider: Provider) => {
    setSelectedProvider(provider)
    setListError(null)
    setSaveError(null)
    setLmsNotInstalled(false)
    setSelectedId('')
    setOllamaFetchError(null)
    if (notInstalledTimerRef.current) {
      clearTimeout(notInstalledTimerRef.current)
      notInstalledTimerRef.current = null
    }
    // Must await so the settings file reflects the new provider before any fetch
    await window.api.saveBackendSettings({ provider })
    if (provider === 'lmstudio') {
      fetchModels()
    } else {
      setLoadingList(false)
    }
  }, [fetchModels])

  // ── Ollama model fetch ────────────────────────────────────────
  const fetchOllamaModels = useCallback(async () => {
    setOllamaFetching(true)
    setOllamaFetchError(null)
    try {
      const result = await window.api.getOllamaModels(ollamaBaseUrl, ollamaApiKey)
      if (result.error) {
        setOllamaFetchError(result.error)
        setOllamaModels([])
      } else {
        setOllamaModels(result.models)
        if (result.models.length > 0) {
          setOllamaSelectedModel((prev) => prev || result.models[0])
        }
      }
    } catch (err) {
      setOllamaFetchError((err as Error).message)
    } finally {
      setOllamaFetching(false)
    }
  }, [ollamaBaseUrl, ollamaApiKey])

  // ── Save handler ──────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      // 1. Persist all backend credentials so they survive restarts
      await window.api.saveBackendSettings({
        provider:        selectedProvider,
        nvidiaApiKey,
        nvidiaModel,
        ollamaApiKey,
        ollamaModel:     ollamaSelectedModel,
        ollamaBaseUrl,
        openrouterApiKey,
        openrouterModel,
      })

      // 2. Determine canonical modelId and contextLength for this provider
      let modelId: string
      let ctxLen: number
      switch (selectedProvider) {
        case 'nvidia':
          modelId = nvidiaModel || 'mistralai/mistral-medium-3.5-128b'
          ctxLen  = 8192
          break
        case 'openrouter':
          modelId = openrouterModel || 'anthropic/claude-sonnet-4'
          ctxLen  = 32768
          break
        case 'ollama':
          modelId = ollamaSelectedModel
          ctxLen  = ctxLength
          break
        default: // lmstudio
          modelId = selectedId
          ctxLen  = ctxLength
      }

      // 3. APP_INITIALIZE persists modelId/contextLength and (for LMS) runs lms load.
      //    Cloud providers return immediately via the guard in handlers.ts.
      const res = await window.api.initializeApp({ modelId, contextLength: ctxLen })
      if (res.success) {
        onComplete(modelId)
      } else {
        setSaveError(res.error ?? 'Setup failed.')
      }
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [
    saving, selectedProvider,
    nvidiaApiKey, nvidiaModel,
    ollamaApiKey, ollamaSelectedModel, ollamaBaseUrl,
    openrouterApiKey, openrouterModel,
    selectedId, ctxLength, onComplete,
  ])

  // ── canSave — per-provider validation ────────────────────────
  const canSave = !saving && (() => {
    switch (selectedProvider) {
      case 'lmstudio':   return !loadingList && selectedId.length > 0
      case 'ollama':     return ollamaSelectedModel.length > 0
      case 'nvidia':     return nvidiaApiKey.length > 0 && nvidiaModel.length > 0
      case 'openrouter': return openrouterApiKey.length > 0 && openrouterModel.length > 0
    }
  })()

  // ── Provider button style ─────────────────────────────────────
  const providerBtnStyle = (p: Provider) =>
    selectedProvider === p
      ? { background: 'rgba(139,0,0,0.2)', border: '1px solid rgba(185,28,28,0.4)', color: '#f87171' }
      : { background: '#111', border: '1px solid #2a2a2a', color: '#525252' }

  const PROVIDER_LABELS: Record<Provider, string> = {
    lmstudio:   'LM Studio',
    ollama:     'Ollama',
    nvidia:     'NVIDIA Build',
    openrouter: 'OpenRouter',
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: '#0a0a0a' }}
    >
      {/* Ambient glow */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(139,0,0,0.12) 0%, transparent 70%)' }}
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } }}
        style={{
          position:     'relative',
          width:        '100%',
          maxWidth:     '512px',
          margin:       '0 16px',
          borderRadius: '16px',
          border:       '1px solid #2a2a2a',
          background:   '#1a1a1a',
          boxShadow:    '0 32px 80px rgba(0,0,0,0.8)',
          maxHeight:    '92vh',
          overflowY:    'auto',
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            display:        'flex',
            flexDirection:  'column',
            alignItems:     'center',
            gap:            '12px',
            padding:        '32px 32px 24px',
            textAlign:      'center',
            borderBottom:   '1px solid #2a2a2a',
            background:     '#141414',
          }}
        >
          <div
            style={{
              width:      '48px',
              height:     '48px',
              borderRadius: '12px',
              display:    'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(139,0,0,0.2)',
              boxShadow:  '0 0 20px rgba(220,38,38,0.3)',
            }}
          >
            <Cpu className="w-6 h-6 text-red-500" />
          </div>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 600, color: '#ffffff', margin: 0 }}>
              Welcome to Desktop Intelligence
            </h1>
            <p style={{ fontSize: '14px', color: '#a3a3a3', margin: '4px 0 0' }}>
              Choose a provider and model to get started
            </p>
          </div>
        </div>

        {/* ── Body ── */}
        <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: '24px' }}>

          {/* Provider selector */}
          <div>
            <p style={LABEL_STYLE}>AI Provider</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '6px' }}>
              {(['lmstudio', 'ollama', 'nvidia', 'openrouter'] as Provider[]).map((p) => (
                <button
                  key={p}
                  disabled={saving}
                  onClick={() => handleProviderSwitch(p)}
                  style={{
                    ...providerBtnStyle(p),
                    borderRadius: '8px',
                    padding:      '8px 4px',
                    fontSize:     '11px',
                    fontWeight:   500,
                    cursor:       saving ? 'not-allowed' : 'pointer',
                    opacity:      saving ? 0.4 : 1,
                    transition:   'all 0.1s',
                  }}
                >
                  {PROVIDER_LABELS[p]}
                </button>
              ))}
            </div>
          </div>

          {/* ── LM Studio section ── */}
          {selectedProvider === 'lmstudio' && (
            <>
              <div>
                <p style={LABEL_STYLE}>Active Model</p>
                {loadingList ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderRadius: '8px', border: '1px solid #2a2a2a', background: '#111' }}>
                    <div className="w-3 h-3 rounded-full border-2 border-neutral-600 border-t-red-500 animate-spin" />
                    <span style={{ fontSize: '12px', color: '#525252' }}>Fetching models from LM Studio…</span>
                  </div>
                ) : listError ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={ERROR_BOX_STYLE}>
                      <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                      <p style={{ fontSize: '12px', color: '#f87171', margin: 0 }}>{listError}</p>
                    </div>
                    {/* LMS not-installed fallback */}
                    {lmsNotInstalled && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(234,179,8,0.3)', background: 'rgba(234,179,8,0.05)' }}>
                        <span style={{ fontSize: '12px', color: '#ca8a04' }}>
                          ⚠ LM Studio does not appear to be installed on this system.
                        </span>
                        <button
                          onClick={() => handleProviderSwitch('ollama')}
                          style={{ fontSize: '11px', color: '#f87171', background: 'rgba(139,0,0,0.2)', border: '1px solid rgba(185,28,28,0.4)', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', whiteSpace: 'nowrap', marginLeft: '8px' }}
                        >
                          Switch to Ollama →
                        </button>
                      </div>
                    )}
                    {/* Manual retry — only shown when daemon is not idle (e.g. errored) */}
                    {!lmsNotInstalled && (
                      <button
                        onClick={fetchModels}
                        style={{ fontSize: '12px', color: '#a3a3a3', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', textDecoration: 'underline', padding: 0 }}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                ) : (
                  <div style={{ position: 'relative' }}>
                    <select
                      value={selectedId}
                      onChange={(e) => setSelectedId(e.target.value)}
                      disabled={saving}
                      style={{ ...INPUT_STYLE, appearance: 'none', paddingRight: '32px' }}
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id} style={{ background: '#111' }}>
                          {m.id}{m.state === 'loaded' ? ' (loaded)' : ''}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
                      style={{ color: '#525252' }}
                    />
                  </div>
                )}
              </div>

              <ContextLengthSection ctxLength={ctxLength} setCtxLength={setCtxLength} saving={saving} />
            </>
          )}

          {/* ── Ollama section ── */}
          {selectedProvider === 'ollama' && (
            <>
              <div>
                <label style={LABEL_STYLE}>Base URL</label>
                <input
                  type="text"
                  value={ollamaBaseUrl}
                  onChange={(e) => setOllamaBaseUrl(e.target.value)}
                  disabled={saving}
                  placeholder="http://localhost:11434 for local"
                  style={INPUT_STYLE}
                />
                <p style={HELPER_STYLE}>Default: https://ollama.com · Local: http://localhost:11434</p>
              </div>

              <div>
                <label style={LABEL_STYLE}>API Key (optional for local)</label>
                <input
                  type="password"
                  value={ollamaApiKey}
                  onChange={(e) => setOllamaApiKey(e.target.value)}
                  disabled={saving}
                  placeholder="Leave empty for local Ollama"
                  style={INPUT_STYLE}
                />
              </div>

              <div>
                <label style={LABEL_STYLE}>Model</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, position: 'relative' }}>
                    {ollamaModels.length > 0 ? (
                      <>
                        <select
                          value={ollamaSelectedModel}
                          onChange={(e) => setOllamaSelectedModel(e.target.value)}
                          disabled={saving}
                          style={{ ...INPUT_STYLE, appearance: 'none', paddingRight: '32px' }}
                        >
                          {ollamaModels.map((m) => (
                            <option key={m} value={m} style={{ background: '#111' }}>{m}</option>
                          ))}
                        </select>
                        <ChevronDown
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
                          style={{ color: '#525252' }}
                        />
                      </>
                    ) : (
                      <div style={{ ...INPUT_STYLE, color: '#525252', userSelect: 'none' }}>
                        {ollamaFetching ? 'Fetching…' : 'Enter URL and click Fetch Models'}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={fetchOllamaModels}
                    disabled={ollamaFetching || saving}
                    style={{
                      background:   'rgba(139,0,0,0.2)',
                      border:       '1px solid rgba(185,28,28,0.4)',
                      color:        '#f87171',
                      borderRadius: '8px',
                      padding:      '8px 12px',
                      fontSize:     '12px',
                      cursor:       ollamaFetching || saving ? 'not-allowed' : 'pointer',
                      whiteSpace:   'nowrap',
                      opacity:      ollamaFetching || saving ? 0.6 : 1,
                      display:      'flex',
                      alignItems:   'center',
                      gap:          '4px',
                    }}
                  >
                    {ollamaFetching && (
                      <RefreshCw style={{ width: '12px', height: '12px', animation: 'spin 1s linear infinite' }} />
                    )}
                    Fetch Models
                  </button>
                </div>
                {ollamaFetchError && (
                  <p style={{ fontSize: '12px', color: '#f87171', marginTop: '4px' }}>{ollamaFetchError}</p>
                )}
              </div>

              <ContextLengthSection ctxLength={ctxLength} setCtxLength={setCtxLength} saving={saving} />
            </>
          )}

          {/* ── NVIDIA Build section ── */}
          {selectedProvider === 'nvidia' && (
            <>
              <div>
                <label style={LABEL_STYLE}>NVIDIA API Key</label>
                <input
                  type="password"
                  value={nvidiaApiKey}
                  onChange={(e) => setNvidiaApiKey(e.target.value)}
                  disabled={saving}
                  placeholder="nvapi-…"
                  style={INPUT_STYLE}
                />
              </div>
              <div>
                <label style={LABEL_STYLE}>Model</label>
                <input
                  type="text"
                  value={nvidiaModel}
                  onChange={(e) => setNvidiaModel(e.target.value)}
                  disabled={saving}
                  style={INPUT_STYLE}
                />
                <p style={HELPER_STYLE}>Browse models at build.nvidia.com/models</p>
              </div>
            </>
          )}

          {/* ── OpenRouter section ── */}
          {selectedProvider === 'openrouter' && (
            <>
              <div>
                <label style={LABEL_STYLE}>OpenRouter API Key</label>
                <input
                  type="password"
                  value={openrouterApiKey}
                  onChange={(e) => setOpenrouterApiKey(e.target.value)}
                  disabled={saving}
                  placeholder="sk-or-…"
                  style={INPUT_STYLE}
                />
              </div>
              <div>
                <label style={LABEL_STYLE}>Model</label>
                <input
                  type="text"
                  value={openrouterModel}
                  onChange={(e) => setOpenrouterModel(e.target.value)}
                  disabled={saving}
                  style={INPUT_STYLE}
                />
                <p style={HELPER_STYLE}>
                  Browse models at openrouter.ai/models · Free tier: 50 req/day on :free models
                </p>
              </div>
            </>
          )}

          {/* Save error */}
          {saveError && (
            <div style={ERROR_BOX_STYLE}>
              <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
              <p style={{ fontSize: '12px', color: '#f87171', margin: 0 }}>{saveError}</p>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div
          style={{
            padding:      '16px 32px',
            borderTop:    '1px solid #2a2a2a',
            background:   '#141414',
          }}
        >
          <button
            onClick={handleSave}
            disabled={!canSave}
            style={{
              width:          '100%',
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              gap:            '10px',
              padding:        '10px 16px',
              borderRadius:   '12px',
              fontSize:       '14px',
              fontWeight:     500,
              transition:     'all 0.15s',
              outline:        'none',
              cursor:         canSave ? 'pointer' : 'not-allowed',
              ...(canSave
                ? { background: 'rgba(139,0,0,0.3)', border: '1px solid rgba(185,28,28,0.5)', color: '#f87171', boxShadow: '0 0 12px rgba(139,0,0,0.2)' }
                : { background: '#111', border: '1px solid #2a2a2a', color: '#525252' }
              ),
            }}
          >
            {saving ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                {selectedProvider === 'lmstudio' || selectedProvider === 'ollama'
                  ? 'Loading model — this takes 30–60 seconds…'
                  : 'Saving settings…'}
              </>
            ) : (
              'Save & Connect'
            )}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
