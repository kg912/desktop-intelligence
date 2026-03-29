/**
 * FirstLaunchModal
 *
 * Shown on first launch instead of the ConnectionStatus polling overlay.
 * Lets the user pick a downloaded LM Studio model and set the context length,
 * then saves settings and loads the model via the app:initialize IPC channel.
 *
 * Design follows the same dark-red aesthetic as ConnectionStatus and SettingsModal.
 */

import { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Cpu, RefreshCw, AlertCircle, ChevronDown } from 'lucide-react'
import type { AvailableModel } from '../../../../shared/types'

// ── Constants ──────────────────────────────────────────────────────────────
const PRESETS     = [4096, 8192, 16384, 32768, 65536, 131072]
const MIN_CTX     = 4096
const MAX_CTX     = 131072
const DEFAULT_CTX = 4096

function fmtCtx(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)
}

// ── Props ──────────────────────────────────────────────────────────────────
interface FirstLaunchModalProps {
  /** Called with the chosen modelId once the model has been loaded successfully */
  onComplete: (modelId: string) => void
}

// ── Component ──────────────────────────────────────────────────────────────
export function FirstLaunchModal({ onComplete }: FirstLaunchModalProps) {
  const [models,      setModels]      = useState<AvailableModel[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [listError,   setListError]   = useState<string | null>(null)
  const [selectedId,  setSelectedId]  = useState<string>('')
  const [ctxLength,   setCtxLength]   = useState<number>(DEFAULT_CTX)
  const [saving,      setSaving]      = useState(false)
  const [saveError,   setSaveError]   = useState<string | null>(null)

  // ── Fetch available models from LM Studio ───────────────────────
  const fetchModels = useCallback(() => {
    setLoadingList(true)
    setListError(null)
    window.api.getAvailableModels()
      .then((list) => {
        setModels(list)
        // Auto-select the first model; prefer one that is already loaded
        if (list.length > 0) {
          const loaded = list.find((m) => m.state === 'loaded')
          setSelectedId((loaded ?? list[0]).id)
        }
        if (list.length === 0) {
          setListError('No models found. Make sure LM Studio is running and you have downloaded at least one model.')
        }
      })
      .catch(() => {
        setListError('Could not reach LM Studio. Make sure it is installed and running.')
      })
      .finally(() => setLoadingList(false))
  }, [])

  useEffect(() => { fetchModels() }, [fetchModels])

  // ── Save handler ────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!selectedId || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await window.api.initializeApp({ modelId: selectedId, contextLength: ctxLength })
      if (res.success) {
        onComplete(selectedId)
      } else {
        setSaveError(res.error ?? 'Failed to load model. Check LM Studio logs.')
      }
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [selectedId, ctxLength, saving, onComplete])

  const canSave = !saving && !loadingList && selectedId.length > 0

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
        className="relative w-full max-w-lg mx-4 rounded-2xl border overflow-hidden"
        style={{
          background:   '#1a1a1a',
          borderColor:  '#2a2a2a',
          boxShadow:    '0 32px 80px rgba(0,0,0,0.8)',
        }}
      >
        {/* ── Header ── */}
        <div
          className="flex flex-col items-center gap-3 px-8 pt-8 pb-6 text-center border-b"
          style={{ borderColor: '#2a2a2a', background: '#141414' }}
        >
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{ background: 'rgba(139,0,0,0.2)', boxShadow: '0 0 20px rgba(220,38,38,0.3)' }}
          >
            <Cpu className="w-6 h-6 text-red-500" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">Welcome to Desktop Intelligence</h1>
            <p className="text-sm mt-1" style={{ color: '#a3a3a3' }}>
              Choose a model to get started
            </p>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="px-8 py-6 space-y-6">

          {/* Model selector */}
          <div>
            <p
              className="text-[10px] font-semibold tracking-widest uppercase mb-2"
              style={{ color: '#525252' }}
            >
              Active Model
            </p>

            {loadingList ? (
              <div
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg border"
                style={{ borderColor: '#2a2a2a', background: '#111' }}
              >
                <div className="w-3 h-3 rounded-full border-2 border-neutral-600 border-t-red-500 animate-spin" />
                <span className="text-xs" style={{ color: '#525252' }}>
                  Fetching models from LM Studio…
                </span>
              </div>
            ) : listError ? (
              <div className="space-y-2">
                <div
                  className="flex items-start gap-2 px-3 py-2.5 rounded-lg border"
                  style={{ borderColor: 'rgba(127,29,29,0.4)', background: 'rgba(69,10,10,0.2)' }}
                >
                  <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-red-400">{listError}</p>
                </div>
                <button
                  onClick={fetchModels}
                  className="text-xs transition-colors"
                  style={{ color: '#a3a3a3' }}
                  onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.color = '#f5f5f5' }}
                  onMouseOut={(e)  => { (e.currentTarget as HTMLElement).style.color = '#a3a3a3' }}
                >
                  <span className="underline">Retry</span>
                </button>
              </div>
            ) : (
              <div className="relative">
                <select
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  disabled={saving}
                  className="w-full appearance-none px-3 py-2.5 pr-8 rounded-lg border text-sm font-mono
                             disabled:opacity-40 focus:outline-none transition-colors"
                  style={{
                    background: '#111',
                    color:      '#f5f5f5',
                    border:     '1px solid #3a3a3a',
                  }}
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

          {/* Context length */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p
                className="text-[10px] font-semibold tracking-widest uppercase"
                style={{ color: '#525252' }}
              >
                Context Length
              </p>
              <span className="text-xs font-mono" style={{ color: '#a3a3a3' }}>
                ≈ {fmtCtx(ctxLength)} context
              </span>
            </div>

            <div className="flex items-center gap-3 mb-3">
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
                className="w-28 px-3 py-2 rounded-lg text-sm font-mono text-center
                           focus:outline-none disabled:opacity-40"
                style={{
                  background: '#111',
                  color:      '#f5f5f5',
                  border:     '1px solid #3a3a3a',
                }}
              />
              <span className="text-xs" style={{ color: '#525252' }}>tokens</span>
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

            <div className="flex justify-between mt-1">
              {['4K', '32K', '64K', '128K'].map((l) => (
                <span key={l} className="text-[10px]" style={{ color: '#525252' }}>{l}</span>
              ))}
            </div>

            {/* Preset chips */}
            <div className="flex flex-wrap gap-2 mt-3">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  disabled={saving}
                  onClick={() => setCtxLength(p)}
                  className="px-2.5 py-1 rounded-md text-xs font-mono transition-all duration-100 disabled:opacity-30"
                  style={ctxLength === p
                    ? {
                        background:  'rgba(139,0,0,0.2)',
                        border:      '1px solid rgba(185,28,28,0.4)',
                        color:       '#f87171',
                      }
                    : {
                        background:  '#111',
                        border:      '1px solid #2a2a2a',
                        color:       '#525252',
                      }
                  }
                  onMouseOver={(e) => {
                    if (ctxLength !== p) (e.currentTarget as HTMLElement).style.color = '#a3a3a3'
                  }}
                  onMouseOut={(e) => {
                    if (ctxLength !== p) (e.currentTarget as HTMLElement).style.color = '#525252'
                  }}
                >
                  {fmtCtx(p)}
                </button>
              ))}
            </div>
          </div>

          {/* Save error */}
          {saveError && (
            <div
              className="flex items-start gap-2 px-3 py-2.5 rounded-lg border"
              style={{ borderColor: 'rgba(127,29,29,0.4)', background: 'rgba(69,10,10,0.2)' }}
            >
              <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-400">{saveError}</p>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div
          className="px-8 py-4 border-t"
          style={{ background: '#141414', borderColor: '#2a2a2a' }}
        >
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-xl
                       text-sm font-medium transition-all duration-150 focus:outline-none"
            style={canSave
              ? {
                  background: 'rgba(139,0,0,0.3)',
                  border:     '1px solid rgba(185,28,28,0.5)',
                  color:      '#f87171',
                  boxShadow:  '0 0 12px rgba(139,0,0,0.2)',
                }
              : {
                  background: '#111',
                  border:     '1px solid #2a2a2a',
                  color:      '#525252',
                  cursor:     'not-allowed',
                }
            }
          >
            {saving ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Loading model — this takes 30–60 seconds…
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
