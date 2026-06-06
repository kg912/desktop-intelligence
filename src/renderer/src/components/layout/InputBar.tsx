import {
  memo,
  useRef,
  useState,
  useCallback,
  useEffect,
  type KeyboardEvent,
  type ChangeEvent,
  type DragEvent
} from 'react'
import { useSignals } from '@preact/signals-react/runtime'
import { Paperclip, ArrowUp, Square, X, FileText, ImageIcon, AlertCircle, Zap, Brain, Plug, Shield, ShieldOff } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useModelStore } from '../../store/ModelStore'
import { isStreamingSignal } from '../../signals/chatSignals'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024  // 5 MB

// ----------------------------------------------------------------
// File attachment badge
// ----------------------------------------------------------------
export interface Attachment {
  id:       string
  name:     string
  type:     'image' | 'document'
  size:     number
  filePath: string
  mimeType: string
}

function AttachmentBadge({
  attachment,
  onRemove
}: {
  attachment: Attachment
  onRemove: (id: string) => void
}) {
  const Icon = attachment.type === 'image' ? ImageIcon : FileText
  return (
    <div
      style={{ animation: 'fadeScaleIn 0.15s ease forwards' }}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg
                 bg-surface-DEFAULT border border-surface-border
                 text-xs text-content-secondary max-w-[180px]"
    >
      <Icon className="w-3 h-3 flex-shrink-0 text-accent-500" />
      <span className="truncate">{attachment.name}</span>
      <button
        onClick={() => onRemove(attachment.id)}
        className="flex-shrink-0 text-content-muted hover:text-content-secondary transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}

// ----------------------------------------------------------------
// Bypass permissions toggle button (exported for tests)
// ----------------------------------------------------------------
export function BypassPermissionsButton({
  active,
  onToggle,
}: {
  active:   boolean
  onToggle: (next: boolean) => void
}) {
  return (
    <button
      onClick={() => onToggle(!active)}
      title={active
        ? 'Permissions bypassed — click to require'
        : 'Permissions required — click to bypass'
      }
      className={cn(
        'flex items-center gap-1.5 px-2 py-0.5 rounded-md',
        'text-[10px] font-medium transition-all duration-150',
        'focus:outline-none',
        active
          ? 'bg-accent-950/70 text-accent-400 border border-accent-800/50'
          : 'text-content-muted hover:text-content-secondary'
      )}
    >
      {active ? <ShieldOff className="w-3 h-3" /> : <Shield className="w-3 h-3" />}
      <span>{active ? 'Bypass Permissions' : 'Require Permissions'}</span>
    </button>
  )
}

// ----------------------------------------------------------------
// InputBar
// ----------------------------------------------------------------
export interface InputBarProps {
  onSend?:        (text: string, attachments?: Attachment[]) => void
  onAbort?:       () => void
  disabled?:      boolean
  attachments?:   Attachment[]
  onAttachments?: (a: Attachment[]) => void
  mcpActivity?:   { serverName: string; toolName: string } | null
}

const MAX_TEXTAREA_HEIGHT = 200
const MIN_TEXTAREA_HEIGHT = 24

export const InputBar = memo(function InputBar({
  onSend,
  onAbort,
  disabled = false,
  attachments:    externalAttachments,
  onAttachments,
  mcpActivity = null,
}: InputBarProps) {
  useSignals()
  const isStreaming = isStreamingSignal.value
  const { thinkingMode, setThinkingMode } = useModelStore()
  const [text, setText] = useState('')
  const [localAttachments, setLocalAttachments] = useState<Attachment[]>([])
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const [bypassPermissions, setBypassPermissions] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const resizeRafRef = useRef<number | null>(null)
  const prevTextLengthRef = useRef(0)
  const prevNewlineCountRef = useRef(0)

  // Inject styles once
  useEffect(() => {
    if (document.querySelector('[data-inputbar-styles]')) return
    const s = document.createElement('style')
    s.setAttribute('data-inputbar-styles', 'true')
    s.textContent = `
      @keyframes fadeScaleIn {
        from { opacity: 0; transform: scale(0.85) translateY(4px); }
        to   { opacity: 1; transform: scale(1) translateY(0); }
      }
      @property --ib-angle {
        syntax: '<angle>';
        initial-value: 0deg;
        inherits: false;
      }
      @keyframes ib-revolve {
        to { --ib-angle: 360deg; }
      }
      .ib-glow-ring {
        border-radius: 17px;
        padding: 1px;
        position: relative;
      }
      .ib-glow-ring::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 17px;
        background: conic-gradient(
          from var(--ib-angle),
          transparent 0deg,
          rgba(229,57,53,0.0) 50deg,
          rgba(229,57,53,0.5) 120deg,
          rgba(229,57,53,0.75) 180deg,
          rgba(229,57,53,0.5) 240deg,
          rgba(229,57,53,0.0) 310deg,
          transparent 360deg
        );
        animation: ib-revolve 1.25s linear infinite;
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        padding: 1px;
        z-index: 0;
      }
      .ib-glow-ring::after {
        content: '';
        position: absolute;
        inset: -2px;
        border-radius: 20px;
        background: conic-gradient(
          from var(--ib-angle),
          transparent 0deg,
          rgba(229,57,53,0.0) 50deg,
          rgba(229,57,53,0.10) 120deg,
          rgba(229,57,53,0.20) 180deg,
          rgba(229,57,53,0.10) 240deg,
          rgba(229,57,53,0.0) 310deg,
          transparent 360deg
        );
        animation: ib-revolve 1.25s linear infinite;
        filter: blur(8px);
        z-index: 0;
      }
      .ib-glow-inner {
        border-radius: 16px;
        background: #141414;
        overflow: hidden;
        position: relative;
        z-index: 1;
      }
    `
    document.head.appendChild(s)
  }, [])

  useEffect(() => {
    return () => {
      if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current)
    }
  }, [])

  const attachments    = externalAttachments ?? localAttachments
  const setAttachments = useCallback((updater: Attachment[] | ((prev: Attachment[]) => Attachment[])) => {
    const next = typeof updater === 'function' ? updater(attachments) : updater
    if (onAttachments) onAttachments(next)
    else setLocalAttachments(next)
  }, [attachments, onAttachments])

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled

  const handleBypassToggle = useCallback((next: boolean) => {
    setBypassPermissions(next)
    window.api.setBypassPermissions(next).catch((err: unknown) =>
      console.warn('[InputBar] setBypassPermissions failed:', err)
    )
  }, [])

  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current)
    const currentText = el.value
    const prevLength  = prevTextLengthRef.current
    const prevNewlines = prevNewlineCountRef.current
    const newlines    = (currentText.match(/\n/g) || []).length
    prevTextLengthRef.current  = currentText.length
    prevNewlineCountRef.current = newlines
    const needsShrinkCheck = currentText.length < prevLength || newlines < prevNewlines || currentText === ''
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = null
      const prevHeight = el.style.height
      if (needsShrinkCheck) el.style.height = `${MIN_TEXTAREA_HEIGHT}px`
      const targetHeight = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
      if (prevHeight !== targetHeight) el.style.height = targetHeight
      else if (needsShrinkCheck) el.style.height = prevHeight
    })
  }, [])

  useEffect(() => { resize() }, [text, resize])

  const handleSend = useCallback(() => {
    if (!canSend || isStreaming) return
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    onSend?.(trimmed, attachments)
    setText('')
    setAttachments([])
    setSizeError(null)
    if (textareaRef.current) textareaRef.current.style.height = `${MIN_TEXTAREA_HEIGHT}px`
  }, [canSend, isStreaming, text, attachments, onSend, setAttachments])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [handleSend])

  const addAttachment = useCallback((file: File) => {
    const isImage = file.type.startsWith('image/')
    if (isImage && file.size > MAX_IMAGE_BYTES) {
      setSizeError(`"${file.name}" is ${(file.size / 1_048_576).toFixed(1)} MB — images must be ≤ 5 MB.`)
      return
    }
    setSizeError(null)
    const filePath = window.api.getFilePath(file)
    setAttachments((prev) => {
      if (prev.some((a) => a.name === file.name && a.size === file.size)) return prev
      return [...prev, {
        id: `${Date.now()}-${Math.random()}`,
        name: file.name,
        type: isImage ? 'image' : 'document',
        size: file.size,
        filePath,
        mimeType: file.type || 'application/octet-stream',
      }]
    })
  }, [setAttachments])

  const handleFileInput = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(addAttachment)
    e.target.value = ''
  }, [addAttachment])

  const handleDragOver  = useCallback((e: DragEvent) => { e.preventDefault(); setIsDraggingOver(true) }, [])
  const handleDragLeave = useCallback((e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDraggingOver(false)
  }, [])
  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault(); setIsDraggingOver(false)
    Array.from(e.dataTransfer.files).forEach(addAttachment)
  }, [addAttachment])

  // ── Inner content — identical in both streaming and idle states ──
  const innerContent = (
    <>
      {/* Drag-over overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-10 rounded-2xl flex items-center justify-center
                        bg-accent-950/40 border-2 border-dashed border-accent-700/60
                        pointer-events-none">
          <p className="text-sm text-accent-400 font-medium">Drop files here</p>
        </div>
      )}

      {/* Size error */}
      <div
        className="overflow-hidden transition-[max-height,opacity] duration-200 ease-in-out"
        style={{ maxHeight: sizeError ? '200px' : '0px', opacity: sizeError ? 1 : 0 }}
      >
        <div className="px-4 pt-3 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 text-red-500" />
          <span className="text-xs text-red-400">{sizeError}</span>
          <button onClick={() => setSizeError(null)} className="ml-auto text-content-muted hover:text-content-secondary">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Attachment badges */}
      <div
        className="overflow-hidden transition-[max-height,opacity] duration-200 ease-in-out"
        style={{ maxHeight: attachments.length > 0 ? '200px' : '0px', opacity: attachments.length > 0 ? 1 : 0 }}
      >
        <div className="px-4 pt-3 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <AttachmentBadge
              key={a.id}
              attachment={a}
              onRemove={(id) => setAttachments((prev) => prev.filter((x) => x.id !== id))}
            />
          ))}
        </div>
      </div>

      {/* Input row */}
      <div className="flex items-end gap-2 px-3 py-3">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex-shrink-0 p-1.5 rounded-lg text-content-muted hover:text-content-secondary
                     hover:bg-surface-hover transition-colors duration-100
                     focus:outline-none focus:ring-1 focus:ring-accent-900/40 self-end mb-px"
          title="Attach file or image"
        >
          <Paperclip className="w-4 h-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go"
          multiple
          className="hidden"
          onChange={handleFileInput}
        />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message… (Shift+Enter for newline)"
          rows={1}
          className={cn(
            'flex-1 resize-none bg-transparent',
            'text-sm text-content-primary placeholder:text-content-muted',
            'focus:outline-none leading-6 py-px selectable'
          )}
          style={{ height: MIN_TEXTAREA_HEIGHT, maxHeight: MAX_TEXTAREA_HEIGHT, fontFamily: 'inherit', overflowY: text.length > 0 && textareaRef.current && textareaRef.current.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden' }}
        />
        <button
          onClick={isStreaming ? onAbort : handleSend}
          disabled={!isStreaming && !canSend}
          className={cn(
            'flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-xl self-end mb-px',
            'transition-all duration-150 active:scale-95',
            'focus:outline-none focus:ring-2 focus:ring-accent-700/50',
            isStreaming
              ? 'bg-surface-active border border-surface-border text-content-secondary hover:text-content-primary'
              : canSend
                ? 'bg-accent-700 hover:bg-accent-600 active:bg-accent-800 text-white'
                : 'bg-surface-DEFAULT border border-surface-border text-content-muted cursor-not-allowed'
          )}
          style={canSend && !isStreaming ? { boxShadow: '0 0 12px rgba(185,28,28,0.35)' } : undefined}
        >
          <div className="relative w-4 h-4">
            <div style={{ opacity: isStreaming ? 1 : 0, position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 0.12s' }}>
              <Square className="w-3 h-3 fill-current" />
            </div>
            <div style={{ opacity: isStreaming ? 0 : 1, position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 0.12s' }}>
              <ArrowUp className="w-4 h-4" />
            </div>
          </div>
        </button>
      </div>

      {/* Helper row */}
      <div className="px-3 pb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setThinkingMode(thinkingMode === 'thinking' ? 'fast' : 'thinking')}
            title={thinkingMode === 'thinking' ? 'Thinking mode — click to switch to Fast' : 'Fast mode — click to switch to Thinking'}
            className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-medium transition-all duration-150 focus:outline-none',
              thinkingMode === 'thinking'
                ? 'bg-accent-950/70 text-accent-400 border border-accent-800/50'
                : 'text-content-muted hover:text-content-secondary'
            )}
          >
            {thinkingMode === 'thinking' ? <Brain className="w-3 h-3" /> : <Zap className="w-3 h-3" />}
            <span>{thinkingMode === 'thinking' ? 'Thinking' : 'Fast'}</span>
          </button>
          <BypassPermissionsButton active={bypassPermissions} onToggle={handleBypassToggle} />
        </div>
        <div className="flex items-center gap-2">
          {mcpActivity && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-950/50 border border-accent-900/40 text-[10px] text-accent-400">
              <Plug className="w-2.5 h-2.5 animate-pulse" />
              {mcpActivity.serverName} · {mcpActivity.toolName}
            </span>
          )}
          <p className="text-[10px] text-content-muted">
            <kbd className="font-mono">⏎</kbd> send &nbsp;·&nbsp;
            <kbd className="font-mono">⇧⏎</kbd> newline
          </p>
        </div>
      </div>
    </>
  )

  return (
    <div
      className="flex-shrink-0 px-4 pb-4 pt-2"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isStreaming ? (
        // ── Streaming: revolving conic-gradient glow ring ──
        <div className="ib-glow-ring">
          <div className="ib-glow-inner relative">
            {innerContent}
          </div>
        </div>
      ) : (
        // ── Idle: standard border + box-shadow ──
        <div
          className={cn(
            'relative rounded-2xl border transition-all duration-200 bg-surface-DEFAULT',
            isDraggingOver
              ? 'border-accent-700/70'
              : 'border-surface-border hover:border-surface-border/80',
            disabled && 'opacity-50 pointer-events-none'
          )}
          style={{
            boxShadow: isDraggingOver
              ? '0 0 0 1px rgba(185,28,28,0.4), 0 0 20px rgba(139,0,0,0.2)'
              : '0 -1px 32px rgba(0,0,0,0.3)'
          }}
        >
          {innerContent}
        </div>
      )}
    </div>
  )
})
