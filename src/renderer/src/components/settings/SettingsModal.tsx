/**
 * SettingsModal
 *
 * Floating settings panel launched from the sidebar cog wheel.
 * Currently exposes one control: Context Length (n_ctx).
 *
 * Behaviour:
 *  - On open: fetches current model config via LM Studio /api/v0.
 *  - "Reload Model" button is only active when the value has changed.
 *  - Closing with X or clicking the backdrop discards unsaved changes.
 *  - While reload is in progress the entire modal dims and a spinner runs.
 *  - The rest of the app is blocked by the semi-transparent overlay.
 *
 * Designed to be modular — future expansions (model switcher, temperature,
 * etc.) can be added as additional sections without restructuring this file.
 */

import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Settings, RefreshCw, AlertCircle, CheckCircle2, ChevronRight, ChevronDown } from 'lucide-react'
import { useModelStore } from '../../store/ModelStore'
import type { AvailableModel } from '../../../../shared/types'

// ── Context length preset steps ─────────────────────────────────────
const PRESETS = [4096, 8192, 16384, 32768, 65536, 131072]
const MIN_CTX = 4096
const MAX_CTX = 131072

function fmtCtx(n: number): string {
  if (n >= 1024) return `${Math.round(n / 1024)}K`
  return String(n)
}

// ── Animation variants (match ConnectionStatus aesthetic) ────────────
const overlayVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2 } },
  exit:    { opacity: 0, transition: { duration: 0.25 } },
}

const cardVariants = {
  initial: { opacity: 0, scale: 0.94, y: 20 },
  animate: { opacity: 1, scale: 1, y: 0,  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } },
  exit:    { opacity: 0, scale: 0.96, y: 12, transition: { duration: 0.2, ease: 'easeIn' } },
}

// ── Props ─────────────────────────────────────────────────────────────
interface SettingsModalProps {
  open:    boolean
  onClose: () => void
}

// ── Component ─────────────────────────────────────────────────────────
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { setSelectedModel } = useModelStore()

  // Fetched from LM Studio on each open
  const [fetchedCtx,      setFetchedCtx]      = useState<number | null>(null)
  const [fetchedModel,    setFetchedModel]    = useState<string>('')
  const [draftCtx,        setDraftCtx]        = useState<number>(32768)
  const [draftModel,      setDraftModel]      = useState<string>('')
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])

  // UI states
  const [loading,     setLoading]     = useState(false)   // fetching config
  const [reloading,   setReloading]   = useState(false)   // model reload in progress
  const [result,      setResult]      = useState<{ ok: boolean; msg: string } | null>(null)

  // Changed if either context length or model differs from the fetched state
  const changed = fetchedCtx !== null &&
    (draftCtx !== fetchedCtx || draftModel !== fetchedModel)

  // ── Fetch current config + available models whenever modal opens ─
  useEffect(() => {
    if (!open) {
      setResult(null)
      return
    }
    setLoading(true)
    setResult(null)
    Promise.all([
      window.api.getModelConfig(),
      window.api.getAvailableModels(),
    ])
      .then(([cfg, models]) => {
        // Clamp to slider range — some models report >128K which breaks the UI
        const ctx = Math.min(Math.max(cfg.contextLength, MIN_CTX), MAX_CTX)
        setFetchedCtx(ctx)
        setFetchedModel(cfg.modelId)
        setDraftCtx(ctx)
        setDraftModel(cfg.modelId)
        setAvailableModels(models)
      })
      .catch(() => {
        setFetchedCtx(32768)
        setFetchedModel('unknown')
        setDraftCtx(32768)
        setDraftModel('unknown')
        setAvailableModels([])
      })
      .finally(() => setLoading(false))
  }, [open])

  // ── Reload handler ────────────────────────────────────────────
  const handleReload = useCallback(async () => {
    if (!changed || reloading) return
    setReloading(true)
    setResult(null)
    try {
      const res = await window.api.reloadModel({ modelId: draftModel, contextLength: draftCtx })
      if (res.success) {
        // Use the value confirmed by re-reading LM Studio; fall back to what we sent
        const actual = res.confirmedCtx ?? draftCtx
        setFetchedCtx(actual)
        setDraftCtx(actual)
        setFetchedModel(draftModel)
        // Propagate model switch to the global store so TopBar / chat payloads reflect it
        setSelectedModel(draftModel)
        const msg = res.confirmedCtx && res.confirmedCtx !== draftCtx
          ? `Model reloaded. LM Studio reports ${fmtCtx(actual)} context (requested ${fmtCtx(draftCtx)}).`
          : `Model reloaded with ${fmtCtx(actual)} context.`
        setResult({ ok: true, msg })
      } else {
        setResult({ ok: false, msg: res.error ?? 'Reload failed — check LM Studio.' })
      }
    } catch (err) {
      setResult({ ok: false, msg: (err as Error).message })
    } finally {
      setReloading(false)
    }
  }, [changed, reloading, draftModel, draftCtx, setSelectedModel])

  // ── Close guard — ignore clicks when reloading ────────────────
  const safeClose = useCallback(() => {
    if (reloading) return
    onClose()
  }, [reloading, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="settings-overlay"
          variants={overlayVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(10,10,10,0.80)', backdropFilter: 'blur(6px)' }}
          onClick={safeClose}
        >
          {/* Ambient red glow */}
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] h-80 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgba(139,0,0,0.07) 0%, transparent 70%)' }}
          />

          {/* Modal card */}
          <motion.div
            key="settings-card"
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md mx-4 rounded-2xl border border-surface-border/60 overflow-hidden"
            style={{
              background:  '#1a1a1a',
              boxShadow:   '0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.03)',
            }}
          >
            {/* ── Header ── */}
            <div
              className="flex items-center justify-between px-6 py-4 border-b border-surface-border/60"
              style={{ background: '#141414' }}
            >
              <div className="flex items-center gap-2.5">
                <Settings className="w-4 h-4 text-accent-500" />
                <span className="text-sm font-semibold text-content-primary tracking-wide">
                  Model Settings
                </span>
              </div>
              <button
                onClick={safeClose}
                disabled={reloading}
                className="p-1.5 rounded-lg text-content-muted hover:text-content-secondary
                           hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed
                           transition-colors duration-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ── Body ── */}
            <div className="px-6 py-5 space-y-6">

              {/* Active model — editable selector */}
              <div>
                <p className="text-[10px] font-semibold tracking-widest uppercase text-content-muted mb-2">
                  Active Model
                </p>
                {loading ? (
                  <div
                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-surface-border/60"
                    style={{ background: '#111' }}
                  >
                    <div className="w-3 h-3 rounded-full border-2 border-neutral-600 border-t-red-500 animate-spin" />
                    <span className="text-xs text-content-muted">Fetching…</span>
                  </div>
                ) : availableModels.length > 0 ? (
                  <div className="relative">
                    <select
                      value={draftModel}
                      onChange={(e) => setDraftModel(e.target.value)}
                      disabled={reloading}
                      className="w-full appearance-none px-3 py-2.5 pr-8 rounded-lg border text-xs font-mono
                                 disabled:opacity-40 focus:outline-none transition-colors"
                      style={{
                        background:  '#111',
                        color:       '#f5f5f5',
                        border:      '1px solid #3a3a3a',
                      }}
                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id} style={{ background: '#111' }}>
                          {m.id}{m.state === 'loaded' ? ' (loaded)' : ''}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none text-content-muted"
                    />
                  </div>
                ) : (
                  /* Fallback when getAvailableModels returned empty (LM Studio not running yet) */
                  <div
                    className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-surface-border/60"
                    style={{ background: '#111' }}
                  >
                    <div
                      className="w-1.5 h-1.5 rounded-full bg-accent-500 flex-shrink-0"
                      style={{ boxShadow: '0 0 6px rgba(220,38,38,0.7)' }}
                    />
                    <span className="text-xs font-mono text-content-secondary truncate">
                      {fetchedModel || '—'}
                    </span>
                  </div>
                )}
              </div>

              {/* Context Length */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] font-semibold tracking-widest uppercase text-content-muted">
                    Context Length
                  </p>
                  {changed && !reloading && (
                    <span className="text-[10px] text-accent-500 font-medium">
                      Changed — reload to apply
                    </span>
                  )}
                </div>
                <p className="text-xs text-content-muted mb-4 leading-relaxed">
                  How much conversation history the model can see.
                  Larger values use more memory and take longer to load.
                </p>

                {/* Number input */}
                <div className="flex items-center gap-3 mb-4">
                  <input
                    type="number"
                    min={MIN_CTX}
                    max={MAX_CTX}
                    step={1024}
                    value={draftCtx}
                    disabled={loading || reloading}
                    onChange={(e) => {
                      const v = Math.max(MIN_CTX, Math.min(MAX_CTX, Number(e.target.value) || MIN_CTX))
                      setDraftCtx(v)
                    }}
                    className="w-28 px-3 py-2 rounded-lg text-sm font-mono text-center
                               focus:outline-none disabled:opacity-40
                               transition-colors duration-100"
                    style={{
                      background:  '#111',
                      color:       '#f5f5f5',
                      border:      '1px solid #3a3a3a',
                    }}
                  />
                  <span className="text-xs text-content-muted">tokens</span>
                  <span className="text-xs text-content-tertiary ml-auto">
                    ≈ {fmtCtx(draftCtx)} context
                  </span>
                </div>

                {/* Slider */}
                <input
                  type="range"
                  min={MIN_CTX}
                  max={MAX_CTX}
                  step={1024}
                  value={draftCtx}
                  disabled={loading || reloading}
                  onChange={(e) => setDraftCtx(Number(e.target.value))}
                  className="w-full accent-red-700 disabled:opacity-40"
                  style={{ cursor: reloading || loading ? 'not-allowed' : 'pointer' }}
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-content-muted">4K</span>
                  <span className="text-[10px] text-content-muted">32K</span>
                  <span className="text-[10px] text-content-muted">64K</span>
                  <span className="text-[10px] text-content-muted">128K</span>
                </div>

                {/* Preset chips */}
                <div className="flex flex-wrap gap-2 mt-4">
                  {PRESETS.map((p) => (
                    <button
                      key={p}
                      disabled={loading || reloading}
                      onClick={() => setDraftCtx(p)}
                      className={`px-2.5 py-1 rounded-md text-xs font-mono transition-all duration-100
                        disabled:opacity-30 disabled:cursor-not-allowed
                        ${draftCtx === p
                          ? 'bg-accent-900/50 border border-accent-700/60 text-accent-400'
                          : 'bg-surface-DEFAULT border border-surface-border text-content-muted hover:text-content-secondary hover:border-surface-borderStrong'
                        }`}
                    >
                      {fmtCtx(p)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Warning note */}
              <div
                className="flex gap-2.5 px-3 py-2.5 rounded-lg border border-amber-900/30"
                style={{ background: 'rgba(120,53,15,0.08)' }}
              >
                <AlertCircle className="w-3.5 h-3.5 text-amber-600/80 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-600/80 leading-relaxed">
                  Reload unloads then reloads the model — takes <strong className="text-amber-500/90">30–60 seconds</strong>.
                  All active chats remain in history.
                </p>
              </div>

              {/* Result banner */}
              <AnimatePresence>
                {result && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className={`flex gap-2.5 px-3 py-2.5 rounded-lg border ${
                      result.ok
                        ? 'border-green-900/40 bg-green-950/20'
                        : 'border-accent-900/40 bg-accent-950/20'
                    }`}
                  >
                    {result.ok
                      ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                      : <AlertCircle  className="w-3.5 h-3.5 text-accent-500 flex-shrink-0 mt-0.5" />
                    }
                    <p className={`text-xs leading-relaxed ${result.ok ? 'text-green-400' : 'text-accent-400'}`}>
                      {result.msg}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* ── Footer ── */}
            <div
              className="px-6 py-4 border-t border-surface-border/60"
              style={{ background: '#141414' }}
            >
              <button
                onClick={handleReload}
                disabled={!changed || reloading || loading}
                className={`w-full flex items-center justify-center gap-2.5
                            px-4 py-2.5 rounded-xl text-sm font-medium
                            transition-all duration-150 focus:outline-none
                            ${changed && !reloading && !loading
                              ? 'bg-accent-900/40 hover:bg-accent-800/50 active:bg-accent-900/60 border border-accent-800/50 hover:border-accent-700/60 text-accent-400 hover:text-accent-300'
                              : 'bg-surface-DEFAULT border border-surface-border text-content-muted cursor-not-allowed opacity-50'
                            }`}
                style={changed && !reloading && !loading ? { boxShadow: '0 0 12px rgba(139,0,0,0.2)' } : {}}
              >
                {reloading ? (
                  <>
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-accent-700 border-t-accent-400 animate-spin" />
                    Reloading model…
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    Reload Model
                    {changed && draftModel !== fetchedModel && (
                      <span className="ml-auto text-[10px] text-accent-600 font-mono truncate max-w-[160px]">
                        new model selected
                      </span>
                    )}
                    {changed && draftCtx !== fetchedCtx && draftModel === fetchedModel && (
                      <span className="ml-auto flex items-center gap-1 text-[10px] text-accent-600 font-mono">
                        {fmtCtx(fetchedCtx ?? 0)} <ChevronRight className="w-3 h-3" /> {fmtCtx(draftCtx)}
                      </span>
                    )}
                  </>
                )}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
