import { useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { ConnectionStatus } from './components/ConnectionStatus'
import { Layout } from './components/layout/Layout'
import { useModelConnection } from './hooks/useModelConnection'
import type { DaemonState } from '../../shared/types'

export default function App() {
  const { status, modelInfo, error, retry } = useModelConnection()

  // Show app shell once model is ready. Use a simple CSS transition —
  // no Framer Motion initial:0 so the preview environment shows content immediately.
  const [appVisible, setAppVisible] = useState(false)

  useEffect(() => {
    if (status === 'ready' && !appVisible) {
      // Small delay so the connection overlay exit animation has time to play
      const t = setTimeout(() => setAppVisible(true), 300)
      return () => clearTimeout(t)
    }
    return undefined
  }, [status, appVisible])

  // Daemon error banner
  const [daemonState, setDaemonState] = useState<DaemonState>({
    phase: 'idle', error: null, stderr: null
  })

  useEffect(() => {
    window.api.getDaemonState().then(setDaemonState).catch(console.error)
    return window.api.onDaemonStateChange(setDaemonState)
  }, [])

  const retryDaemon = () =>
    window.api.retryDaemon().then(setDaemonState).catch(console.error)

  return (
    <div className="h-full w-full bg-background relative overflow-hidden">

      {/* ── Connection overlay ── */}
      <ConnectionStatus status={status} error={error} onRetry={retry} />

      {/* ── Daemon error banner ── */}
      <AnimatePresence>
        {daemonState.phase === 'error' && appVisible && (
          <div className="fixed top-0 inset-x-0 z-30 flex items-center justify-between
                          px-5 py-2 bg-accent-950/90 border-b border-accent-900/50
                          backdrop-blur-sm">
            <span className="text-xs text-accent-400">
              LMS Daemon error — {daemonState.error}
            </span>
            <button
              onClick={retryDaemon}
              className="text-xs px-3 py-1 rounded-lg bg-accent-900/50 border
                         border-accent-800/40 text-accent-400 hover:text-accent-300
                         transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </AnimatePresence>

      {/* ── App shell — CSS transition so preview env can't block it ── */}
      <div
        className="h-full w-full transition-opacity duration-500"
        style={{ opacity: appVisible ? 1 : 0, pointerEvents: appVisible ? 'auto' : 'none' }}
      >
        <Layout />
      </div>
    </div>
  )
}
