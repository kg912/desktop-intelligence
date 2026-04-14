import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, AlertCircle, CheckCircle2, ChevronRight, ChevronDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useModelStore } from '../../store/ModelStore'
import type { AvailableModel } from '../../../../shared/types'

const PRESETS = [4096, 8192, 16384, 32768, 65536, 131072]
const MIN_CTX = 4096
const MAX_CTX = 131072

function fmtCtx(n: number): string {
  if (n >= 1024) return `${Math.round(n / 1024)}K`
  return String(n)
}

export function ModelSettingsPanel() {
  const { setSelectedModel } = useModelStore()

  const [fetchedCtx,          setFetchedCtx]          = useState<number | null>(null)
  const [fetchedModel,        setFetchedModel]        = useState<string>('')
  const [draftCtx,            setDraftCtx]            = useState<number>(32768)
  const [draftModel,          setDraftModel]          = useState<string>('')
  const [availableModels,     setAvailableModels]     = useState<AvailableModel[]>([])
  const [loading,             setLoading]             = useState(false)
  const [reloading,           setReloading]           = useState(false)
  const [result,              setResult]              = useState<{ ok: boolean; msg: string } | null>(null)

  const [draftTemp,           setDraftTemp]           = useState(0.7)
  const [draftTopP,           setDraftTopP]           = useState(0.95)
  const [draftMaxTokens,      setDraftMaxTokens]      = useState(16384)
  const [draftRepeatPenalty,  setDraftRepeatPenalty]  = useState(1.1)
  const [draftSysPrompt,      setDraftSysPrompt]      = useState('')
  const [draftGpuOffload,     setDraftGpuOffload]     = useState(false)

  const [fetchedTemp,         setFetchedTemp]         = useState(0.7)
  const [fetchedTopP,         setFetchedTopP]         = useState(0.95)
  const [fetchedMaxTokens,    setFetchedMaxTokens]    = useState(16384)
  const [fetchedRepeatPenalty,setFetchedRepeatPenalty]= useState(1.1)
  const [fetchedSysPrompt,    setFetchedSysPrompt]    = useState('')
  const [fetchedGpuOffload,   setFetchedGpuOffload]   = useState(false)

  const changed = fetchedCtx !== null && (
    draftCtx           !== fetchedCtx           ||
    draftModel         !== fetchedModel         ||
    draftTemp          !== fetchedTemp          ||
    draftTopP          !== fetchedTopP          ||
    draftMaxTokens     !== fetchedMaxTokens     ||
    draftRepeatPenalty !== fetchedRepeatPenalty ||
    draftSysPrompt     !== fetchedSysPrompt     ||
    draftGpuOffload    !== fetchedGpuOffload
  )

  useEffect(() => {
    setLoading(true)
    Promise.all([
      window.api.getModelConfig(),
      window.api.getAvailableModels(),
    ])
      .then(([cfg, models]) => {
        const ctx  = Math.min(Math.max(cfg.contextLength, MIN_CTX), MAX_CTX)
        const temp = cfg.temperature     ?? 0.7
        const tp   = cfg.topP            ?? 0.95
        const mt   = cfg.maxOutputTokens ?? 16384
        const rp   = cfg.repeatPenalty   ?? 1.1
        const sp   = cfg.systemPrompt    ?? ''
        const gpu  = cfg.gpuOffload      ?? false
        setFetchedCtx(ctx);     setDraftCtx(ctx)
        setFetchedModel(cfg.modelId); setDraftModel(cfg.modelId)
        setFetchedTemp(temp);   setDraftTemp(temp)
        setFetchedTopP(tp);     setDraftTopP(tp)
        setFetchedMaxTokens(mt); setDraftMaxTokens(mt)
        setFetchedRepeatPenalty(rp); setDraftRepeatPenalty(rp)
        setFetchedSysPrompt(sp); setDraftSysPrompt(sp)
        setFetchedGpuOffload(gpu); setDraftGpuOffload(gpu)
        setAvailableModels(models)
      })
      .catch(() => {
        setFetchedCtx(32768);   setDraftCtx(32768)
        setFetchedModel('unknown'); setDraftModel('unknown')
        setAvailableModels([])
      })
      .finally(() => setLoading(false))
  }, [])

  const handleReload = useCallback(async () => {
    if (!changed || reloading) return
    setReloading(true)
    setResult(null)
    try {
      const res = await window.api.reloadModel({
        modelId:          draftModel,
        contextLength:    draftCtx,
        temperature:      draftTemp,
        topP:             draftTopP,
        maxOutputTokens:  draftMaxTokens,
        repeatPenalty:    draftRepeatPenalty,
        systemPrompt:     draftSysPrompt,
        gpuOffload:       draftGpuOffload,
      })
      if (res.success) {
        const actual = res.confirmedCtx ?? draftCtx
        setFetchedCtx(actual);        setDraftCtx(actual)
        setFetchedModel(draftModel);  setSelectedModel(draftModel)
        setFetchedTemp(draftTemp)
        setFetchedTopP(draftTopP)
        setFetchedMaxTokens(draftMaxTokens)
        setFetchedRepeatPenalty(draftRepeatPenalty)
        setFetchedSysPrompt(draftSysPrompt)
        setFetchedGpuOffload(draftGpuOffload)
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
  }, [changed, reloading, draftModel, draftCtx, draftTemp, draftTopP, draftMaxTokens, draftRepeatPenalty, draftSysPrompt, draftGpuOffload, setSelectedModel])

  return (
    <div className="space-y-6">
      {/* Active model selector */}
      <div>
        <p className="text-[10px] font-semibold tracking-widest uppercase text-content-muted mb-2">
          Active Model
        </p>
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-surface-border/60" style={{ background: '#111' }}>
            <div className="w-3 h-3 rounded-full border-2 border-neutral-600 border-t-red-500 animate-spin" />
            <span className="text-xs text-content-muted">Fetching…</span>
          </div>
        ) : availableModels.length > 0 ? (
          <div className="relative">
            <select
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              disabled={reloading}
              className="w-full appearance-none px-3 py-2.5 pr-8 rounded-lg border text-xs font-mono disabled:opacity-40 focus:outline-none transition-colors"
              style={{ background: '#111', color: '#f5f5f5', border: '1px solid #3a3a3a' }}
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id} style={{ background: '#111' }}>
                  {m.id}{m.state === 'loaded' ? ' (loaded)' : ''}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none text-content-muted" />
          </div>
        ) : (
          <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-surface-border/60" style={{ background: '#111' }}>
            <div
              className="w-1.5 h-1.5 rounded-full bg-accent-500 flex-shrink-0"
              style={{ boxShadow: '0 0 6px rgba(220,38,38,0.7)' }}
            />
            <span className="text-xs font-mono text-content-secondary truncate">{fetchedModel || '—'}</span>
          </div>
        )}
      </div>

      {/* Context Length */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10px] font-semibold tracking-widest uppercase text-content-muted">Context Length</p>
          {changed && !reloading && (
            <span className="text-[10px] text-accent-500 font-medium">Changed — reload to apply</span>
          )}
        </div>
        <p className="text-xs text-content-muted mb-4 leading-relaxed">
          How much conversation history the model can see. Larger values use more memory and take longer to load.
        </p>
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
            className="w-28 px-3 py-2 rounded-lg text-sm font-mono text-center focus:outline-none disabled:opacity-40 transition-colors duration-100"
            style={{ background: '#111', color: '#f5f5f5', border: '1px solid #3a3a3a' }}
          />
          <span className="text-xs text-content-muted">tokens</span>

          {/* Right side: GPU Offload toggle + context label */}
          <div className="ml-auto flex items-center gap-4">
            {/* GPU Offload pill toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none" title="Offload all model layers to GPU for maximum throughput (--gpu max)">
              <span className="text-[10px] text-content-muted tracking-wide whitespace-nowrap">GPU Offload</span>
              <button
                type="button"
                role="switch"
                aria-checked={draftGpuOffload}
                onClick={() => setDraftGpuOffload((v) => !v)}
                disabled={loading || reloading}
                className={`relative inline-flex w-7 h-4 rounded-full transition-colors duration-150 focus:outline-none disabled:opacity-40 flex-shrink-0 ${
                  draftGpuOffload ? 'bg-accent-700' : 'bg-surface-border'
                }`}
              >
                <span
                  className={`inline-block w-3 h-3 mt-0.5 rounded-full bg-white shadow transition-transform duration-150 ${
                    draftGpuOffload ? 'translate-x-3.5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </label>
            <span className="text-xs text-content-tertiary whitespace-nowrap">≈ {fmtCtx(draftCtx)} context</span>
          </div>
        </div>
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
        <div className="flex flex-wrap gap-2 mt-4">
          {PRESETS.map((p) => (
            <button
              key={p}
              disabled={loading || reloading}
              onClick={() => setDraftCtx(p)}
              className={`px-2.5 py-1 rounded-md text-xs font-mono transition-all duration-100 disabled:opacity-30 disabled:cursor-not-allowed ${
                draftCtx === p
                  ? 'bg-accent-900/50 border border-accent-700/60 text-accent-400'
                  : 'bg-surface-DEFAULT border border-surface-border text-content-muted hover:text-content-secondary hover:border-surface-borderStrong'
              }`}
            >
              {fmtCtx(p)}
            </button>
          ))}
        </div>
      </div>

      {/* Generation Parameters */}
      <div>
        <p className="text-[10px] font-semibold tracking-widest uppercase text-content-muted mb-3">
          Generation Parameters
        </p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5">
          {/* Temperature */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-content-secondary">Temperature</span>
              <span className="text-xs text-content-secondary font-mono">{draftTemp.toFixed(2)}</span>
            </div>
            <input
              type="range" min={0} max={2} step={0.05}
              value={draftTemp}
              disabled={loading || reloading}
              onChange={(e) => setDraftTemp(Number(e.target.value))}
              className="w-full accent-red-700 disabled:opacity-40"
              style={{ cursor: loading || reloading ? 'not-allowed' : 'pointer' }}
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-[10px] text-content-muted">0</span>
              <span className="text-[10px] text-content-muted">2</span>
            </div>
          </div>

          {/* Top P */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-content-secondary">Top P</span>
              <span className="text-xs text-content-secondary font-mono">{draftTopP.toFixed(2)}</span>
            </div>
            <input
              type="range" min={0} max={1} step={0.01}
              value={draftTopP}
              disabled={loading || reloading}
              onChange={(e) => setDraftTopP(Number(e.target.value))}
              className="w-full accent-red-700 disabled:opacity-40"
              style={{ cursor: loading || reloading ? 'not-allowed' : 'pointer' }}
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-[10px] text-content-muted">0</span>
              <span className="text-[10px] text-content-muted">1</span>
            </div>
          </div>

          {/* Max Output Tokens */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-content-secondary">Max Output Tokens</span>
            </div>
            <input
              type="number" min={512} max={65536} step={512}
              value={draftMaxTokens}
              disabled={loading || reloading}
              onChange={(e) => {
                const v = Math.max(512, Math.min(65536, Number(e.target.value) || 512))
                setDraftMaxTokens(v)
              }}
              className="w-full px-3 py-2 rounded-lg text-sm font-mono text-center focus:outline-none disabled:opacity-40 transition-colors duration-100"
              style={{ background: '#111', color: '#f5f5f5', border: '1px solid #3a3a3a' }}
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-[10px] text-content-muted">512</span>
              <span className="text-[10px] text-content-muted">65536</span>
            </div>
          </div>

          {/* Repeat Penalty */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-content-secondary">Repeat Penalty</span>
              <span className="text-xs text-content-secondary font-mono">{draftRepeatPenalty.toFixed(2)}</span>
            </div>
            <input
              type="range" min={1.0} max={1.5} step={0.01}
              value={draftRepeatPenalty}
              disabled={loading || reloading}
              onChange={(e) => setDraftRepeatPenalty(Number(e.target.value))}
              className="w-full accent-red-700 disabled:opacity-40"
              style={{ cursor: loading || reloading ? 'not-allowed' : 'pointer' }}
            />
            <div className="flex justify-between mt-0.5">
              <span className="text-[10px] text-content-muted">1.0</span>
              <span className="text-[10px] text-content-muted">1.5</span>
            </div>
          </div>
        </div>
      </div>

      {/* System Prompt */}
      <div>
        <p className="text-[10px] font-semibold tracking-widest uppercase text-content-muted mb-2">
          System Prompt
        </p>
        <div className="relative">
          <textarea
            value={draftSysPrompt}
            disabled={loading || reloading}
            placeholder="You are a helpful assistant…"
            maxLength={6000}
            onChange={(e) => {
              const v = e.target.value.slice(0, 6000)
              setDraftSysPrompt(v)
            }}
            className="w-full px-3 py-2.5 rounded-lg text-xs text-content-secondary leading-relaxed focus:outline-none disabled:opacity-40 resize-y transition-colors duration-100 placeholder:text-content-muted"
            style={{
              background:    '#111',
              border:        '1px solid #3a3a3a',
              minHeight:     '120px',
              fontFamily:    'inherit',
            }}
          />
          <span
            className={`absolute bottom-2 right-2.5 text-[10px] pointer-events-none select-none ${
              draftSysPrompt.length >= 6000 ? 'text-red-500' : 'text-content-muted'
            }`}
          >
            {draftSysPrompt.length} / 6000
          </span>
        </div>
      </div>

      {/* Warning */}
      <div className="flex gap-2.5 px-3 py-2.5 rounded-lg border border-amber-900/30" style={{ background: 'rgba(120,53,15,0.08)' }}>
        <AlertCircle className="w-3.5 h-3.5 text-amber-600/80 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-600/80 leading-relaxed">
          Reload unloads then reloads the model — takes <strong className="text-amber-500/90">30–60 seconds</strong>.
          All active chats remain in history.
        </p>
      </div>

      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`flex gap-2.5 px-3 py-2.5 rounded-lg border ${
              result.ok ? 'border-green-900/40 bg-green-950/20' : 'border-accent-900/40 bg-accent-950/20'
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

      <button
        onClick={handleReload}
        disabled={!changed || reloading || loading}
        className={`w-full flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 focus:outline-none ${
          changed && !reloading && !loading
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
              <span className="ml-auto text-[10px] text-accent-600 font-mono truncate max-w-[160px]">new model selected</span>
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
  )
}
