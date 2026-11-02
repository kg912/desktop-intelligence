import { useEffect, useRef, useState } from 'react'
import { FolderLock } from 'lucide-react'
import type { FsAccessLevel, FsAccessRequestEvent, FsAccessResponse, FsPickResult } from '../../../../shared/fsAccess'
import { useCountdown } from './McpPermissionDialog'

// fs_request_access dialog (spec 2.10, mockup 15 panel B). Rendered in the
// approvals layer with the MCP permission dialogs. Escape denies; focus starts
// on Deny so a stray Enter never grants access.

interface FsAccessDialogProps {
  request: FsAccessRequestEvent
  onRespond: (r: FsAccessResponse) => void
  pickFolder: () => Promise<FsPickResult>
}

const HAIR2 = '0.5px solid rgba(255,255,255,0.09)'

export function FsAccessDialog({ request, onRespond, pickFolder }: FsAccessDialogProps) {
  const [access, setAccess] = useState<FsAccessLevel>(request.access)
  const [path, setPath] = useState(request.path)
  const [pickError, setPickError] = useState<string | null>(null)
  const answered = useRef(false)
  const denyRef = useRef<HTMLButtonElement>(null)
  const remaining = useCountdown(request.timeoutMs)

  const respond = (decision: FsAccessResponse['decision']): void => {
    if (answered.current) return
    answered.current = true
    onRespond({ requestId: request.requestId, decision, access, path })
  }
  const respondRef = useRef(respond)
  respondRef.current = respond

  useEffect(() => {
    denyRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') respondRef.current('deny')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const choose = async (): Promise<void> => {
    const r = await pickFolder()
    if (r.ok) {
      setPath(r.root.path)
      setPickError(null)
    } else if ('reason' in r) setPickError(r.reason)
  }

  const btn = 'px-3 py-1.5 text-xs rounded border border-surface-border text-content-secondary hover:text-content-primary transition-colors'

  return (
    <div className="w-full max-w-[440px]" role="dialog" aria-modal="true" aria-labelledby={`fs-access-title-${request.requestId}`}>
      <div className="rounded-xl border border-surface-border bg-surface-elevated shadow-2xl p-5">
        <div className="flex items-start gap-3 mb-3.5">
          <div className="flex-shrink-0 w-[34px] h-[34px] rounded-lg bg-red-600/[0.08] flex items-center justify-center" style={{ border: '0.5px solid rgba(229,57,53,0.3)' }}>
            <FolderLock className="w-4 h-4 text-red-500" />
          </div>
          <div>
            <h3 id={`fs-access-title-${request.requestId}`} className="text-[13.5px] font-semibold text-content-primary">
              {access === 'write' ? 'DI wants to read and edit files in' : 'DI wants to read files in'}
            </h3>
            <p className="text-[11.5px] text-content-muted mt-0.5">Only this folder and what's inside it.</p>
          </div>
        </div>

        <div data-testid="fs-access-path" className="font-mono text-[12.5px] text-content-primary bg-black/35 rounded-[7px] px-2.5 py-2 mt-1.5 mb-1 break-all" style={{ border: HAIR2 }}>
          {path}
        </div>
        <button onClick={() => void choose()} className="text-[11.5px] text-red-500/85 underline underline-offset-2 hover:text-red-400">
          Choose a different folder…
        </button>
        {pickError && (
          <p role="alert" className="text-[11.5px] text-red-400 mt-1">
            {pickError}
          </p>
        )}

        <p className="font-mono text-[10.5px] text-content-muted mt-2.5">Reason from the model</p>
        <blockquote className="text-xs text-content-secondary border-l-2 border-white/[0.12] pl-2.5 py-0.5 my-2.5">{request.reason}</blockquote>

        <div role="radiogroup" aria-label="Access" className="flex gap-4 mt-3 mb-1 text-xs text-content-secondary">
          {(['read', 'write'] as const).map((a) => (
            <label key={a} className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name={`fs-access-${request.requestId}`} checked={access === a} onChange={() => setAccess(a)} className="accent-red-600" />
              {a === 'read' ? 'Read-only' : 'Read & write'}
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 mt-4">
          <span className="font-mono text-[10.5px] text-content-muted">{remaining !== null ? `Auto-denies in ${remaining}` : ''}</span>
          <div className="flex gap-1.5">
            <button ref={denyRef} onClick={() => respond('deny')} className={`${btn} hover:text-red-400 hover:border-red-900/50`}>
              Deny
            </button>
            <button onClick={() => respond('chat')} className={btn}>
              Allow for this chat
            </button>
            <button onClick={() => respond('always')} className="px-3 py-1.5 text-xs rounded bg-accent-700 hover:bg-accent-600 text-white transition-colors">
              Always allow
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
