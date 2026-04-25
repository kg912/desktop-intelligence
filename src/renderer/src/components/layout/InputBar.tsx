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
import { motion, AnimatePresence } from 'framer-motion'
import { Paperclip, ArrowUp, Square, X, FileText, ImageIcon, AlertCircle, Zap, Brain, Plug } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useModelStore } from '../../store/ModelStore'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024  // 5 MB

// ----------------------------------------------------------------
// File attachment badge
// ----------------------------------------------------------------
export interface Attachment {
  id:       string
  name:     string
  type:     'image' | 'document'
  size:     number
  filePath: string   // absolute path (Electron) or empty string (browser mock)
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
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.85, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ duration: 0.15 }}
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
    </motion.div>
  )
}

// ----------------------------------------------------------------
// InputBar
// ----------------------------------------------------------------
export interface InputBarProps {
  isStreaming?:   boolean
  onSend?:        (text: string, attachments?: Attachment[]) => void
  onAbort?:       () => void
  disabled?:      boolean
  /** Controlled attachment list — set by Layout's window-level drop handler */
  attachments?:   Attachment[]
  onAttachments?: (a: Attachment[]) => void
  /** Non-null while an MCP tool call is in flight */
  mcpActivity?:   { serverName: string; toolName: string } | null
}

const MAX_TEXTAREA_HEIGHT = 200
const MIN_TEXTAREA_HEIGHT = 24

export const InputBar = memo(function InputBar({
  isStreaming = false,
  onSend,
  onAbort,
  disabled = false,
  attachments:    externalAttachments,
  onAttachments,
  mcpActivity = null,
}: InputBarProps) {
  const { thinkingMode, setThinkingMode } = useModelStore()
  const [text, setText] = useState('')
  const [localAttachments, setLocalAttachments] = useState<Attachment[]>([])
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Use controlled (external) list if provided, else local state
  const attachments    = externalAttachments ?? localAttachments
  const setAttachments = useCallback((updater: Attachment[] | ((prev: Attachment[]) => Attachment[])) => {
    const next = typeof updater === 'function' ? updater(attachments) : updater
    if (onAttachments) onAttachments(next)
    else setLocalAttachments(next)
  }, [attachments, onAttachments])

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled

  // ── Auto-resize textarea ──────────────────────────────────────
  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = `${MIN_TEXTAREA_HEIGHT}px`
    const scrollH = el.scrollHeight
    el.style.height = `${Math.min(scrollH, MAX_TEXTAREA_HEIGHT)}px`
  }, [])

  useEffect(() => { resize() }, [text, resize])

  // ── Send logic ────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    if (!canSend || isStreaming) return
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    onSend?.(trimmed, attachments)
    setText('')
    setAttachments([])
    setSizeError(null)
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_TEXTAREA_HEIGHT}px`
    }
  }, [canSend, isStreaming, text, attachments, onSend, setAttachments])

  // ── Keyboard shortcuts ────────────────────────────────────────
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  // ── File attachment ───────────────────────────────────────────
  // Phase 8 (Bug 1): dedup is enforced here — this is the single chokepoint
  // for both the file-picker (handleFileInput) and the InputBar drop zone
  // (handleDrop). Checking name AND size catches re-selections of the same
  // file without false-positively blocking two different files that share a name.
  const addAttachment = useCallback((file: File) => {
    const isImage = file.type.startsWith('image/')

    if (isImage && file.size > MAX_IMAGE_BYTES) {
      setSizeError(
        `"${file.name}" is ${(file.size / 1_048_576).toFixed(1)} MB — images must be ≤ 5 MB.`
      )
      return
    }

    setSizeError(null)

    // file.path is injected by Electron's File object; empty string in browser mock
    const filePath = (file as File & { path?: string }).path ?? ''

    setAttachments((prev) => {
      // Skip if a file with the same name AND size is already in the list.
      if (prev.some((a) => a.name === file.name && a.size === file.size)) return prev
      return [
        ...prev,
        {
          id:       `${Date.now()}-${Math.random()}`,
          name:     file.name,
          type:     isImage ? 'image' : 'document',
          size:     file.size,
          filePath,
          mimeType: file.type || 'application/octet-stream',
        },
      ]
    })
  }, [setAttachments])

  const handleFileInput = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(addAttachment)
    e.target.value = '' // reset so same file can be re-attached
  }, [addAttachment])

  // ── Drag & drop ───────────────────────────────────────────────
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    setIsDraggingOver(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDraggingOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    setIsDraggingOver(false)
    Array.from(e.dataTransfer.files).forEach(addAttachment)
  }, [addAttachment])

  return (
    <div
      className="flex-shrink-0 px-4 pb-4 pt-2"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={cn(
          'relative rounded-2xl border transition-all duration-200',
          'bg-surface-DEFAULT',
          isDraggingOver
            ? 'border-accent-700/70 shadow-red-glow'
            : 'border-surface-border hover:border-surface-border/80',
          disabled && 'opacity-50 pointer-events-none'
        )}
        style={{
          boxShadow: isDraggingOver
            ? '0 0 0 1px rgba(185,28,28,0.4), 0 0 20px rgba(139,0,0,0.2)'
            : '0 -1px 32px rgba(0,0,0,0.3)'
        }}
      >
        {/* Drag-over overlay */}
        <AnimatePresence>
          {isDraggingOver && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-10 rounded-2xl flex items-center justify-center
                         bg-accent-950/40 border-2 border-dashed border-accent-700/60 pointer-events-none"
            >
              <p className="text-sm text-accent-400 font-medium">Drop files here</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Size error */}
        <AnimatePresence>
          {sizeError && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-4 pt-3 flex items-center gap-2 overflow-hidden"
            >
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 text-red-500" />
              <span className="text-xs text-red-400">{sizeError}</span>
              <button
                onClick={() => setSizeError(null)}
                className="ml-auto text-content-muted hover:text-content-secondary"
              >
                <X className="w-3 h-3" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Attachment badges */}
        <AnimatePresence>
          {attachments.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-4 pt-3 flex flex-wrap gap-2 overflow-hidden"
            >
              {attachments.map((a) => (
                <AttachmentBadge
                  key={a.id}
                  attachment={a}
                  onRemove={(id) => setAttachments((prev) => prev.filter((x) => x.id !== id))}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input row */}
        <div className="flex items-end gap-2 px-3 py-3">
          {/* Paperclip */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 p-1.5 rounded-lg
                       text-content-muted hover:text-content-secondary
                       hover:bg-surface-hover
                       transition-colors duration-100
                       focus:outline-none focus:ring-1 focus:ring-accent-900/40 self-end mb-px"
            title="Attach file or image"
          >
            <Paperclip className="w-4 h-4" />
          </button>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go"
            multiple
            className="hidden"
            onChange={handleFileInput}
          />

          {/* Textarea */}
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
              'focus:outline-none',
              'leading-6 py-px',
              'overflow-y-auto',
              'selectable'
            )}
            style={{
              height: MIN_TEXTAREA_HEIGHT,
              maxHeight: MAX_TEXTAREA_HEIGHT,
              fontFamily: 'inherit'
            }}
          />

          {/* Send / Stop button */}
          <motion.button
            layout
            onClick={isStreaming ? onAbort : handleSend}
            disabled={!isStreaming && !canSend}
            className={cn(
              'flex-shrink-0 flex items-center justify-center',
              'w-8 h-8 rounded-xl self-end mb-px',
              'transition-all duration-150',
              'focus:outline-none focus:ring-2 focus:ring-accent-700/50',
              isStreaming
                ? 'bg-surface-active border border-surface-border text-content-secondary hover:text-content-primary'
                : canSend
                  ? 'bg-accent-700 hover:bg-accent-600 active:bg-accent-800 text-white'
                  : 'bg-surface-DEFAULT border border-surface-border text-content-muted cursor-not-allowed'
            )}
            style={
              canSend && !isStreaming
                ? { boxShadow: '0 0 12px rgba(185,28,28,0.35)' }
                : undefined
            }
            whileTap={canSend || isStreaming ? { scale: 0.92 } : undefined}
          >
            <AnimatePresence mode="wait" initial={false}>
              {isStreaming ? (
                <motion.div
                  key="stop"
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  transition={{ duration: 0.12 }}
                >
                  <Square className="w-3 h-3 fill-current" />
                </motion.div>
              ) : (
                <motion.div
                  key="send"
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  transition={{ duration: 0.12 }}
                >
                  <ArrowUp className="w-4 h-4" />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.button>
        </div>

        {/* Helper row: thinking mode toggle (left) + mcp activity + keyboard hints (right) */}
        <div className="px-3 pb-2.5 flex items-center justify-between">
          {/* Thinking / Fast mode toggle */}
          <button
            onClick={() => setThinkingMode(thinkingMode === 'thinking' ? 'fast' : 'thinking')}
            title={thinkingMode === 'thinking'
              ? 'Thinking mode — click to switch to Fast'
              : 'Fast mode — click to switch to Thinking'}
            className={cn(
              'flex items-center gap-1.5 px-2 py-0.5 rounded-md',
              'text-[10px] font-medium transition-all duration-150',
              'focus:outline-none',
              thinkingMode === 'thinking'
                ? 'bg-accent-950/70 text-accent-400 border border-accent-800/50'
                : 'text-content-muted hover:text-content-secondary'
            )}
          >
            {thinkingMode === 'thinking'
              ? <Brain className="w-3 h-3" />
              : <Zap  className="w-3 h-3" />
            }
            <span>{thinkingMode === 'thinking' ? 'Thinking' : 'Fast'}</span>
          </button>

          <div className="flex items-center gap-2">
            {/* MCP activity pill */}
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
      </div>
    </div>
  )
})
