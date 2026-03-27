/**
 * SystemPromptService unit tests
 *
 * Guards the base system prompt that is prepended to every LM Studio request.
 * These tests prevent accidental removal of capability hints that the model
 * needs in order to use the app's native rendering features.
 *
 * Critical invariants:
 *   1. BASE_SYSTEM_PROMPT is a non-empty string
 *   2. It contains the word "mermaid" (case-insensitive) — model must know the app
 *      renders Mermaid diagrams so it stops generating ASCII art flowcharts
 *   3. It names the backtick-fenced ```mermaid code block syntax
 *   4. It lists the core Mermaid diagram types the model should use
 *   5. It mentions KaTeX / LaTeX support so the model uses $...$ for math
 *   6. It does NOT mention ASCII art as an acceptable fallback (we explicitly
 *      want the model to stop using it)
 *   7. It fits within a reasonable token budget — base prompt must not consume
 *      an unreasonable share of the context window
 */

import { describe, it, expect } from 'vitest'
import { BASE_SYSTEM_PROMPT } from '../SystemPromptService'

describe('BASE_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof BASE_SYSTEM_PROMPT).toBe('string')
    expect(BASE_SYSTEM_PROMPT.length).toBeGreaterThan(0)
  })

  it('mentions mermaid (case-insensitive)', () => {
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('mermaid')
  })

  it('includes the ```mermaid fenced code block syntax hint', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('```mermaid')
  })

  it('mentions flowchart as a supported diagram type', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('flowchart')
  })

  it('mentions sequenceDiagram as a supported diagram type', () => {
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('sequencediagram')
  })

  it('mentions pie chart as a supported diagram type', () => {
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('pie')
  })

  it('mentions KaTeX or LaTeX for math rendering', () => {
    const lower = BASE_SYSTEM_PROMPT.toLowerCase()
    expect(lower.includes('katex') || lower.includes('latex')).toBe(true)
  })

  it('includes the LaTeX inline math syntax hint ($...$)', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('$...$')
  })

  it('mentions SVG rendering so the model knows diagrams are visual', () => {
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('svg')
  })

  it('does NOT instruct the model to use ASCII art as a fallback', () => {
    // The model should be told to AVOID ASCII art, not use it as a fallback.
    // It's OK to MENTION ASCII art (to say "instead of ASCII art"), but the
    // phrasing must not suggest it as a recommended fallback strategy.
    const useAscii = /\buse\s+ascii\s+art\b/i.test(BASE_SYSTEM_PROMPT)
    expect(useAscii).toBe(false)
  })

  it('instructs the model to use diagrams judiciously, not for every answer', () => {
    // Guards against the "ALWAYS produce a diagram" mandate that causes the model
    // to force diagrams onto narratives, simple Q&A, and factual answers where
    // prose or a table would be clearer.
    const lower = BASE_SYSTEM_PROMPT.toLowerCase()
    // The prompt should contain discretion language ("only when", "right choice", etc.)
    const hasDiscretion = lower.includes('only when') || lower.includes('right choice') || lower.includes('when a diagram is')
    expect(hasDiscretion).toBe(true)
    // Must NOT contain the old blanket mandate
    const hasMandatoryAlways = /\balways\s+produce\s+a\s+.*mermaid\b/i.test(BASE_SYSTEM_PROMPT)
    expect(hasMandatoryAlways).toBe(false)
  })

  it('fits within a ~600-token budget (≈ 2200 characters at 3.7 chars/token)', () => {
    // A base prompt larger than ~600 tokens wastes context on a 32k-context model.
    // This is a soft guard — adjust the limit if the prompt is intentionally
    // expanded, but do so consciously.
    // Raised from 1900 → 2200 when ECharts plot rendering capability was added
    // (the new capability hint is ~120 chars and genuinely needed).
    expect(BASE_SYSTEM_PROMPT.length).toBeLessThan(2_200)
  })

  // ── Diagram syntax rules ──────────────────────────────────────────────

  it('includes the classDiagram relationship syntax rule (--|>)', () => {
    // Guards against the model writing `class ClassName --|>` instead of
    // `ClassName --|> Other`, which causes Mermaid parse errors.
    expect(BASE_SYSTEM_PROMPT).toContain('--|>')
  })

  it('includes the ASCII-only identifier rule', () => {
    // Guards against Greek letters / subscripts / brackets in node names.
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('ascii')
  })

  it('includes the Gantt-specific rule (no Note over)', () => {
    // `Note over` is sequenceDiagram syntax; using it in a Gantt causes a
    // parse error.  The system prompt must warn the model explicitly.
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('note over')
  })

  it('mentions echarts plot block for math/ML visualizations', () => {
    // The model must know it can produce interactive charts via ```echarts blocks.
    // Without this hint it falls back to describing plots in prose.
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('echarts')
  })
})
