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

      {/* ── Daemon error banner — disabled (P1 OPEN: never clears after recovery) ── */}

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
