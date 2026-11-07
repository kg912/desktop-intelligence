// Input-bar web search selector (specs/search-selector.md §2–4, mockup tabs 2–3). The choice lives in the main
// process settings (Settings > Web Search reads the same fields); this reads them on mount and on every open.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronUp, Globe, Lock } from 'lucide-react'
import { cn } from '../../lib/utils'
import { placeOverlay } from '../../lib/overlayPlacement'
import { layerProps } from '../chat/zLayers'
import { EXA_MODES, EXA_TYPES, exaModeLabel, workerExaType } from '../../../../shared/webSearch'
import type { ExaSearchType, WebSearchProvider, WebSearchSettingsPayload } from '../../../../shared/webSearch'

/** What the button needs: no keys, only whether an Exa key is saved. */
export interface SearchSelectorState {
  enabled: boolean
  provider: WebSearchProvider
  exaSearchType: ExaSearchType
  hasExaKey: boolean
}

export const MENU_WIDTH = 300
const MENU_INSET = 8
/** Space between the button's top edge and the menu. */
export const MENU_GAP = 6
const MA_LOCK_TOOLTIP = 'Multi-agent runs use Balanced'
export const RUN_LOCK_TOOLTIP = 'Applies to the next run'

const toState = (s: WebSearchSettingsPayload): SearchSelectorState => ({
  enabled: !!s.braveEnabled,
  provider: s.webSearchProvider === 'exa' ? 'exa' : 'brave',
  exaSearchType: EXA_TYPES.includes(s.exaSearchType) ? s.exaSearchType : 'auto',
  hasExaKey: !!s.exaApiKey?.trim(),
})

// Last state read, so a remount (the bar swaps its frame while streaming) does not blink the button out.
let lastState: SearchSelectorState | null = null

/** The button's look, label and accessible name for a state (exported for tests). */
export function selectorFace(s: SearchSelectorState, multiAgent: boolean): { tone: 'brave' | 'exa' | 'warn' | 'off'; label: string; name: string } {
  if (!s.enabled) return { tone: 'off', label: 'Search off', name: 'Web search: off' }
  if (s.provider === 'brave') return { tone: 'brave', label: 'Brave', name: 'Web search: Brave' }
  if (!s.hasExaKey) return { tone: 'warn', label: 'Exa · key needed', name: 'Web search: Exa, key needed' }
  const type = multiAgent ? workerExaType(s.exaSearchType) : s.exaSearchType
  return { tone: 'exa', label: `Exa · ${exaModeLabel(type)}`, name: `Web search: Exa, ${EXA_MODES[type].label}` }
}

const TONE: Record<ReturnType<typeof selectorFace>['tone'], string> = {
  brave: 'text-[#fb923c] bg-[#fb923c]/[0.09] border-[#fb923c]/[0.38]',
  exa: 'text-[#8fb0f8] bg-[#7aa2f7]/[0.09] border-[#7aa2f7]/[0.38]',
  warn: 'text-[#f59e0b] bg-[#f59e0b]/[0.08] border-[#f59e0b]/[0.38]',
  off: 'text-white/[0.22] border-white/[0.12] border-dashed',
}

export function SearchSelector({ multiAgent, locked = false, onOpenSettings }: {
  /** Multi-agent mode is on for this chat: only Brave and Exa Balanced can be picked. */
  multiAgent: boolean
  /** A multi-agent run is active: the selector is fixed until the next run. */
  locked?: boolean
  /** Opens Settings > Web Search. */
  onOpenSettings?: () => void
}) {
  const [state, setState] = useState<SearchSelectorState | null>(lastState)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    window.api?.mcpGetSettings?.()
      .then((s) => { lastState = toState(s); setState(lastState) })
      .catch((err: unknown) => console.warn('[SearchSelector] could not read web search settings:', err))
  }, [])
  useEffect(load, [load])

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }, [])

  // Just above the button; horizontally clamped inside the input bar (8 px each side) at narrow widths.
  const place = useCallback(() => {
    const btn = buttonRef.current
    // The input bar's frame (first child of .ib-cq); the parent element when rendered on its own.
    const bar = (btn?.closest('.ib-cq')?.firstElementChild ?? btn?.parentElement) as HTMLElement | null | undefined
    if (!btn || !bar) return
    const b = bar.getBoundingClientRect()
    const r = btn.getBoundingClientRect()
    const { left, width } = placeOverlay({ left: r.left - b.left, width: r.width }, MENU_WIDTH, b.width, MENU_INSET)
    setPos({ left: b.left + left, bottom: window.innerHeight - r.top + MENU_GAP, width })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    place()
    // The bar resizes without the window too (the multi-agent dock narrows the chat column).
    const bar = buttonRef.current?.closest('.ib-cq')
    const ro = typeof ResizeObserver !== 'undefined' && bar ? new ResizeObserver(place) : null
    if (ro && bar) ro.observe(bar)
    window.addEventListener('resize', place)
    return () => { ro?.disconnect(); window.removeEventListener('resize', place) }
  }, [open, place])

  // Focus the checked option (or the first enabled one) once the menu is up.
  useEffect(() => {
    if (!open || !menuRef.current) return
    const items = enabledItems(menuRef.current)
    ;(items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) close(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  // A run starting while the menu is open closes it.
  useEffect(() => { if (locked) setOpen(false) }, [locked])

  if (!state) return null
  const face = selectorFace(state, multiAgent)
  const effective = multiAgent ? workerExaType(state.exaSearchType) : state.exaSearchType

  const pick = (provider: WebSearchProvider, type?: ExaSearchType): void => {
    const patch: Partial<WebSearchSettingsPayload> = {
      webSearchProvider: provider,
      ...(type ? { exaSearchType: type } : {}),
      ...(state.enabled ? {} : { braveEnabled: true }),
    }
    lastState = { ...state, provider, enabled: true, ...(type ? { exaSearchType: type } : {}) }
    setState(lastState)
    close(true)
    window.api.mcpSaveSettings(patch).catch((err: unknown) => {
      console.warn('[SearchSelector] could not save the web search choice:', err)
      load()
    })
  }
  const openSettings = (): void => { close(false); onOpenSettings?.() }

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = enabledItems(e.currentTarget)
    if (!items.length) return
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length].focus()
  }

  const savedDeeper = multiAgent && state.provider === 'exa' && effective !== state.exaSearchType
  return (
    <>
      <button
        ref={buttonRef}
        data-testid="search-selector"
        data-tone={face.tone}
        onClick={() => { if (locked) return; if (!open) load(); setOpen((o) => !o) }}
        aria-disabled={locked}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={face.name}
        title={locked ? RUN_LOCK_TOOLTIP : face.name}
        className={cn(
          'flex items-center gap-1.5 px-2 py-0.5 rounded-md whitespace-nowrap text-[10px] font-medium border',
          'transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-700/60',
          TONE[face.tone],
          locked ? 'opacity-40 cursor-not-allowed' : 'hover:brightness-125',
        )}
      >
        <Globe className="w-3 h-3 flex-none" />
        <span className="ib-label">{face.label}</span>
        <ChevronUp className="ib-caret w-2 h-2 flex-none opacity-60" strokeWidth={2.4} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Web search provider"
          data-testid="search-menu"
          onKeyDown={onMenuKey}
          {...layerProps('popover')}
          style={{ ...layerProps('popover').style, position: 'fixed', left: pos?.left ?? 0, bottom: pos?.bottom ?? 0, width: pos?.width ?? MENU_WIDTH, visibility: pos ? 'visible' : 'hidden' }}
          className="flex flex-col gap-px rounded-[10px] border-[0.5px] border-white/[0.13] bg-[#141414] p-1.5 shadow-[0_14px_44px_rgba(0,0,0,0.6)]"
        >
          <div className="flex justify-between px-2 pt-1 pb-1.5 font-mono text-[10px] font-medium text-white/[0.22]">
            <span>Web search</span><span>saved to Settings</span>
          </div>
          {!state.enabled && <p className="px-2.5 pt-1 pb-1.5 text-[10.5px] leading-[1.45] text-[#f59e0b]">Web search is off in Settings. Picking a provider turns it on.</p>}
          <Option
            checked={state.enabled && state.provider === 'brave'}
            onPick={() => pick('brave')}
            dot="#fb923c" head
            title="Brave" sub="Snippets · DI fetches top pages" meta="$5 / 1k"
          />
          <div className="mx-0.5 my-1 h-px bg-white/[0.05]" />
          <div className="flex items-center gap-2 pl-3 pr-2 pt-1.5 pb-1">
            <span className="h-[7px] w-[7px] flex-none rounded-full bg-[#7aa2f7]" />
            <b className="text-[12px] font-semibold text-white/[0.88]">Exa</b>
            <small className="flex-1 text-[10.5px] text-white/40">Neural search · page text included</small>
            {!state.hasExaKey && (
              <button onClick={openSettings} data-testid="search-add-key"
                className="rounded border-[0.5px] border-[#f59e0b]/40 px-1.5 py-px font-mono text-[10px] font-medium text-[#f59e0b] hover:bg-[#f59e0b]/10">
                Add API key
              </button>
            )}
          </div>
          {EXA_TYPES.map((t) => {
            const maLocked = multiAgent && t !== 'auto'
            const m = EXA_MODES[t]
            return (
              <Option
                key={t}
                checked={state.enabled && state.provider === 'exa' && effective === t}
                disabled={maLocked || !state.hasExaKey}
                lock={maLocked}
                tooltip={maLocked ? MA_LOCK_TOOLTIP : undefined}
                onPick={() => pick('exa', t)}
                title={m.label} tag={t === 'auto' ? 'DEFAULT' : undefined}
                meta={`${m.latency} · ${m.price}`}
                testId={`search-option-exa-${t}`}
              />
            )
          })}
          {multiAgent && (
            <p className="px-2.5 pt-1 pb-1.5 text-[10.5px] leading-[1.45] text-white/40" data-testid="search-ma-note">
              Multi-agent runs use Brave or Exa Balanced, so parallel workers stay quick and cost predictable.
              {savedDeeper && ` Your saved depth, ${EXA_MODES[state.exaSearchType].label}, is kept for normal chats.`}
            </p>
          )}
          <div className="mx-0.5 my-1 h-px bg-white/[0.05]" />
          <button onClick={openSettings} data-testid="search-open-settings"
            className="flex w-full justify-between rounded-md px-2.5 py-1.5 font-mono text-[10.5px] text-white/40 hover:bg-white/[0.04] hover:text-white/60">
            <span>Web Search settings</span><span aria-hidden="true">›</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}

const enabledItems = (menu: HTMLElement): HTMLElement[] =>
  [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([aria-disabled="true"])')]

function Option({ checked, disabled = false, lock = false, tooltip, onPick, dot, head = false, title, sub, tag, meta, testId }: {
  checked: boolean; disabled?: boolean; lock?: boolean; tooltip?: string; onPick: () => void
  dot?: string; head?: boolean; title: string; sub?: string; tag?: string; meta: string; testId?: string
}) {
  return (
    <button
      role="menuitemradio"
      aria-checked={checked}
      aria-disabled={disabled}
      title={tooltip}
      data-testid={testId ?? 'search-option-brave'}
      onClick={() => { if (!disabled) onPick() }}
      className={cn(
        'relative flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-white/[0.88] focus:outline-none',
        head ? 'pl-3' : 'pl-[30px]',
        checked && 'bg-[#e53935]/[0.07]',
        disabled ? 'opacity-[0.38] cursor-not-allowed' : 'hover:bg-white/[0.05] focus-visible:bg-white/[0.05]',
      )}
    >
      <i className={cn('absolute left-0 top-[5px] bottom-[5px] w-0.5 rounded-sm', checked ? 'bg-[#e53935]/60' : 'bg-transparent')} />
      {dot && <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: dot }} />}
      <span className="flex min-w-0 flex-1 flex-col">
        <b className={cn('text-[12px]', head ? 'font-semibold' : 'font-medium')}>{title}</b>
        {sub && <small className="text-[10.5px] text-white/40">{sub}</small>}
      </span>
      {tag && <span className="font-mono text-[9px] font-medium tracking-[0.04em] text-[#e53935]">{tag}</span>}
      <span className="whitespace-nowrap font-mono text-[10.5px] text-white/40">{meta}</span>
      {lock
        ? <Lock className="h-3 w-3 flex-none" />
        : <Check className={cn('h-3 w-3 flex-none text-[#e53935]', !checked && 'opacity-0')} strokeWidth={2.4} />}
    </button>
  )
}
