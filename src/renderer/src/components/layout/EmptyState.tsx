/**
 * EmptyState — welcome screen shown when a chat has no messages.
 *
 * Features:
 *  - 2×2 suggestion card grid (always exactly 4 slots, fixed h-[88px] each)
 *  - Pencil edit icon vertically centred to the right of the grid
 *  - Edit mode: each card becomes a scrollable textarea; delete (✕) per card
 *  - Placeholders fill deleted slots (null); clicking one inserts a blank textarea ('')
 *  - null  = deleted/placeholder slot (never persisted)
 *  - ''    = active but empty textarea (treated as deleted by normalizeDraft on save)
 *  - Save (✓) persists only non-empty cards; Cancel reverts all changes
 *  - Persistence via IPC → SettingsStore (app-settings.json)
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  forwardRef,
} from 'react'
import { Pencil, Check, X, Plus } from 'lucide-react'
import logoWelcome from '../../assets/logo-welcome.png'
import {
  resolveCards,
  buildDisplaySlots,
  normalizeDraft,
  DEFAULT_CARDS,
  CARD_SLOT_COUNT,
} from '../../lib/suggestionCards'

// ─────────────────────────────────────────────────────────────────────────────
// Textarea — fixed-height, scrollable, forwarded ref for programmatic focus
// Auto-resize removed: height is controlled by the fixed-height parent wrapper.
// ─────────────────────────────────────────────────────────────────────────────

const CardTextarea = forwardRef<
  HTMLTextAreaElement,
  { value: string; onChange: (v: string) => void; className?: string }
>(function CardTextarea({ value, onChange, className }, ref) {
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      style={{ resize: 'none' }}
    />
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// EmptyState
// ─────────────────────────────────────────────────────────────────────────────

interface EmptyStateProps {
  onSuggest: (text: string) => void
}

export function EmptyState({ onSuggest }: EmptyStateProps) {
  // ── Persisted cards ───────────────────────────────────────────────────────
  const [cards, setCards] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)

  // ── Edit-mode state ───────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false)
  // draft: exactly CARD_SLOT_COUNT entries.
  //   null   → deleted / placeholder (renders as [+] button)
  //   ''     → active but empty textarea (user just clicked [+]; not yet typed)
  //   string → real card content
  const [draft, setDraft] = useState<Array<string | null>>(
    [null, null, null, null]
  )
  const [saving, setSaving] = useState(false)

  // ── Textarea refs for programmatic focus ──────────────────────────────────
  const textareaRefs = useRef<Array<HTMLTextAreaElement | null>>(
    [null, null, null, null]
  )
  // Track previous draft to detect null → '' transitions and auto-focus
  const prevDraft = useRef<Array<string | null>>([null, null, null, null])

  useEffect(() => {
    draft.forEach((slot, i) => {
      if (prevDraft.current[i] === null && slot === '') {
        // setTimeout(0) ensures React has committed the textarea to the DOM
        setTimeout(() => textareaRefs.current[i]?.focus(), 0)
      }
    })
    prevDraft.current = [...draft]
  }, [draft])

  // ── Load on mount ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    window.api
      .getSuggestions()
      .then((persisted) => {
        if (cancelled) return
        setCards(resolveCards(persisted))
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) {
          setCards(DEFAULT_CARDS)
          setLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ── Enter edit mode (pencil button) ───────────────────────────────────────
  const enterEdit = useCallback(() => {
    const slots = buildDisplaySlots(cards)
    prevDraft.current = [...slots]
    setDraft(slots)
    setEditMode(true)
  }, [cards])

  // ── Bug 3 fix: enter edit mode AND activate a specific slot atomically ────
  // View-mode [+] placeholder calls this so the slot immediately becomes a
  // focused textarea — no second click needed.
  const enterEditAndAdd = useCallback((idx: number) => {
    // prevDraft must be set to the *initial* slots (slot[idx] = null) so that
    // the null→'' transition is detected by the focus-effect on the next render.
    const slots = buildDisplaySlots(cards)
    prevDraft.current = [...slots]   // slots[idx] is null here
    setEditMode(true)
    setDraft(() => {
      const next = buildDisplaySlots(cards)
      next[idx] = ''                 // immediately open a textarea at this index
      return next
    })
  }, [cards])

  // ── Cancel ───────────────────────────────────────────────────────────────
  const cancelEdit = useCallback(() => {
    setEditMode(false)
    const slots = buildDisplaySlots(cards)
    setDraft(slots)
    prevDraft.current = [...slots]
  }, [cards])

  // ── Save ─────────────────────────────────────────────────────────────────
  const saveEdit = useCallback(async () => {
    setSaving(true)
    const clean = normalizeDraft(draft)
    try {
      await window.api.saveSuggestions(clean)
      setCards(resolveCards(clean))
    } catch {
      // If save fails, still update local state so UX isn't broken
      setCards(resolveCards(clean))
    } finally {
      setSaving(false)
      setEditMode(false)
    }
  }, [draft])

  // ── Draft helpers ─────────────────────────────────────────────────────────
  const updateDraftSlot = useCallback((idx: number, value: string) => {
    setDraft((prev) => {
      const next = [...prev]
      next[idx] = value
      return next
    })
  }, [])

  const deleteDraftSlot = useCallback((idx: number) => {
    setDraft((prev) => {
      const next = [...prev]
      next[idx] = null
      return next
    })
  }, [])

  // Clicking [+] in edit mode: sentinel '' → renders as textarea, focus effect fires
  const addDraftSlot = useCallback((idx: number) => {
    setDraft((prev) => {
      const next = [...prev]
      next[idx] = ''
      return next
    })
  }, [])

  // ── Derived state ─────────────────────────────────────────────────────────
  const displaySlots = editMode ? draft : buildDisplaySlots(cards)

  // allDeleted: every slot is null (no active '' textareas either)
  const allDeleted = editMode && draft.every((c) => c === null)

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 select-none">

      {/* Hero */}
      <div
        className={`mb-8 flex flex-col items-center gap-4 ${
          loaded ? 'animate-fade-in' : 'opacity-0'
        }`}
      >
        <img
          src={logoWelcome}
          alt="Desktop Intelligence"
          className="w-14 h-14"
          draggable={false}
        />
        <div className="text-center">
          <h1 className="text-xl font-semibold text-content-primary tracking-tight">
            Desktop Intelligence
          </h1>
          <p className="text-sm text-content-tertiary mt-1">
            One Interface. Every model.
          </p>
        </div>
      </div>

      {/* Card grid + controls row */}
      <div
        className={`flex items-center gap-3 w-full max-w-xl ${
          loaded ? 'animate-slide-up' : 'opacity-0'
        }`}
      >
        {/*
          Bug 1 fix: items-start prevents grid rows from stretching children to
          the tallest sibling height. Each child also carries self-start.
          Bug 2: fixed h-[88px] on every slot type — no more unbounded growth.
        */}
        <div className="grid grid-cols-2 gap-2 flex-1 items-start">
          {displaySlots.map((slot, i) => {

            // ── VIEW MODE ────────────────────────────────────────────────────
            if (!editMode) {
              if (slot === null) {
                // Bug 3 fix: use enterEditAndAdd so the slot opens as a textarea
                // immediately without requiring a second click.
                return (
                  <button
                    key={i}
                    onClick={() => enterEditAndAdd(i)}
                    aria-label="Add suggestion card"
                    className="self-start flex items-center justify-center
                               h-[88px] w-full px-4 py-3 rounded-xl
                               bg-surface-DEFAULT
                               border border-dashed border-surface-border/50
                               hover:border-accent-900/60 hover:bg-surface-hover
                               text-content-muted hover:text-content-secondary
                               opacity-40 hover:opacity-70
                               transition-all duration-150
                               focus:outline-none focus:ring-1 focus:ring-accent-900/50
                               no-drag"
                  >
                    <Plus size={16} />
                  </button>
                )
              }

              // Real card — top-aligned text, fixed height, scrollable overflow
              return (
                <button
                  key={i}
                  onClick={() => onSuggest(slot)}
                  style={{ animationDelay: `${i * 60}ms` }}
                  className="self-start flex flex-col justify-start items-start
                             h-[88px] overflow-y-auto [&::-webkit-scrollbar]:hidden w-full
                             text-left px-4 py-3 rounded-xl animate-fade-in
                             bg-surface-DEFAULT hover:bg-surface-hover active:bg-surface-active
                             border border-surface-border hover:border-surface-border/80
                             text-[13px] text-content-secondary hover:text-content-primary
                             transition-all duration-150 leading-snug
                             focus:outline-none focus:ring-1 focus:ring-accent-900/50
                             no-drag"
                >
                  {slot}
                </button>
              )
            }

            // ── EDIT MODE ────────────────────────────────────────────────────

            // isEmpty only when slot === null; '' is an active (focused) textarea
            const isEmpty = slot === null

            if (isEmpty) {
              return (
                <button
                  key={i}
                  onClick={() => addDraftSlot(i)}
                  aria-label="Add card"
                  className="self-start flex flex-col items-center justify-center gap-1
                             h-[88px] w-full px-4 py-3 rounded-xl
                             bg-surface-DEFAULT hover:bg-surface-hover
                             border border-dashed border-surface-border
                             hover:border-accent-900/60
                             text-content-muted hover:text-content-secondary
                             transition-all duration-150
                             focus:outline-none focus:ring-1 focus:ring-accent-900/50
                             no-drag"
                >
                  <Plus size={16} />
                  {allDeleted && i === 0 && (
                    <span className="text-[11px] text-content-muted">
                      Add shortcut
                    </span>
                  )}
                </button>
              )
            }

            // Active card — fixed-height wrapper, textarea fills it, overflow scrolls
            return (
              <div
                key={i}
                className="self-start relative group h-[88px] overflow-hidden rounded-xl"
              >
                <CardTextarea
                  ref={(el) => {
                    textareaRefs.current[i] = el
                  }}
                  value={slot as string}
                  onChange={(v) => updateDraftSlot(i, v)}
                  className="h-full w-full px-4 py-3 pr-8 rounded-xl
                             bg-[#1c1c1c]
                             border border-accent-900/40 focus:border-accent-700/60
                             text-[13px] text-content-primary caret-white
                             leading-snug ring-0 outline-none overflow-auto [&::-webkit-scrollbar]:hidden
                             transition-colors duration-150"
                />
                {/* Delete button — top-right corner */}
                <button
                  onClick={() => deleteDraftSlot(i)}
                  aria-label="Delete card"
                  className="absolute top-1.5 right-1.5
                             w-5 h-5 flex items-center justify-center rounded
                             text-content-muted hover:text-red-400
                             hover:bg-red-950/30
                             transition-all duration-150
                             focus:outline-none focus:ring-1 focus:ring-accent-900/50"
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>

        {/* Controls — vertically centred to the right of the grid */}
        <div className="flex flex-col items-center gap-2 self-center">
          {!editMode ? (
            <button
              onClick={enterEdit}
              aria-label="Edit suggestion cards"
              className="w-8 h-8 flex items-center justify-center rounded-lg
                         text-content-muted hover:text-content-secondary
                         hover:bg-surface-hover
                         transition-all duration-150
                         focus:outline-none focus:ring-1 focus:ring-accent-900/50
                         no-drag"
            >
              <Pencil size={15} />
            </button>
          ) : (
            <>
              {/* Save (✓) */}
              <button
                onClick={saveEdit}
                disabled={saving}
                aria-label="Save cards"
                className="w-8 h-8 flex items-center justify-center rounded-lg
                           text-content-muted hover:text-green-400
                           hover:bg-green-950/30 disabled:opacity-40
                           transition-all duration-150
                           focus:outline-none focus:ring-1 focus:ring-accent-900/50
                           no-drag"
              >
                <Check size={15} />
              </button>
              {/* Cancel (✕) */}
              <button
                onClick={cancelEdit}
                disabled={saving}
                aria-label="Cancel editing"
                className="w-8 h-8 flex items-center justify-center rounded-lg
                           text-content-muted hover:text-red-400
                           hover:bg-red-950/30 disabled:opacity-40
                           transition-all duration-150
                           focus:outline-none focus:ring-1 focus:ring-accent-900/50
                           no-drag"
              >
                <X size={15} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
