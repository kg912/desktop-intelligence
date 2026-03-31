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

/** Soft character-count ceiling for the base system prompt.
 *  Update this constant (and the comment below) whenever the limit is
 *  intentionally raised — keeps the test name and assertion in sync. */
const MAX_PROMPT_CHARS = 3_500

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

  it(`fits within a ~${Math.round(MAX_PROMPT_CHARS / 3.7)}-token budget (≈ ${MAX_PROMPT_CHARS} characters at 3.7 chars/token)`, () => {
    // A base prompt larger than ~945 tokens wastes context on a 32k-context model.
    // This is a soft guard — update MAX_PROMPT_CHARS above when expanding intentionally.
    // History: 1900 → 2200 (ECharts capability), 2200 → 2400 (axis-type + flowchart
    //   direction syntax rules), 2400 → 3000 (matplotlib renderer added),
    //   3000 → 3500 (THINKING RULE added to suppress CoT leaking outside <think>).
    expect(BASE_SYSTEM_PROMPT.length).toBeLessThan(MAX_PROMPT_CHARS)
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

  it('mentions matplotlib for complex scientific visualizations', () => {
    // The model must know it can produce matplotlib charts via ```matplotlib blocks.
    // Without this hint it falls back to ASCII art or prose for GMMs, contour plots, etc.
    expect(BASE_SYSTEM_PROMPT.toLowerCase()).toContain('matplotlib')
  })

  it('includes the ```matplotlib fenced code block syntax hint', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('```matplotlib')
  })

  it('explicitly restricts flowchart to software/code — not ML algorithms', () => {
    // K-means, GMM, DBSCAN etc. must route to ECharts, not Mermaid flowcharts.
    // The prompt must contain an explicit "NOT for … ML" restriction on flowchart.
    const lower = BASE_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('not for')
  })

  it('warns about Mermaid reserved-word node IDs (end, start)', () => {
    // Using `end` or `start` as a Mermaid node ID causes a parse error.
    // The model must be warned explicitly.
    const lower = BASE_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('end')
    expect(lower).toContain('reserved')
  })
})
