import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Wifi, WifiOff, RefreshCw, AlertCircle } from 'lucide-react'
import type { ModelStatus, BackendProvider } from '../../../shared/types'

// Cloud backends never poll a local server — the main process returns a
// synthetic 'ready' state for them, so the overlay must never appear.
const CLOUD_PROVIDERS: readonly BackendProvider[] = ['nvidia', 'ollama', 'openrouter']

const MTPLX_DEFAULT_BASE_URL = 'http://localhost:8000'

/** Human-readable backend name shown in the overlay headings. */
function providerLabel(provider: BackendProvider): string {
  return provider === 'mtplx' ? 'MTPLX' : 'LM Studio'
}

/**
 * host:port shown under "Polling …". LM Studio's port is fixed; MTPLX's is
 * user-configurable, so it is derived from the saved base URL.
 */
function providerHostDisplay(provider: BackendProvider, mtplxBaseUrl: string): string {
  if (provider !== 'mtplx') return 'localhost:1234'
  try {
    return new URL(mtplxBaseUrl || MTPLX_DEFAULT_BASE_URL).host
  } catch {
    // Unparseable saved value — fall back to the documented default rather
    // than rendering a broken string.
    return new URL(MTPLX_DEFAULT_BASE_URL).host
  }
}

// ----------------------------------------------------------------
// Phase variants for Framer Motion
// ----------------------------------------------------------------
const overlayVariants = {
  initial:  { opacity: 0 },
  animate:  { opacity: 1, transition: { duration: 0.3 } },
  exit:     { opacity: 0, transition: { duration: 0.4, ease: 'easeInOut' } }
}

const cardVariants = {
  initial:  { opacity: 0, scale: 0.92, y: 16 },
  animate:  {
    opacity: 1, scale: 1, y: 0,
    transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] }
  },
  exit:     {
    opacity: 0, scale: 0.95, y: -8,
    transition: { duration: 0.35, ease: 'easeIn' }
  }
}

// ----------------------------------------------------------------
// Status-specific sub-components
// ----------------------------------------------------------------

function LoadingView() {
  return (
    <div className="flex flex-col items-center gap-6">
      <motion.div
        className="relative"
        animate={{ rotate: 360 }}
        transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
      >
        <div className="w-16 h-16 rounded-full border-2 border-surface-border border-t-accent-500"
             style={{ boxShadow: '0 0 20px rgba(220,38,38,0.3)' }} />
      </motion.div>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-content-primary">Initializing</h2>
        <p className="text-sm text-content-tertiary mt-1">Starting up Desktop Intelligence…</p>
      </div>
    </div>
  )
}

function ConnectingView({
  label,
  hostDisplay
}: {
  label:       string
  hostDisplay: string
}) {
  return (
    <div className="flex flex-col items-center gap-6">
      {/* Pulsing red orb */}
      <div className="relative flex items-center justify-center">
        <motion.div
          className="absolute w-20 h-20 rounded-full bg-accent-900/30"
          animate={{ scale: [1, 1.5, 1], opacity: [0.4, 0, 0.4] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute w-14 h-14 rounded-full bg-accent-800/40"
          animate={{ scale: [1, 1.3, 1], opacity: [0.6, 0.1, 0.6] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
        />
        <div className="relative z-10 w-10 h-10 rounded-full bg-accent-900/60 flex items-center justify-center"
             style={{ boxShadow: '0 0 16px rgba(220,38,38,0.5)' }}>
          <Wifi className="w-5 h-5 text-accent-400" />
        </div>
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-content-primary">Connecting to {label}</h2>
        <p className="text-sm text-content-tertiary mt-1">
          Polling <span className="font-mono text-content-secondary">{hostDisplay}</span>
        </p>
        <motion.div
          className="flex gap-1 justify-center mt-3"
          initial="start"
          animate="end"
        >
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-accent-500"
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
        </motion.div>
      </div>
    </div>
  )
}


function OfflineView({
  error,
  onRetry,
  provider,
  label
}: {
  error:    string | null
  onRetry:  () => void
  provider: BackendProvider
  label:    string
}) {
  return (
    <div className="flex flex-col items-center gap-6">
      <motion.div
        animate={{ x: [-2, 2, -2, 2, 0] }}
        transition={{ duration: 0.4, delay: 0.2 }}
        className="w-16 h-16 rounded-full bg-accent-950/60 flex items-center justify-center"
        style={{ boxShadow: '0 0 16px rgba(139,0,0,0.4)' }}
      >
        <WifiOff className="w-7 h-7 text-accent-500" />
      </motion.div>

      <div className="text-center max-w-xs">
        <h2 className="text-lg font-semibold text-content-primary">{label} Offline</h2>
        {error && (
          <p className="text-sm text-content-tertiary mt-2 leading-relaxed">{error}</p>
        )}
        <div className="mt-4 p-3 rounded-lg bg-surface-DEFAULT border border-surface-border text-left">
          <p className="text-xs text-content-tertiary font-medium mb-1 flex items-center gap-1.5">
            <AlertCircle className="w-3 h-3 text-accent-500" />
            Quick fix
          </p>
          {/* These are UI navigation steps for a specific app — they must match
              the backend that is actually offline, not always LM Studio. */}
          {provider === 'mtplx' ? (
            <ol className="text-xs text-content-tertiary space-y-1 list-decimal list-inside">
              <li>Open the MTPLX app</li>
              <li>Click <span className="font-mono text-content-secondary">▶ Start serving</span></li>
              <li>
                Or run <span className="font-mono text-content-secondary">mtplx serve</span> from a terminal
              </li>
            </ol>
          ) : (
            <ol className="text-xs text-content-tertiary space-y-1 list-decimal list-inside">
              <li>Open LM Studio</li>
              <li>Go to <span className="font-mono text-content-secondary">Local Server</span> tab</li>
              <li>Click <span className="font-mono text-content-secondary">Start Server</span></li>
              <li>Load your model in the Local Server tab</li>
            </ol>
          )}
        </div>
      </div>

      <button
        onClick={onRetry}
        className="flex items-center gap-2 px-5 py-2.5 rounded-lg
                   bg-accent-900/40 hover:bg-accent-800/50 active:bg-accent-900/60
                   border border-accent-800/50 hover:border-accent-700/60
                   text-accent-400 hover:text-accent-300
                   text-sm font-medium
                   transition-all duration-150
                   focus:outline-none focus:ring-2 focus:ring-accent-600/50"
        style={{ boxShadow: '0 0 12px rgba(139,0,0,0.2)' }}
      >
        <RefreshCw className="w-4 h-4" />
        Retry Connection
      </button>
    </div>
  )
}

// ----------------------------------------------------------------
// Main ConnectionStatus overlay
// Renders on top of everything until status === 'ready',
// then fades out to reveal the main chat UI.
// Self-subscribes to model status changes to get the active provider —
// this avoids requiring App.tsx to pass provider as a prop.
// ----------------------------------------------------------------
interface ConnectionStatusProps {
  status:    ModelStatus
  error:     string | null
  onRetry:   () => void
}

export function ConnectionStatus({
  status,
  error,
  onRetry
}: ConnectionStatusProps) {
  const [provider, setProvider]         = useState<BackendProvider>('lmstudio')
  const [mtplxBaseUrl, setMtplxBaseUrl] = useState(MTPLX_DEFAULT_BASE_URL)

  useEffect(() => {
    window.api.getBackendSettings()
      .then((s) => {
        setProvider(s.provider)
        setMtplxBaseUrl(s.mtplxBaseUrl ?? MTPLX_DEFAULT_BASE_URL)
      })
      .catch(() => {/* non-fatal */})
  }, [])

  // Cloud backends never show this overlay. The main process returns a synthetic
  // 'ready' state for them, but there is a brief window on startup — before the
  // first getModelStatus() resolves — where status is still 'loading' and the
  // overlay would otherwise flash the wrong backend's name.
  const isVisible = status !== 'ready' && !CLOUD_PROVIDERS.includes(provider)

  const label       = providerLabel(provider)
  const hostDisplay = providerHostDisplay(provider, mtplxBaseUrl)

  return (
    <AnimatePresence mode="wait">
      {isVisible && (
        <motion.div
          key="connection-overlay"
          variants={overlayVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(15,15,15,0.97)', backdropFilter: 'blur(8px)' }}
        >
          {/* Subtle red ambient glow in the background */}
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
                       w-96 h-96 rounded-full pointer-events-none"
            style={{
              background: 'radial-gradient(circle, rgba(139,0,0,0.08) 0%, transparent 70%)'
            }}
          />

          {/* Status card */}
          <AnimatePresence mode="wait">
            <motion.div
              key={status}
              variants={cardVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="relative z-10 flex flex-col items-center p-10
                         rounded-2xl bg-background-elevated/80
                         border border-surface-border/50"
              style={{ boxShadow: '0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03)' }}
            >
              {status === 'loading'    && <LoadingView />}
              {status === 'connecting' && <ConnectingView label={label} hostDisplay={hostDisplay} />}
              {status === 'offline'    && (
                <OfflineView error={error} onRetry={onRetry} provider={provider} label={label} />
              )}
            </motion.div>
          </AnimatePresence>

          {/* App name watermark */}
          <div className="absolute bottom-8 text-center">
            <p className="text-xs text-content-muted tracking-widest uppercase">
              Desktop Intelligence
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
