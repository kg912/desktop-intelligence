// Keyboard-accessible model picker (designs/03-settings.html): a listbox with
// id, price per 1M and context in aligned columns. Type to filter, arrow keys
// to move, Enter to choose, Escape to close. Only the model pickers need this;
// other selects stay native (dark via color-scheme).

import { useId, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { formatPricePerMillion, type OpenRouterModelInfo } from '../../../../shared/multiAgentModels'

interface Option { id: string; price: string; context: string; note?: string }

export function ModelSelect({ value, models, onChange, label, emptyLabel = 'Follow active OpenRouter model' }: {
  value: string
  models: OpenRouterModelInfo[]
  onChange: (id: string) => void
  label: string
  emptyLabel?: string
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)

  const options = useMemo((): Option[] => {
    const all: Option[] = [{ id: '', price: '', context: '' }]
    if (value && !models.some((m) => m.id === value)) all.push({ id: value, price: '', context: '', note: 'not in catalogue' })
    for (const m of models) {
      all.push({ id: m.id, price: formatPricePerMillion(m).replace(' per 1M', ''), context: m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : '' })
    }
    const q = query.trim().toLowerCase()
    return q ? all.filter((o) => o.id && o.id.toLowerCase().includes(q)) : all
  }, [models, value, query])

  const selected = models.find((m) => m.id === value)
  const show = (initialQuery = ''): void => {
    setQuery(initialQuery)
    setActive(0)
    setOpen(true)
  }
  const choose = (id: string): void => {
    onChange(id)
    setOpen(false)
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show() }
      else if (e.key.length === 1 && /\S/.test(e.key)) show(e.key)
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, options.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[active]) choose(options[active].id) }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
  }

  return (
    <div
      ref={root}
      className="relative"
      onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node)) setOpen(false) }}
    >
      {open ? (
        <input
          autoFocus
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
          value={query}
          placeholder="Type to filter models…"
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={onKeyDown}
          className="ui-field font-mono text-[12.5px]"
        />
      ) : (
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded="false"
          aria-controls={listId}
          onClick={() => show()}
          onKeyDown={onKeyDown}
          className="ui-field ui-select truncate text-left font-mono text-[12.5px]"
        >
          {value ? `${value}${selected ? ` — ${formatPricePerMillion(selected)} · ${Math.round(selected.contextLength / 1000)}k` : ' (not in catalogue)'}` : <span className="font-sans text-ma-mute">{emptyLabel}</span>}
        </button>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute left-0 right-0 top-[44px] z-20 max-h-72 overflow-y-auto rounded-[10px] border-[0.5px] border-white/[0.09] bg-ma-bg2 shadow-[0_18px_40px_rgba(0,0,0,.55)]"
        >
          {options.length === 0 && <li className="px-3 py-2.5 text-[12.5px] text-ma-mute">No model matches “{query}”</li>}
          {options.map((o, i) => (
            <li
              key={o.id || 'default'}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.id === value}
              onMouseDown={(e) => { e.preventDefault(); choose(o.id) }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'grid cursor-pointer grid-cols-[1fr_auto_auto] gap-3.5 border-b-[0.5px] border-white/5 px-3 py-2 font-mono text-[12.5px] text-ma-soft last:border-0',
                i === active && 'bg-ma-bg3',
                o.id === value && 'text-ma-text shadow-[inset_2px_0_0_#e53935]',
                !o.id && 'font-sans text-ma-mute'
              )}
            >
              <span className="truncate">{o.id || emptyLabel}{o.note && <span className="text-ma-amber"> · {o.note}</span>}</span>
              <span className="text-ma-mute">{o.price}</span>
              <span className="w-10 text-right text-ma-mute">{o.context}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
