import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, ShieldAlert, X } from 'lucide-react'
import {
  displayPath,
  validateBlockedName,
  type FsAccessSettings,
  type FsChatGrantView,
  type FsRoot,
} from '../../../../shared/fsAccess'
import type { SandboxStatusInfo } from '../../../../shared/types'

// Settings → File System Access (specs/builtin-file-system-access.md 2.9,
// mockup specs/designs/source/15-fs-access.html panel A). Every change is
// saved at once; main re-validates each root and reports the ones it refused.

const HAIR = '0.5px solid rgba(255,255,255,0.05)'
const HAIR2 = '0.5px solid rgba(255,255,255,0.09)'

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[17px] w-[30px] flex-shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-red-700' : 'bg-surface-border'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`inline-block h-[13px] w-[13px] rounded-full shadow transition-transform ${checked ? 'translate-x-[15px] bg-ma-text' : 'translate-x-[2px] bg-neutral-500'}`} />
    </button>
  )
}

function Section({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mt-7 mb-1.5">
      <span className="text-xs font-medium text-content-secondary">{title}</span>
      {action}
    </div>
  )
}

export function FsAccessSettingsPanel() {
  const [settings, setSettings] = useState<FsAccessSettings | null>(null)
  const [home, setHome] = useState('')
  const [dataFolder, setDataFolder] = useState('')
  const [sandbox, setSandbox] = useState<SandboxStatusInfo | null>(null)
  const [grants, setGrants] = useState<FsChatGrantView[]>([])
  const [pickError, setPickError] = useState<string | null>(null)
  const [rejected, setRejected] = useState<Array<{ path: string; reason: string }>>([])
  const [showBlocked, setShowBlocked] = useState(false)
  const [pattern, setPattern] = useState('')
  const [patternError, setPatternError] = useState<string | null>(null)

  useEffect(() => {
    window.api.fsGetSettings().then((v) => {
      setSettings(v.settings)
      setHome(v.home)
      setDataFolder(v.dataFolder)
    })
    window.api.getSandboxStatus().then(setSandbox).catch(() => setSandbox(null))
    window.api.fsListChatGrants().then(setGrants)
  }, [])

  const save = useCallback(async (next: FsAccessSettings) => {
    setSettings(next)
    const r = await window.api.fsSaveSettings(next)
    setSettings(r.settings)
    setRejected(r.rejected)
  }, [])

  if (!settings) return null
  const off = sandbox ? !sandbox.ready : false
  const setRoot = (path: string, patch: Partial<FsRoot>): void => {
    void save({ ...settings, roots: settings.roots.map((r) => (r.path === path ? { ...r, ...patch } : r)) })
  }

  const addFolder = async (): Promise<void> => {
    setPickError(null)
    const r = await window.api.fsPickFolder('settings')
    if (r.ok) void save({ ...settings, roots: [...settings.roots, r.root] })
    else if ('reason' in r) setPickError(r.reason)
  }

  const addPattern = (): void => {
    const p = pattern.trim()
    const reason = validateBlockedName(p) ?? (settings.blockedNames.includes(p) ? 'Already blocked.' : null)
    setPatternError(reason)
    if (reason) return
    setPattern('')
    void save({ ...settings, blockedNames: [...settings.blockedNames, p] })
  }

  const revoke = async (g: FsChatGrantView): Promise<void> => {
    await window.api.fsRevokeChatGrant(g.chatId, g.path)
    setGrants(await window.api.fsListChatGrants())
  }

  const credentialPaths = sandbox?.baselineDenyRead ?? []

  return (
    <div data-testid="fs-access-settings">
      <h2 className="text-[15px] font-semibold text-content-primary mb-1">File System Access</h2>
      <p className="text-xs text-content-muted mb-5">
        DI can read and edit files only in the folders listed here, or in folders you allow from a chat. Everything runs inside the tool sandbox.
      </p>

      {off && (
        <div className="rounded-lg border border-red-900/70 bg-red-950/20 px-4 py-3 mb-4 space-y-1" data-testid="fs-sandbox-off">
          <div className="flex items-center gap-2 text-sm font-medium text-red-300">
            <ShieldAlert className="w-4 h-4" />
            File access is off because the tool sandbox is not running
          </div>
          {sandbox?.errors.map((e) => (
            <p key={e} className="text-xs text-red-300/80">
              {e}
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 py-3" style={{ borderBottom: HAIR }}>
        <Switch
          label="Let DI read and edit files in folders you allow"
          checked={settings.enabled}
          disabled={off}
          onChange={(v) => void save({ ...settings, enabled: v })}
        />
        <span className="text-[13px] text-content-primary">Let DI read and edit files in folders you allow</span>
      </div>

      <Section
        title="Allowed folders"
        action={
          <button
            onClick={() => void addFolder()}
            disabled={off}
            className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-content-secondary hover:text-content-primary hover:border-red-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ border: HAIR2 }}
          >
            <Plus className="w-3 h-3" />
            Add folder…
          </button>
        }
      />
      {settings.roots.length === 0 && <p className="text-xs text-content-muted py-2">No folders allowed yet.</p>}
      {settings.roots.map((r) => (
        <div key={r.path} data-testid="fs-root-row" className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3" style={{ borderBottom: HAIR }}>
          <span className="flex-1 min-w-[200px] truncate font-mono text-[12.5px] text-content-primary" title={r.path}>
            {displayPath(r.path, home)}
          </span>
          <span className="flex overflow-hidden rounded-md font-mono text-[11px]" style={{ border: HAIR2 }}>
            {(['read', 'write'] as const).map((a) => (
              <button
                key={a}
                aria-pressed={r.access === a}
                disabled={off}
                onClick={() => r.access !== a && setRoot(r.path, { access: a })}
                className={`px-2 py-[3px] disabled:cursor-not-allowed ${r.access === a ? 'bg-red-600/15 text-content-primary' : 'text-content-muted hover:text-content-secondary'}`}
              >
                {a === 'read' ? 'Read-only' : 'Read & write'}
              </button>
            ))}
          </span>
          <span className={`flex items-center gap-1.5 text-[11px] text-content-muted whitespace-nowrap ${r.access === 'read' ? 'opacity-35' : ''}`}>
            <Switch label="Ask before edits" checked={r.askBeforeEdit} disabled={off || r.access === 'read'} onChange={(v) => setRoot(r.path, { askBeforeEdit: v })} />
            Ask before edits
          </span>
          <button
            aria-label={`Remove ${r.path}`}
            disabled={off}
            onClick={() => void save({ ...settings, roots: settings.roots.filter((x) => x.path !== r.path) })}
            className="text-content-muted hover:text-red-400 disabled:opacity-40 px-1"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      {pickError && (
        <p role="alert" className="text-[11.5px] text-red-400 mt-1.5">
          {pickError}
        </p>
      )}
      {rejected.map((x) => (
        <p key={x.path} className="text-[11.5px] text-red-400 mt-1.5">
          Not saved: {x.reason}
        </p>
      ))}

      <Section title="Allowed in chats this session" />
      {grants.length === 0 && <p className="text-xs text-content-muted py-2">No folders allowed from chats yet.</p>}
      {grants.map((g) => (
        <div key={`${g.chatId}|${g.path}`} data-testid="fs-chat-grant-row" className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3" style={{ borderBottom: HAIR }}>
          <span className="w-[150px] truncate text-xs text-content-muted" title={g.chatTitle}>
            {g.chatTitle}
          </span>
          <span className="flex-1 min-w-[200px] truncate font-mono text-[12.5px] text-content-primary" title={g.path}>
            {displayPath(g.path, home)}
          </span>
          <span className="rounded font-mono text-[11.5px] text-content-secondary px-1.5 py-0.5" style={{ border: HAIR2 }}>
            {g.access === 'write' ? 'read & write' : 'read-only'}
          </span>
          <button onClick={() => void revoke(g)} className="text-xs text-content-secondary hover:text-red-400 px-2.5 py-1.5">
            Revoke
          </button>
        </div>
      ))}

      <Section title="Always blocked" />
      <button
        onClick={() => setShowBlocked((v) => !v)}
        className="flex items-center gap-1 text-xs text-content-muted hover:text-content-secondary transition-colors"
      >
        {showBlocked ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Credential paths ({credentialPaths.length}) and DI's own data folder. Never readable, even inside an allowed folder.
      </button>
      {showBlocked && (
        <ul className="text-xs font-mono text-content-muted space-y-0.5 pl-4 mt-1.5">
          {credentialPaths.map((p) => (
            <li key={p}>{displayPath(p, home)}</li>
          ))}
          <li>{displayPath(dataFolder, home)}</li>
        </ul>
      )}

      <p className="text-xs text-content-muted mt-3 mb-1.5">Blocked file names</p>
      <div className="flex flex-wrap">
        {settings.blockedNames.map((n) => (
          <span key={n} className="mr-1.5 mb-1.5 inline-flex items-center gap-1.5 rounded px-[7px] py-0.5 font-mono text-[11.5px] text-content-secondary" style={{ border: HAIR2 }}>
            {n}
            <button
              aria-label={`Remove pattern ${n}`}
              disabled={off}
              onClick={() => void save({ ...settings, blockedNames: settings.blockedNames.filter((x) => x !== n) })}
              className="text-content-muted hover:text-red-400 disabled:opacity-40"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <input
        value={pattern}
        disabled={off}
        onChange={(e) => {
          setPattern(e.target.value)
          setPatternError(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && addPattern()}
        placeholder="Add a pattern (* and ? allowed)"
        className="mt-1.5 w-[260px] rounded-md bg-black/30 px-2.5 py-1.5 font-mono text-xs text-content-primary placeholder:text-content-muted focus:outline-none focus:border-red-800 disabled:opacity-40"
        style={{ border: HAIR2 }}
      />
      {patternError && <p className="text-[11.5px] text-red-400 mt-1">{patternError}</p>}
    </div>
  )
}
