/**
 * StatsBar — "LM Studio style" telemetry row beneath every AI message.
 *
 * States:
 *   isThinking  → pulsing red "Thinking…" (before first token)
 *   isStreaming → live token counter ticking up
 *   done        → final TTFT · t/s · total time
 */

import { useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSignals } from '@preact/signals-react/runtime'
import { signal } from '@preact/signals-react'
import { useComputed } from '@preact/signals-react'
import { Zap, Clock, Timer, StopCircle } from 'lucide-react'
import type { GenerationStats } from '../../../../shared/types'

// ── helpers ──────────────────────────────────────────────────────
function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

// ── Thinking indicator ───────────────────────────────────────────
function ThinkingDots() {
  return (
    <motion.div
      className="flex items-center gap-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="block w-1.5 h-1.5 rounded-full bg-accent-500"
            animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
            transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
            style={{ boxShadow: '0 0 4px rgba(220,38,38,0.6)' }}
          />
        ))}
      </div>
      <span
        className="text-xs font-medium animate-pulse-red"
        style={{ color: '#dc2626' }}
      >
        Thinking…
      </span>
    </motion.div>
  )
}

// ── Stat pill ────────────────────────────────────────────────────
function Pill({ icon: Icon, value, label }: {
  icon: React.ElementType
  value: string
  label: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="w-3 h-3 text-content-muted flex-shrink-0" />
      <span className="text-content-primary text-[11px] font-mono font-medium tabular-nums">
        {value}
      </span>
      <span className="text-content-muted text-[10px]">{label}</span>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────
interface StatsBarProps {
  isThinking:  boolean   // waiting for first token
  isStreaming: boolean   // first token received, still streaming
  stats:       GenerationStats | null  // populated when done
}

export function StatsBar({ isThinking, isStreaming, stats }: StatsBarProps) {
  useSignals()

  // Wrap stats in a local signal so useComputed can track changes.
  // A new signal is created only once per mount; value is updated each render
  // (in practice, only once — from null → final value at stream-end).
  const statsSignal = useMemo(() => signal<GenerationStats | null>(stats), [])
  statsSignal.value = stats

  const ttftStr   = useComputed(() => { const s = statsSignal.value; return s ? fmt(s.ttft)         : '' })
  const tpsStr    = useComputed(() => { const s = statsSignal.value; return s ? `${s.tokensPerSec}` : '' })
  const totalStr  = useComputed(() => { const s = statsSignal.value; return s ? fmt(s.totalMs)      : '' })
  const tokensStr = useComputed(() => statsSignal.value?.totalTokens.toString() ?? '')

  const showBar = isThinking || isStreaming || stats !== null

  return (
    <AnimatePresence>
      {showBar && (
        <motion.div
          initial={{ opacity: 0, y: 4, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto', transition: { duration: 0.25 } }}
          exit={{ opacity: 0, height: 0, transition: { duration: 0.2 } }}
          className="overflow-hidden"
        >
          <div
            className="mt-3 flex items-center gap-4 px-3 py-2 rounded-lg border border-surface-border/60"
            style={{ background: 'rgba(20,20,20,0.6)' }}
          >
            <AnimatePresence mode="wait">
              {/* ── Thinking ── */}
              {isThinking && (
                <motion.div
                  key="thinking"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <ThinkingDots />
                </motion.div>
              )}

              {/* ── Streaming — live tick ── */}
              {!isThinking && isStreaming && stats === null && (
                <motion.div
                  key="streaming"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-1.5"
                >
                  <motion.span
                    className="block w-1.5 h-1.5 rounded-full bg-accent-500"
                    animate={{ opacity: [1, 0.3, 1] }}
                    transition={{ duration: 0.8, repeat: Infinity }}
                    style={{ boxShadow: '0 0 4px rgba(220,38,38,0.5)' }}
                  />
                  <span className="text-[11px] text-content-tertiary font-mono">
                    Generating…
                  </span>
                </motion.div>
              )}

              {/* ── Done ── */}
              {stats !== null && (
                <motion.div
                  key="done"
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25 }}
                  className="flex items-center gap-4 flex-wrap"
                >
                  <Pill icon={Clock} value={ttftStr.value}   label="ttft"     />
                  <div className="w-px h-3 bg-surface-border/60" />
                  <Pill icon={Zap}   value={tpsStr.value}    label="tok/s"    />
                  <div className="w-px h-3 bg-surface-border/60" />
                  <Pill icon={Timer} value={totalStr.value}  label="total"    />
                  <div className="w-px h-3 bg-surface-border/60" />
                  <span className="text-[10px] text-content-muted font-mono">
                    {tokensStr.value} tokens
                  </span>
                  {stats.aborted && (
                    <>
                      <div className="w-px h-3 bg-surface-border/60" />
                      <span className="flex items-center gap-1 text-[10px] text-accent-600">
                        <StopCircle className="w-3 h-3" />stopped
                      </span>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
