import { useState, useEffect, useCallback } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Trash2,
  Plug,
  AlertCircle,
  CheckCircle,
  Loader,
  Circle,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import type { McpServerRuntimeInfo, McpServerSettings } from '../../../../shared/types'

// ── Toggle — matches MCPSettingsPanel exactly ────────────────────
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none ${
        checked ? 'bg-red-700' : 'bg-surface-border'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

// ── Status badge ────────────────────────────────────────────────

function StatusBadge({ status }: { status: McpServerRuntimeInfo['status'] }) {
  if (status === 'running') {
    return (
      <span className="flex items-center gap-1 text-xs text-green-400">
        <CheckCircle className="w-3 h-3" /> running
      </span>
    )
  }
  if (status === 'starting') {
    return (
      <span className="flex items-center gap-1 text-xs text-yellow-400">
        <Loader className="w-3 h-3 animate-spin" /> starting
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-xs text-red-400">
        <AlertCircle className="w-3 h-3" /> error
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-xs text-content-muted">
      <Circle className="w-3 h-3" /> stopped
    </span>
  )
}

// ── Single server card ───────────────────────────────────────────

interface ServerCardProps {
  info:        McpServerRuntimeInfo
  onRestart:   (name: string) => void
  onRemove:    (name: string) => void
  onToggleTool: (serverName: string, toolName: string, enabled: boolean) => void
}

function ServerCard({ info, onRestart, onRemove, onToggleTool }: ServerCardProps) {
  const [expanded,   setExpanded]   = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [removing,   setRemoving]   = useState(false)

  const handleRestart = useCallback(async () => {
    setRestarting(true)
    try { await window.api.mcpRestartServer(info.name) } catch { /* logged server-side */ }
    setRestarting(false)
  }, [info.name])

  const handleRemove = useCallback(async () => {
    if (!confirm(`Remove MCP server "${info.name}"?`)) return
    setRemoving(true)
    try { await window.api.mcpRemoveServer(info.name) } catch { /* logged server-side */ }
    setRemoving(false)
  }, [info.name])

  return (
    <div className="rounded-lg border border-surface-border/60 bg-surface-DEFAULT overflow-hidden">
      {/* Header row */}
      <div
        className="flex items-center gap-2.5 px-4 py-3 cursor-pointer hover:bg-surface-hover transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-content-muted flex-shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-content-muted flex-shrink-0" />}
        <Plug className="w-3.5 h-3.5 text-accent-500 flex-shrink-0" />
        <span className="flex-1 text-sm font-medium text-content-primary truncate">{info.name}</span>
        <StatusBadge status={info.status} />
        {/* Action buttons — stop propagation so they don't toggle expand */}
        <button
          onClick={(e) => { e.stopPropagation(); handleRestart() }}
          disabled={restarting}
          className="p-1 rounded text-content-muted hover:text-content-primary disabled:opacity-40 transition-colors no-drag"
          title="Restart server"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', restarting && 'animate-spin')} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); handleRemove() }}
          disabled={removing}
          className="p-1 rounded text-content-muted hover:text-red-400 disabled:opacity-40 transition-colors no-drag"
          title="Remove server"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-3 border-t border-surface-border/40 space-y-2">
          {info.error && (
            <p className="mt-2 text-xs text-red-400 font-mono bg-red-950/20 rounded px-2 py-1.5">{info.error}</p>
          )}
          {info.tools.length > 0 ? (
            <div className="mt-2">
              {(() => {
                const activeCount = info.tools.length - info.disabledTools.length
                return (
                  <>
                    <p className="text-xs text-content-muted mb-1.5">
                      Tools ({activeCount}/{info.tools.length} active)
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {info.tools.map((t) => {
                        const isEnabled = !info.disabledTools.includes(t)
                        return (
                          <button
                            key={t}
                            onClick={() => onToggleTool(info.name, t, !isEnabled)}
                            title={isEnabled ? 'Click to disable' : 'Click to enable'}
                            className={cn(
                              'text-xs px-2 py-0.5 rounded-full border font-mono transition-all cursor-pointer',
                              isEnabled
                                ? 'bg-accent-950/40 border-accent-900/30 text-accent-400 hover:bg-red-950/50 hover:border-red-900/50 hover:text-red-400'
                                : 'bg-surface-hover border-surface-border/40 text-content-muted/50 line-through hover:bg-accent-950/20 hover:text-accent-400/60'
                            )}
                          >
                            {t}
                          </button>
                        )
                      })}
                    </div>
                  </>
                )
              })()}
            </div>
          ) : (
            <p className="mt-2 text-xs text-content-muted italic">No tools discovered</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Add server form ──────────────────────────────────────────────

type AddTab = 'visual' | 'json'

interface AddFormState {
  name:    string
  command: string
  args:    string  // space-separated
  envRaw:  string  // KEY=VALUE lines
  enabled: boolean
}

const EMPTY_FORM: AddFormState = { name: '', command: '', args: '', envRaw: '', enabled: true }

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return env
}

interface AddServerFormProps {
  onAdded: () => void
  onCancel: () => void
}

function AddServerForm({ onAdded, onCancel }: AddServerFormProps) {
  const [activeTab, setActiveTab] = useState<AddTab>('visual')
  const [form, setForm]           = useState<AddFormState>(EMPTY_FORM)
  const [jsonText, setJsonText]   = useState('{\n  "myServer": {\n    "command": "npx",\n    "args": ["-y", "some-mcp-server"],\n    "enabled": true\n  }\n}')
  const [saving, setSaving]       = useState(false)
  const [error,  setError]        = useState<string | null>(null)

  const handleSaveVisual = useCallback(async () => {
    if (!form.name.trim() || !form.command.trim()) {
      setError('Name and command are required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const existing = await window.api.mcpListCustomServers()
      const args = form.args.trim() ? form.args.trim().split(/\s+/) : []
      const env  = parseEnv(form.envRaw)
      existing[form.name.trim()] = {
        command: form.command.trim(),
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        enabled: form.enabled,
      }
      await window.api.mcpSaveCustomServers(existing)
      if (form.enabled) await window.api.mcpRestartServer(form.name.trim())
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }, [form, onAdded])

  const handleSaveJson = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const parsed = JSON.parse(jsonText) as McpServerSettings
      // Auto-inject enabled:true on every entry that omits the field so servers
      // start immediately without requiring users to know about this property.
      for (const name of Object.keys(parsed)) {
        if (parsed[name].enabled === undefined || parsed[name].enabled === null) {
          parsed[name] = { ...parsed[name], enabled: true }
        }
      }
      // Merge with existing config so adding a new server never wipes the others.
      const existing = await window.api.mcpListCustomServers()
      const merged   = { ...existing, ...parsed }
      await window.api.mcpSaveCustomServers(merged)
      for (const name of Object.keys(parsed)) {
        if (parsed[name].enabled) await window.api.mcpRestartServer(name)
      }
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }, [jsonText, onAdded])

  const tabClass = (t: AddTab) => cn(
    'px-3 py-1.5 text-xs font-medium rounded transition-colors',
    activeTab === t
      ? 'bg-accent-950/60 border border-accent-900/40 text-content-primary'
      : 'text-content-muted hover:text-content-secondary',
  )

  return (
    <div className="rounded-lg border border-accent-900/30 bg-surface-DEFAULT p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-content-primary">Add MCP Server</span>
        <div className="flex gap-1">
          <button className={tabClass('visual')} onClick={() => setActiveTab('visual')}>Visual</button>
          <button className={tabClass('json')}   onClick={() => setActiveTab('json')}>mcp.json</button>
        </div>
      </div>

      {activeTab === 'visual' ? (
        <div className="space-y-3">
          {/* Name */}
          <div>
            <label className="text-xs text-content-muted block mb-1">Server name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="my-server"
              className="w-full bg-black/30 border border-surface-border rounded px-3 py-1.5 text-sm text-content-primary placeholder-content-muted focus:outline-none focus:border-accent-800"
            />
          </div>
          {/* Command */}
          <div>
            <label className="text-xs text-content-muted block mb-1">Command</label>
            <input
              type="text"
              value={form.command}
              onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
              placeholder="npx"
              className="w-full bg-black/30 border border-surface-border rounded px-3 py-1.5 text-sm text-content-primary placeholder-content-muted focus:outline-none focus:border-accent-800 font-mono"
            />
          </div>
          {/* Args */}
          <div>
            <label className="text-xs text-content-muted block mb-1">Arguments (space-separated)</label>
            <input
              type="text"
              value={form.args}
              onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
              placeholder="-y some-mcp-package"
              className="w-full bg-black/30 border border-surface-border rounded px-3 py-1.5 text-sm text-content-primary placeholder-content-muted focus:outline-none focus:border-accent-800 font-mono"
            />
          </div>
          {/* Env */}
          <div>
            <label className="text-xs text-content-muted block mb-1">Environment variables (KEY=VALUE, one per line)</label>
            <textarea
              rows={3}
              value={form.envRaw}
              onChange={(e) => setForm((f) => ({ ...f, envRaw: e.target.value }))}
              placeholder={'API_KEY=abc123\nBASE_URL=https://example.com'}
              className="w-full bg-black/30 border border-surface-border rounded px-3 py-1.5 text-sm text-content-primary placeholder-content-muted focus:outline-none focus:border-accent-800 font-mono resize-none"
            />
          </div>
          {/* Enabled toggle */}
          <div className="flex items-center gap-2">
            <Toggle
              checked={form.enabled}
              onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
            />
            <span className="text-xs text-content-secondary">Start server automatically</span>
          </div>
        </div>
      ) : (
        <div>
          <label className="text-xs text-content-muted block mb-1">Paste mcp.json (subset or full)</label>
          <textarea
            rows={10}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            className="w-full bg-black/30 border border-surface-border rounded px-3 py-2 text-xs text-content-primary focus:outline-none focus:border-accent-800 font-mono resize-none"
            spellCheck={false}
          />
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded text-content-muted hover:text-content-primary transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={activeTab === 'visual' ? handleSaveVisual : handleSaveJson}
          disabled={saving}
          className="px-3 py-1.5 text-xs rounded bg-accent-700 hover:bg-accent-600 text-white disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Add Server'}
        </button>
      </div>
    </div>
  )
}

// ── Main panel ───────────────────────────────────────────────────

export function McpToolsPanel() {
  const [servers,    setServers]    = useState<McpServerRuntimeInfo[]>([])
  const [showAdd,    setShowAdd]    = useState(false)
  const [loading,    setLoading]    = useState(true)

  const refreshStatus = useCallback(async () => {
    try {
      const status = await window.api.mcpGetServerStatus()
      setServers(status)
    } catch (err) {
      console.warn('[McpToolsPanel] getServerStatus failed:', err)
    }
  }, [])

  const handleToggleTool = useCallback(async (serverName: string, toolName: string, enabled: boolean) => {
    // Optimistic update — immediately reflect in UI
    setServers(prev => prev.map(s => {
      if (s.name !== serverName) return s
      const disabled = new Set(s.disabledTools)
      if (enabled) {
        disabled.delete(toolName)
      } else {
        disabled.add(toolName)
      }
      return { ...s, disabledTools: [...disabled] }
    }))
    // Persist to disk
    try {
      await window.api.mcpSetToolEnabled(serverName, toolName, enabled)
    } catch (err) {
      console.error('[McpToolsPanel] Failed to toggle tool:', err)
      // Revert on failure
      refreshStatus()
    }
  }, [refreshStatus])

  useEffect(() => {
    refreshStatus().finally(() => setLoading(false))

    const unsub = window.api.onMcpServerStatusChanged((info) => {
      setServers((prev) => {
        const idx = prev.findIndex((s) => s.name === info.name)
        if (idx === -1) return [...prev, info]
        const next = [...prev]
        next[idx] = info
        return next
      })
    })

    return unsub
  }, [refreshStatus])

  const handleAdded = useCallback(() => {
    setShowAdd(false)
    refreshStatus()
  }, [refreshStatus])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-content-muted mb-3">MCP Servers</h2>
        <p className="text-xs text-content-muted leading-relaxed">
          Connect external tools to the assistant via the Model Context Protocol.
          Each running server exposes one or more tools the model can call.
        </p>
      </div>

      {/* Server list */}
      <div className="space-y-2">
        {loading && (
          <p className="text-sm text-content-muted">Loading…</p>
        )}
        {!loading && servers.length === 0 && !showAdd && (
          <p className="text-sm text-content-muted italic">No MCP servers configured.</p>
        )}
        {servers.map((s) => (
          <ServerCard
            key={s.name}
            info={s}
            onRestart={() => window.api.mcpRestartServer(s.name)}
            onRemove={() => window.api.mcpRemoveServer(s.name)}
            onToggleTool={handleToggleTool}
          />
        ))}
      </div>

      {/* Add form or button */}
      {showAdd ? (
        <AddServerForm onAdded={handleAdded} onCancel={() => setShowAdd(false)} />
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 text-sm text-content-secondary hover:text-content-primary transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add MCP server
        </button>
      )}
    </div>
  )
}
