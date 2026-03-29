import { useEffect, useState, useCallback } from 'react'
import { ConnectionStatus } from './components/ConnectionStatus'
import { Layout } from './components/layout/Layout'
import { FirstLaunchModal } from './components/settings/FirstLaunchModal'
import { useModelConnection } from './hooks/useModelConnection'
import { useModelStore } from './store/ModelStore'
import type { DaemonState } from '../../shared/types'

export default function App() {
  const { status, error, retry } = useModelConnection()
  const { setSelectedModel } = useModelStore()

  const [appVisible,  setAppVisible]  = useState(false)
  const [firstLaunch, setFirstLaunch] = useState<boolean | null>(null)
  const [daemonState, setDaemonState] = useState<DaemonState>({
    phase: 'idle', error: null, stderr: null
  })

  // Determine first-launch status.
  // For returning users, also restore the saved model ID into the store.
  useEffect(() => {
    window.api.isFirstLaunch()
      .then(async (isFirst) => {
        if (!isFirst) {
          // Returning user — restore model ID into the store so TopBar shows it
          try {
            const cfg = await window.api.getModelConfig()
            if (cfg.modelId) setSelectedModel(cfg.modelId)
          } catch { /* non-fatal — model name will be empty until next getModelConfig */ }
        }
        setFirstLaunch(isFirst)
      })
      .catch(() => setFirstLaunch(false))
  }, [setSelectedModel])

  // Show app shell once model is ready
  useEffect(() => {
    if (status === 'ready' && !appVisible) {
      const t = setTimeout(() => setAppVisible(true), 300)
      return () => clearTimeout(t)
    }
    return undefined
  }, [status, appVisible])

  // Daemon error banner state
  useEffect(() => {
    window.api.getDaemonState().then(setDaemonState).catch(console.error)
    return window.api.onDaemonStateChange(setDaemonState)
  }, [])

  // Called by FirstLaunchModal once the model has been loaded successfully
  const handleFirstLaunchComplete = useCallback((modelId: string) => {
    setSelectedModel(modelId)
    setFirstLaunch(false)
    // Trigger an immediate connection poll so ConnectionStatus transitions fast
    window.api.forcePoll().catch(console.error)
  }, [setSelectedModel])

  // Still determining first-launch status — render nothing to avoid flicker
  if (firstLaunch === null) return null

  // Suppress unused variable warning for daemonState (banner is P1 OPEN)
  void daemonState

  return (
    <div className="h-full w-full bg-background relative overflow-hidden">

      {/* ── First-launch onboarding (replaces polling overlay on first run) ── */}
      {firstLaunch ? (
        <FirstLaunchModal onComplete={handleFirstLaunchComplete} />
      ) : (
        /* ── Connection overlay (returning users only) ── */
        <ConnectionStatus status={status} error={error} onRetry={retry} />
      )}

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
