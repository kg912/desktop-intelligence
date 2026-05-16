import { useEffect, useState, useCallback } from 'react'
import { FolderOpen, Trash2 } from 'lucide-react'
import type { SessionEntry } from '../../../../main/services/ObservabilityService'

function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none ${
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'cursor-pointer'
      } ${checked ? 'bg-red-700' : 'bg-surface-border'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

function Row({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div
      className={`flex items-start justify-between gap-6 py-4 border-b border-surface-border/30 ${
        disabled ? 'opacity-50' : ''
      }`}
      style={disabled ? { pointerEvents: 'none' } : undefined}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-content-primary mb-0.5">{label}</p>
        <p className="text-xs text-content-muted leading-relaxed">{description}</p>
      </div>
      <div className="flex-shrink-0 mt-0.5">
        <Toggle checked={checked} onChange={onChange} disabled={disabled} />
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function truncateModel(modelId: string): string {
  return modelId.length > 28 ? modelId.slice(0, 28) + '…' : modelId
}

export function DebugSettings() {
  const [observabilityEnabled, setObservabilityEnabled] = useState(false)
  const [includeImages,        setIncludeImages]        = useState(false)
  const [sessions,             setSessions]             = useState<SessionEntry[]>([])
  const [sessionCount,         setSessionCount]         = useState(0)
  const [totalBytes,           setTotalBytes]           = useState(0)
  const [confirmClear,         setConfirmClear]         = useState(false)

  const refreshStats = useCallback(async () => {
    const [list, bytes] = await Promise.all([
      window.api.obsListSessions(),
      window.api.obsTotalSize(),
    ])
    setSessions(list)
    setSessionCount(list.length)
    setTotalBytes(bytes)
  }, [])

  useEffect(() => {
    window.api.obsGetPrefs()
      .then((prefs) => {
        setObservabilityEnabled(prefs.observabilityEnabled)
        setIncludeImages(prefs.includeImages)
      })
      .catch(console.error)
    refreshStats().catch(console.error)
  }, [refreshStats])

  const handleObsToggle = (v: boolean) => {
    setObservabilityEnabled(v)
    window.api.obsSetPrefs({ observabilityEnabled: v }).catch(console.error)
    void refreshStats()
  }

  const handleImagesToggle = (v: boolean) => {
    setIncludeImages(v)
    window.api.obsSetPrefs({ includeImages: v }).catch(console.error)
  }

  const handleOpenDir = async () => {
    try {
      const dir = await window.api.obsGetLogsDir()
      await window.api.obsOpenSession(dir)
    } catch (err) {
      console.error('[DebugSettings] openDir failed:', err)
    }
  }

  const handleOpenSession = useCallback(async (filePath: string) => {
    try {
      await window.api.obsOpenSession(filePath)
    } catch (err) {
      console.error('[DebugSettings] openSession failed:', err)
    }
  }, [])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await window.api.obsDeleteSession(sessionId)
      await refreshStats()
    } catch (err) {
      console.error('[DebugSettings] deleteSession failed:', err)
    }
  }, [refreshStats])

  const handleClearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setConfirmClear(false)
    try {
      await window.api.obsClearAll()
      await refreshStats()
    } catch (err) {
      console.error('[DebugSettings] clearAll failed:', err)
    }
  }

  return (
    <div className="space-y-8">
      {/* ── Toggle rows ── */}
      <div>
        <Row
          label="Observability"
          description="Capture the full session log — system prompt, RAG context, tool calls and results, thinking, and the final answer. Logs are saved locally and never leave your device."
          checked={observabilityEnabled}
          onChange={handleObsToggle}
        />
        <Row
          label="Include Images"
          description="Embed rendered charts and image outputs in log folders as separate image files with a linked Markdown log. (Off by default — image logs can be large.)"
          checked={includeImages}
          onChange={handleImagesToggle}
          disabled={!observabilityEnabled}
        />
      </div>

      {/* ── Log list section ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] font-semibold tracking-widest uppercase text-content-muted">
            Observability Logs
          </p>
          <div className="flex items-center gap-3">
            <span className="text-xs text-content-muted">
              {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'} · {formatBytes(totalBytes)}
            </span>
            <button
              onClick={handleOpenDir}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs
                         border border-surface-border text-content-secondary
                         hover:text-content-primary hover:border-surface-borderStrong
                         transition-colors duration-100"
            >
              <FolderOpen className="w-3 h-3" />
              Open
            </button>
          </div>
        </div>

        <div
          className="rounded-xl border border-surface-border/40 overflow-hidden"
          style={{ background: '#111' }}
        >
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
              <p className="text-sm text-content-muted mb-1">No logs yet.</p>
              <p className="text-xs text-content-muted/60 leading-relaxed">
                Enable Observability and run a chat to capture a log.
              </p>
            </div>
          ) : (
            sessions.map((entry, idx) => (
              <div
                key={entry.sessionId}
                onClick={() => void handleOpenSession(entry.filePath)}
                className={`group flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-surface-hover transition-colors duration-100 ${
                  idx < sessions.length - 1 ? 'border-b border-surface-border/20' : ''
                }`}
              >
                {/* Date / time */}
                <span className="text-xs text-content-secondary whitespace-nowrap flex-shrink-0">
                  {new Date(entry.startedAt).toLocaleString()}
                </span>

                {/* Model */}
                <span className="text-xs font-mono text-content-primary flex-1 min-w-0 truncate">
                  {truncateModel(entry.modelId)}
                </span>

                {/* Provider pill */}
                <span className="text-xs text-content-muted border border-surface-border/60 rounded px-1.5 py-0.5 flex-shrink-0">
                  {entry.provider}
                </span>

                {/* Type badge */}
                {entry.hasImages ? (
                  <span className="text-xs text-content-secondary border border-accent-900/60 rounded px-1.5 py-0.5 flex-shrink-0">
                    +images
                  </span>
                ) : (
                  <span className="text-xs text-content-muted border border-surface-border/40 rounded px-1.5 py-0.5 flex-shrink-0">
                    plain
                  </span>
                )}

                {/* Size */}
                <span className="text-xs text-content-muted flex-shrink-0 w-16 text-right">
                  {formatBytes(entry.sizeBytes)}
                </span>

                {/* Delete button — hover-reveal */}
                <button
                  onClick={(e) => { e.stopPropagation(); void handleDeleteSession(entry.sessionId) }}
                  className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1 rounded
                             text-content-muted hover:text-red-400 transition-all duration-100"
                  aria-label="Delete session"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Clear all */}
        <div className="flex justify-end mt-3">
          {confirmClear ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-content-muted">Are you sure?</span>
              <button
                onClick={handleClearAll}
                className="px-3 py-1.5 rounded-md text-xs font-medium
                           bg-red-900/30 border border-red-800/50 text-red-400
                           hover:bg-red-900/50 transition-colors duration-100"
              >
                Yes, clear all
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="px-3 py-1.5 rounded-md text-xs
                           border border-surface-border text-content-muted
                           hover:text-content-secondary transition-colors duration-100"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={handleClearAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs
                         border border-surface-border text-content-muted
                         hover:text-content-secondary hover:border-surface-borderStrong
                         transition-colors duration-100"
            >
              <Trash2 className="w-3 h-3" />
              Clear All Logs
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
