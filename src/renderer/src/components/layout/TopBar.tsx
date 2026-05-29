import { useState, useEffect, useRef } from 'react'
import { useSignals } from '@preact/signals-react/runtime'
import { Zap, RotateCw, ChevronLeft, ChevronRight, ScrollText } from 'lucide-react'
import { useModelStore, contextUsageSignal, contextFillSignal, isCompactingSignal } from '../../store/ModelStore'

const DEBUG = (import.meta as Record<string, unknown> & { env?: { DEV_MODE?: boolean } }).env?.DEV_MODE === true

/**
 * TopBar — centre model name + right-side context utilisation indicator + Compact button.
 *
 * The context bar is invisible until the first completed response populates
 * contextUsage in ModelStore. After that it stays visible and updates on
 * every subsequent response. Cleared when the user starts a new chat.
 *
 * The Compact button appears alongside the context bar and is disabled
 * until contextUsage.used >= 5000 tokens.
 */

interface TopBarProps {
  activeChatId:                   string | null
  onCompactComplete:              () => void
  sidebarCollapsed?:              boolean
  onSidebarToggle?:               () => void
  chatSystemInstructions:         string | null
  onUpdateChatSystemInstructions: (text: string) => void
}

export function TopBar({ activeChatId, onCompactComplete, sidebarCollapsed = false, onSidebarToggle, chatSystemInstructions, onUpdateChatSystemInstructions }: TopBarProps) {
  useSignals()
  const {
    selectedModel,
    // contextUsage / isCompacting removed — read from signals below
    setContextUsage,
    setIsCompacting,
    setCompactToast,
    isReloading,
    setIsReloading,
  } = useModelStore()

  // Read volatile fields from signals — only this component re-renders when they change
  const contextUsage = contextUsageSignal.value
  const isCompacting = isCompactingSignal.value
  const pct          = Math.round(contextFillSignal.value * 100)

  const [showTooltip, setShowTooltip] = useState(false)
  const [isNvidia,    setIsNvidia]    = useState(false)
  const [isOllama,    setIsOllama]    = useState(false)
  const [isOpenRouter, setIsOpenRouter] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const [showSysPromptPopup, setShowSysPromptPopup] = useState(false)
  const [sysPromptDraft,     setSysPromptDraft]     = useState('')
  const [popupLeft,          setPopupLeft]          = useState(0)
  const sysPromptBtnRef   = useRef<HTMLButtonElement>(null)
  const sysPromptPopupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Track fullscreen so we know whether to leave room for macOS traffic lights
    window.api.isFullscreen?.().then(setIsFullscreen).catch(() => {})
    const unsub = window.api.onFullscreenChange?.(setIsFullscreen)
    return () => { unsub?.() }
  }, [])

  useEffect(() => {
    window.api.getBackendSettings()
      .then((s) => {
        setIsNvidia(s.provider === 'nvidia')
        setIsOllama(s.provider === 'ollama')
        setIsOpenRouter(s.provider === 'openrouter')
      })
      .catch(() => {/* non-fatal */})
  }, [])

  // Seed the context bar total from model config on mount so the bar
  // is visible immediately (showing 0 / contextLength) before any message is sent.
  useEffect(() => {
    window.api.getModelConfig()
      .then((config) => {
        if (DEBUG) console.log('[DEV][TopBar] getModelConfig result:', JSON.stringify(config))
        setContextUsage((prev) => ({ used: prev.used, total: config.contextLength }))
      })
      .catch((err) => {
        if (DEBUG) console.log('[DEV][TopBar] getModelConfig failed:', err)
      })
  }, [])

  // ── Click-outside dismissal for sys-prompt popup ─────────────
  useEffect(() => {
    if (!showSysPromptPopup) return
    function handleMouseDown(e: MouseEvent) {
      if (
        sysPromptPopupRef.current &&
        !sysPromptPopupRef.current.contains(e.target as Node) &&
        sysPromptBtnRef.current &&
        !sysPromptBtnRef.current.contains(e.target as Node)
      ) {
        setShowSysPromptPopup(false)
        onUpdateChatSystemInstructions(sysPromptDraft)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [showSysPromptPopup, sysPromptDraft, onUpdateChatSystemInstructions])

  // ── Escape-key dismissal for sys-prompt popup ─────────────────
  useEffect(() => {
    if (!showSysPromptPopup) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setShowSysPromptPopup(false)
        onUpdateChatSystemInstructions(sysPromptDraft)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showSysPromptPopup, sysPromptDraft, onUpdateChatSystemInstructions])

  // Colour shifts from muted → amber → red as context fills
  const barColour = pct >= 90
    ? 'bg-red-700/70'
    : pct >= 70
    ? 'bg-amber-700/60'
    : 'bg-accent-800/60'

  const canCompact = contextUsage.used >= 5000 && !isCompacting
  const isBusy     = isCompacting || isReloading

  async function handleReload() {
    if (isBusy) return
    setIsReloading(true)
    try {
      const config = await window.api.getModelConfig()
      await window.api.reloadModel({
        modelId:         config.modelId,
        contextLength:   config.contextLength,
        temperature:     config.temperature,
        topP:            config.topP,
        maxOutputTokens: config.maxOutputTokens,
        repeatPenalty:   config.repeatPenalty,
        systemPrompt:    config.systemPrompt,
        gpuOffload:      config.gpuOffload,
      })
      // Clear context bar so it re-seeds on next response
      setContextUsage((prev) => ({ used: 0, total: prev.total }))
    } catch (err) {
      console.error('[Reload] failed:', err)
    } finally {
      setIsReloading(false)
    }
  }

  async function handleCompact() {
    if (!activeChatId || !contextUsage || contextUsage.used < 5000 || isCompacting) return
    setIsCompacting(true)
    const startTime = Date.now()
    try {
      const result = await window.api.compactChat({ chatId: activeChatId, model: selectedModel })
      // Enforce a minimum 1200ms display time so the overlay is always visible.
      // Without this, a fast LM Studio call on a short conversation completes
      // before AnimatePresence has painted the overlay, and it flashes off instantly.
      const elapsed = Date.now() - startTime
      if (elapsed < 1200) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1200 - elapsed))
      }
      setCompactToast({
        tokensBefore: result.tokensBefore,
        tokensAfter:  result.tokensAfter,
        hasDocuments: result.hasDocuments,
      })
      onCompactComplete()
      setTimeout(() => setCompactToast(null), 5000)
    } catch (err) {
      console.error('[Compact] failed:', err)
    } finally {
      setIsCompacting(false)
    }
  }

  return (
    <div className={`drag-region flex-shrink-0 flex items-center justify-between h-[52px] border-b border-surface-border/50 relative ${
      sidebarCollapsed
        ? isFullscreen ? 'pl-4 pr-8' : 'pl-[80px] pr-8'
        : 'px-8'
    }`}>

      {/* Left: sidebar toggle (collapsed only) + model name + reload button */}
      <div className="no-drag flex items-center gap-1.5">
        {/* Sidebar toggle — ChevronRight when collapsed, ChevronLeft when expanded */}
        {onSidebarToggle && (
          <button
            onClick={onSidebarToggle}
            className="p-1.5 rounded-lg text-content-tertiary
                       hover:text-content-secondary hover:bg-surface-hover
                       transition-colors duration-100 mr-1"
            title={sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
          >
            {sidebarCollapsed
              ? <ChevronRight className="w-4 h-4" />
              : <ChevronLeft className="w-4 h-4" />}
          </button>
        )}
        <div className="flex items-center gap-1.5">
          <Zap className="w-3 h-3 text-accent-500" />
          <span className="text-[12px] font-mono text-content-tertiary tracking-wide truncate max-w-[360px]">
            {selectedModel}
          </span>
        </div>

        {/* Reload model button — hidden for cloud backends (Ollama, NVIDIA, OpenRouter) */}
        {!isNvidia && !isOllama && !isOpenRouter && (
          <button
            onClick={handleReload}
            disabled={isBusy}
            title={isBusy ? 'Busy…' : 'Reload model (clears memory)'}
            className={
              isBusy
                ? 'ml-1 p-1 rounded text-content-muted/30 cursor-not-allowed'
                : 'ml-1 p-1 rounded text-content-muted hover:text-content-secondary hover:bg-surface-border/30 cursor-pointer transition-colors'
            }
          >
            <RotateCw
              className={`w-3 h-3 ${isReloading ? 'animate-spin text-accent-400' : ''}`}
            />
          </button>
        )}

        {/* Chat instructions button */}
        <button
          ref={sysPromptBtnRef}
          onClick={() => {
            if (!showSysPromptPopup) {
              setSysPromptDraft(chatSystemInstructions ?? '')
              if (sysPromptBtnRef.current) {
                const btnRect = sysPromptBtnRef.current.getBoundingClientRect()
                const popupWidth = 400
                const centeredLeft = btnRect.left + btnRect.width / 2 - popupWidth / 2
                setPopupLeft(Math.max(8, centeredLeft))
              }
            }
            setShowSysPromptPopup(prev => !prev)
          }}
          title={
            chatSystemInstructions
              ? `Instructions: ${chatSystemInstructions.length > 80
                  ? chatSystemInstructions.slice(0, 80).trimEnd() + '…'
                  : chatSystemInstructions}`
              : 'Add instructions for this chat'
          }
          className={[
            'ml-1 p-1 rounded transition-colors cursor-pointer',
            chatSystemInstructions
              ? 'text-accent-400 border border-accent-700/40 bg-accent-900/30 hover:bg-accent-900/50'
              : 'text-content-muted hover:text-content-secondary hover:bg-surface-border/30',
          ].join(' ')}
        >
          <ScrollText className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Chat instructions popup */}
      {showSysPromptPopup && (
        <div
          ref={sysPromptPopupRef}
          style={{ left: popupLeft, top: 60, width: 400 }}
          className="fixed z-50 rounded-xl border border-surface-border bg-[#111111] shadow-xl p-3.5"
        >
          <p className="text-[11px] font-medium text-content-primary mb-2">
            Chat instructions
          </p>
          <textarea
            autoFocus
            value={sysPromptDraft}
            onChange={e => setSysPromptDraft(e.target.value)}
            maxLength={4000}
            placeholder="Add instructions for this chat only — e.g. 'You are reviewing Python code. Be terse. Assume a senior reader.' Appended to your global system prompt."
            className="w-full min-h-[96px] resize-none rounded-lg bg-surface-border/20 border border-surface-border text-[12px] text-content-secondary placeholder:text-content-muted/50 p-2.5 leading-relaxed focus:outline-none focus:border-accent-700/60"
          />
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[10px] text-content-muted/50 italic">
              Saved on dismiss · persists until chat deleted
            </span>
            <span className={`text-[10px] font-mono ${sysPromptDraft.length >= 3600 ? 'text-accent-400' : 'text-content-muted/40'}`}>
              {sysPromptDraft.length} / 4000
            </span>
          </div>
        </div>
      )}

      {/* Right: context bar then Compact button — always visible */}
      <div className="no-drag flex items-center gap-3">
          {/* Progress bar with tooltip — bar comes first */}
            <div
              className="relative cursor-default"
              style={{ padding: '12px 4px', margin: '-12px -4px' }}
              onMouseEnter={() => setShowTooltip(true)}
              onMouseLeave={() => setShowTooltip(false)}
            >
              <div className="w-32 h-1.5 rounded-full bg-surface-border/40 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${barColour}`}
                  style={{ width: `${pct}%` }}
                />
              </div>

              {showTooltip && (
                <div className="absolute right-0 top-5 z-50 min-w-[210px]
                                rounded-xl border border-surface-border
                                bg-surface-elevated/95 backdrop-blur-sm
                                px-3.5 py-2.5 shadow-xl">
                  <p className="text-[11px] font-medium text-content-primary mb-2 whitespace-nowrap">
                    Context Utilization
                  </p>
                  <div className="w-full h-1 rounded-full bg-surface-border/40 overflow-hidden mb-2">
                    <div
                      className={`h-full rounded-full ${barColour}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-content-secondary whitespace-nowrap">
                    Used:{' '}
                    <span className="text-content-primary font-medium">
                      {contextUsage.used.toLocaleString()}
                    </span>{' '}
                    tokens ({pct}%)
                  </p>
                  <p className="text-[11px] text-content-secondary whitespace-nowrap">
                    Length:{' '}
                    <span className="text-content-primary font-medium">
                      {contextUsage.total > 0 ? contextUsage.total.toLocaleString() : '—'}
                    </span>{' '}
                    tokens (Max)
                  </p>
                </div>
              )}
            </div>

            {/* Compact button — LM Studio only */}
            {!isNvidia && !isOllama && !isOpenRouter && (
              <button
                onClick={handleCompact}
                disabled={!canCompact}
                className={
                  canCompact
                    ? 'no-drag cursor-pointer bg-accent-900 hover:bg-accent-800 text-white text-xs font-medium px-3 py-1 rounded-md border border-accent-700 transition-all'
                    : 'no-drag cursor-not-allowed bg-accent-900/30 text-white/40 text-xs font-medium px-3 py-1 rounded-md border border-accent-700/30 opacity-50'
                }
                title={canCompact ? 'Summarise conversation to free context' : 'Need ≥ 5,000 tokens used to compact'}
              >
                Compact
              </button>
            )}
      </div>
    </div>
  )
}
