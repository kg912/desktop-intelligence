// Dark form primitives (designs/03-settings.html). Styling lives in globals.css
// (.ui-field, .ui-select, .ui-range, .ui-check) so nothing falls back to the
// browser's white defaults. Native popups render dark via `color-scheme: dark`.

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

export function Field({ label, value, help, htmlFor, children, className }: {
  label: ReactNode
  /** Shown right-aligned in the label (e.g. a slider's current value). */
  value?: ReactNode
  help?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="flex justify-between text-[13px] text-ma-soft">
        {label}
        {value !== undefined && <b className="font-mono text-[12px] font-medium text-ma-text">{value}</b>}
      </label>
      {children}
      {help && <span className="text-[12px] text-ma-mute">{help}</span>}
    </div>
  )
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" {...props} className={cn('ui-field', className)} />
}

export function NumberInput({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <input type="number" {...props} className={cn('ui-field font-mono text-[12.5px]', className)} />
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn('ui-field ui-select', className)}>{children}</select>
}

export function Checkbox({ label, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer select-none items-center gap-2.5 text-[13px] text-ma-soft', className)}>
      <input type="checkbox" {...props} className="ui-check" />
      {label}
    </label>
  )
}

export function RangeSlider({ value, min, max, onChange, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'value'> & {
  value: number; min: number; max: number; onChange: (value: number) => void
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      type="range" min={min} max={max} step={1} value={value} {...props}
      onChange={(e) => onChange(Number(e.target.value))}
      className="ui-range" style={{ ['--p' as string]: `${fill}%` }}
    />
  )
}

/** Segmented control, e.g. reasoning effort. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-[34px] self-start rounded-[9px] border-[0.5px] border-white/[0.09] bg-ma-bg2 p-[3px]">
      {options.map((o) => (
        <button
          key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cn('rounded-[6px] px-3 text-[12.5px]', value === o.value ? 'bg-ma-red/[0.14] text-ma-redtext' : 'text-ma-mute hover:text-ma-text')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
