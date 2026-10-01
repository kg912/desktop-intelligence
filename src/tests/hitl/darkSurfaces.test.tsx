import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModelSelect } from '../../renderer/src/components/ui/ModelSelect'

const RENDERER = join(__dirname, '../../renderer/src')
/** Files allowed to use bg-white / text-black (e.g. a light-on-purpose export). Keep empty unless justified. */
const ALLOW: string[] = []

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path)
    return /\.(tsx?|css)$/.test(name) ? [path] : []
  })
}

describe('no white surfaces in the renderer (refinement Phase 5)', () => {
  it('no bare bg-white or text-black outside the allow-list (translucent bg-white/[x] overlays are fine)', () => {
    const offenders = files(RENDERER)
      .filter((f) => !ALLOW.some((a) => f.endsWith(a)))
      .flatMap((f) => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f, i, line })))
      .filter(({ line }) => /\bbg-white(?![/\w-])|\btext-black\b/.test(line))
      .map(({ f, i }) => `${f.slice(RENDERER.length + 1)}:${i + 1}`)
    expect(offenders).toEqual([])
  })

  it('the Tailwind tokens the settings use all exist (bg-surface-elevated was missing)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const colors = require('../../../tailwind.config.js').theme.extend.colors
    expect(colors.surface.elevated).toBeTruthy()
    expect(colors.surface.border).toBeTruthy()
    expect(colors.content.primary).toBeTruthy()
  })

  it('native controls render dark: color-scheme dark is set on the root', () => {
    expect(readFileSync(join(RENDERER, 'styles/globals.css'), 'utf8')).toMatch(/:root\s*\{\s*color-scheme:\s*dark/)
  })
})

// WCAG relative luminance contrast.
const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

describe('form contrast (refinement Phase 5)', () => {
  const FIELD = '#131313', PAGE = '#0a0a0a', PANEL = '#0e0e0e'
  it('body text on field backgrounds is at least 7:1', () => {
    expect(contrast('#ebebeb', FIELD)).toBeGreaterThanOrEqual(7)
  })
  it('placeholder and help text (ma-mute #8b8b8b) are at least 4.5:1 — the design\'s #5a5a5a was raised because it fails', () => {
    expect(contrast('#5a5a5a', FIELD)).toBeLessThan(4.5)
    for (const bg of [FIELD, PAGE, PANEL]) expect(contrast('#8b8b8b', bg)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('ModelSelect — keyboard-only use', () => {
  const models = [
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'L', contextLength: 131_072, promptPrice: 1e-7, completionPrice: 3.2e-7, supportsTools: true },
    { id: 'qwen/qwen3-235b-a22b-2507', name: 'Q', contextLength: 262_144, promptPrice: 8.7e-8, completionPrice: 3.5e-7, supportsTools: true },
  ]
  it('type to filter, arrows to move, Enter to choose, Escape to close; columns show id, price per 1M and context', () => {
    const onChange = vi.fn()
    render(<ModelSelect label="Worker model" value="" models={models} onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Worker model' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Follow active OpenRouter model',
      'meta-llama/llama-3.3-70b-instruct$0.100 / $0.320131k',
      'qwen/qwen3-235b-a22b-2507$0.087 / $0.350262k',
    ])
    const input = screen.getByRole('combobox', { name: 'Worker model' })
    fireEvent.change(input, { target: { value: 'qwen' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('qwen/qwen3-235b-a22b-2507')
    expect(screen.queryByRole('listbox')).toBeNull()

    const again = screen.getByRole('combobox', { name: 'Worker model' })
    fireEvent.keyDown(again, { key: 'm' }) // printable key opens with that filter
    const filter = screen.getByRole('combobox', { name: 'Worker model' }) as HTMLInputElement
    expect(filter.value).toBe('m')
    fireEvent.keyDown(filter, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Worker model' }), { key: 'Enter' })
    const list = screen.getByRole('combobox', { name: 'Worker model' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(list.getAttribute('aria-activedescendant')).toMatch(/-1$/)
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('a saved model missing from the list is shown and labelled', () => {
    render(<ModelSelect label="Synth model" value="gone/model" models={models} onChange={vi.fn()} />)
    expect(screen.getByRole('combobox').textContent).toBe('gone/model (not in catalogue)')
  })
})
