/**
 * MarkdownRenderer
 *
 * Renders AI markdown responses with:
 *  - react-markdown for structure
 *  - remark-math + rehype-katex for LaTeX ($...$ and $$...$$)
 *  - highlight.js for syntax-highlighted code blocks
 *  - Custom CodeBlock with language badge + copy button
 *  - Mermaid diagram rendering (flowcharts, sequence diagrams, etc.)
 *  - <think>...</think> accordion — model reasoning shown in a
 *    collapsible "Thought Process" disclosure widget
 *
 * Pure logic (parseThinkBlocks, classifyCodeBlock, isValidMermaidSyntax)
 * lives in ../lib/markdownUtils.ts so it can be unit-tested without React.
 */

import 'katex/dist/katex.min.css'

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  createContext,
  useContext,
  type ComponentPropsWithoutRef
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { Check, Copy, Terminal, ChevronRight, GitBranch, BarChart2, LineChart, Shapes } from 'lucide-react'
import hljs from 'highlight.js'
import mermaid from 'mermaid'
import ReactECharts from 'echarts-for-react'
import { cn } from '../../lib/utils'
import {
  parseThinkBlocks,
  classifyCodeBlock,
  isValidMermaidSyntax,
  escapeCurrencyDollars,
  prepareUserContent,
} from '../../lib/markdownUtils'
import { ChatIdCtx } from '../layout/ChatArea'

// ----------------------------------------------------------------
// Mermaid — initialised once at module load.
//
// IMPORTANT: securityLevel MUST be 'loose' in Electron.
//   - 'strict' / 'sandbox' create cross-origin iframes which Electron
//     blocks via CSP.
//   - 'antiscript' pipes SVG through DOMPurify which strips xmlns attrs
//     Mermaid relies on (e.g. foreignObject xmlns), breaking diagrams.
//   - 'loose' injects SVG via innerHTML directly — only mode that works
//     reliably in Electron's renderer.
// ----------------------------------------------------------------

mermaid.initialize({
  startOnLoad:   false,
  securityLevel: 'loose',
  theme:         'base',
  themeVariables: {
    // ── Backgrounds ──────────────────────────────────────
    background:            '#0f0f0f',
    mainBkg:               '#1a1a1a',
    nodeBkg:               '#1a1a1a',
    secondaryColor:        '#1a1a1a',
    tertiaryColor:         '#1a1a1a',
    // ── Text ─────────────────────────────────────────────
    primaryTextColor:      '#f5f5f5',
    secondaryTextColor:    '#f5f5f5',
    tertiaryTextColor:     '#f5f5f5',
    titleColor:            '#f5f5f5',
    nodeTextColor:         '#f5f5f5',
    textColor:             '#f5f5f5',
    // ── Borders / lines ──────────────────────────────────
    primaryBorderColor:    '#3a3a3a',
    secondaryBorderColor:  '#3a3a3a',
    tertiaryBorderColor:   '#3a3a3a',
    clusterBorder:         '#3a3a3a',
    lineColor:             '#525252',
    edgeLabelBackground:   '#141414',
    // ── Primary accent (dark red) ─────────────────────────
    primaryColor:          '#2d0a0a',
    // ── Cluster / subgraph ───────────────────────────────
    clusterBkg:            '#141414',
    // ── cScale: alternate fill colours for multi-colour diagrams
    //    (pie slices, quadrant nodes, subgraphs, etc.).
    //    Rules: dark enough for #f5f5f5 white text to pass WCAG AA,
    //    but with clearly distinct hues so slices are visually separable.
    cScale0:  '#2d0a0a',  // dark red     (matches primary accent)
    cScale1:  '#0a2d0a',  // dark green
    cScale2:  '#0a0a2d',  // dark blue
    cScale3:  '#2d2400',  // dark amber / yellow
    cScale4:  '#1e0a2d',  // dark purple
    cScale5:  '#002d2d',  // dark teal
    cScale6:  '#2d1400',  // dark orange-brown
    cScale7:  '#002d1a',  // dark cyan-green
    cScale8:  '#2d0a1a',  // dark rose
    cScale9:  '#14002d',  // dark indigo
    cScale10: '#002800',  // deep forest green
    cScale11: '#2d2000',  // dark gold
    // ── Sequence diagram ─────────────────────────────────
    actorBkg:              '#1a1a1a',
    actorBorder:           '#3a3a3a',
    actorTextColor:        '#f5f5f5',
    actorLineColor:        '#525252',
    signalColor:           '#a3a3a3',
    signalTextColor:       '#f5f5f5',
    labelBoxBkgColor:      '#1a1a1a',
    labelBoxBorderColor:   '#3a3a3a',
    labelTextColor:        '#f5f5f5',
    loopTextColor:         '#f5f5f5',
    activationBorderColor: '#8b0000',
    activationBkgColor:    '#3d0000',
    noteBkgColor:          '#1f1f1f',
    noteBorderColor:       '#3a3a3a',
    noteTextColor:         '#a3a3a3',
  },
  flowchart: { curve: 'basis', htmlLabels: true },
})

// Monotonically-increasing counter → unique, stable DOM ids per block.
let _mermaidIdCounter = 0


// ----------------------------------------------------------------
// Streaming context
//
// Passing isStreaming via React Context instead of through the
// buildComponents() closure is critical for correctness:
//   - buildComponents() is memoised with NO deps → the Components
//     object is created ONCE per MarkdownRenderer instance and never
//     recreated, so MermaidBlock instances are never remounted.
//   - MermaidBlock reads isStreaming from the context; it updates
//     reactively without losing its rendered SVG state.
// ----------------------------------------------------------------
const StreamingCtx = createContext(false)

// ----------------------------------------------------------------
// SVG post-processing
//
// Mermaid sets explicit pixel width / height on the root <svg>.
// Removing them lets the CSS rules (.diagram-block svg) apply
// max-width:100% / height:auto so diagrams scale to their container.
// ----------------------------------------------------------------
function makeResponsiveSvg(svg: string): string {
  // Replace Mermaid's fixed pixel width with 100% so every diagram
  // fills its card regardless of the SVG's natural content width.
  // Tiny diagrams no longer render at their natural (small) pixel size;
  // large diagrams fill the card and are capped by the container max-height.
  // Remove explicit height — the browser derives it from the viewBox aspect
  // ratio once width is set to 100%.
  return svg
    .replace(/(<svg\b[^>]*?)\s+width="[\d.]+(?:px)?"/i,  '$1 width="100%"')
    .replace(/(<svg\b[^>]*?)\s+height="[\d.]+(?:px)?"/i, '$1')
}

// ----------------------------------------------------------------
// Shared diagram card shell — used by both error and success states.
// ----------------------------------------------------------------
interface DiagramCardProps {
  code:      string
  isError?:  boolean
  icon?:     React.ReactNode
  label?:    string
  children:  React.ReactNode
}

function DiagramCard({ code, isError = false, icon, label, children }: DiagramCardProps) {
  const border = isError ? 'border-accent-900/30' : 'border-surface-border/60'
  return (
    <div
      className={`group my-4 rounded-xl overflow-hidden border ${border}`}
      style={{ background: '#141414' }}
    >
      <div
        className={`flex items-center justify-between px-4 py-2.5 border-b ${border}`}
        style={{ background: '#111' }}
      >
        <div className="flex items-center gap-2">
          {icon ?? <GitBranch className={`w-3.5 h-3.5 ${isError ? 'text-accent-800' : 'text-content-muted'}`} />}
          <span className={`text-[11px] font-mono font-medium tracking-wide uppercase ${isError ? 'text-accent-800' : 'text-content-tertiary'}`}>
            {isError ? `${label ?? 'Diagram'} (parse error)` : (label ?? 'Diagram')}
          </span>
        </div>
        <CopyButton text={code} />
      </div>
      {children}
    </div>
  )
}

// ----------------------------------------------------------------
// Mermaid diagram block
// ----------------------------------------------------------------

interface MermaidBlockProps {
  code: string
}

function MermaidBlock({ code }: MermaidBlockProps) {
  // Read streaming state from context — no prop drilling, no remounting.
  const isStreaming = useContext(StreamingCtx)

  const [svg,   setSvg]   = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Stable per-instance DOM id.
  const id = useRef<string>('')
  if (!id.current) id.current = `mmd-${++_mermaidIdCounter}`

  // Track the last code string we successfully (or unsuccessfully) rendered
  // so we don't re-run mermaid.render() if only isStreaming changed.
  const lastRenderedCode = useRef<string | null>(null)

  useEffect(() => {
    // Attempt recovery before giving up on invalid syntax.
    // Most common case: model wrote a mindmap but omitted the 'mindmap' header
    // line, jumping straight to root((Title)). Prepend the missing keyword.
    let codeToRender = code
    if (!isValidMermaidSyntax(code)) {
      const firstLine = code.trim().split('\n')[0].trim().toLowerCase()
      if (firstLine.startsWith('root(')) {
        codeToRender = 'mindmap\n' + code
      } else {
        setError('Unrecognised diagram syntax — showing source')
        return
      }
    }

    // Nothing to do if the code hasn't changed since last render.
    // This fires when isStreaming flips false after a block already rendered.
    if (codeToRender === lastRenderedCode.current) return

    // Debounce strategy:
    //   • isStreaming=true  → wait 600 ms for code to stabilise.
    //     Completed blocks earlier in the response stop changing as soon
    //     as their closing ``` is written, so they render mid-stream.
    //     The last (still-filling) block keeps resetting the timer and
    //     only renders once streaming ends / code stops changing.
    //   • isStreaming=false → render immediately (delay = 0).
    const delay = isStreaming ? 600 : 0
    let cancelled = false

    const timer = setTimeout(async () => {
      try {
        const { svg: out } = await mermaid.render(id.current, codeToRender)
        if (!cancelled) {
          lastRenderedCode.current = codeToRender
          setSvg(makeResponsiveSvg(out))
          setError(null)
        }
      } catch (err) {
        console.error('[Mermaid] render failed:', err)
        if (!cancelled) {
          lastRenderedCode.current = codeToRender   // don't retry identical bad code
          setError(err instanceof Error ? err.message : String(err))
          setSvg(null)
        }
      }
    }, delay)

    return () => { cancelled = true; clearTimeout(timer) }
  }, [code, isStreaming])

  // ── Render error: fall back to plain text code block ──
  if (error) {
    return (
      <DiagramCard code={code} isError>
        <div className="overflow-x-auto">
          <pre className="p-4 m-0 text-[13px] leading-relaxed font-mono text-content-secondary whitespace-pre">
            {code}
          </pre>
        </div>
      </DiagramCard>
    )
  }

  // ── Loading (valid syntax, awaiting async render) ──
  if (!svg) {
    return (
      <div
        className="my-4 rounded-xl border border-surface-border/60 px-4 py-6 flex justify-center"
        style={{ background: '#141414' }}
      >
        <div className="w-4 h-4 rounded-full border-2 border-surface-border border-t-accent-600 animate-spin" />
      </div>
    )
  }

  // ── Success: render the SVG ──
  return (
    <DiagramCard code={code}>
      {/* Diagram renders at full height — no scroll, no clip.
          The outer ChatArea scroll container handles vertical navigation.
          The system prompt's ≤10 node rule keeps diagrams from being huge. */}
      <div
        className="p-4 diagram-block"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </DiagramCard>
  )
}

// ----------------------------------------------------------------
// ECharts plot block
// ----------------------------------------------------------------

/**
 * Dark-palette base applied to every ECharts option the model generates.
 * The user-supplied option is deep-merged on top, so model values always win.
 * Keeping colour/bg overrides here means the model only needs to specify
 * data (series, axes, title) — not theme boilerplate.
 */
const ECHARTS_DARK_BASE: Record<string, unknown> = {
  backgroundColor: 'transparent',
  textStyle:       { color: '#e5e5e5' },
  // Title: pinned to top with enough room for the legend below it
  title: {
    top: 8,
    left: 'center',
    textStyle:    { color: '#f5f5f5', fontSize: 14 },
    subtextStyle: { color: '#a3a3a3' },
  },
  // Legend: always at the bottom so it never overlaps the title or chart area
  legend: {
    bottom: 4,
    textStyle:     { color: '#a3a3a3' },
    inactiveColor: '#525252',
  },
  tooltip: {
    backgroundColor: '#1a1a1a',
    borderColor:     '#3a3a3a',
    textStyle:       { color: '#f5f5f5' },
  },
  // Grid: generous padding so axis names and tick labels never clip into the plot
  // top accounts for title (≈30px) + any legend that overflows upward
  // left/bottom leave room for y-axis name and x-axis labels
  // right leaves room for the last x-axis label
  grid: {
    top:    55,
    left:   60,
    right:  24,
    bottom: 48,
    containLabel: true,   // auto-expand when tick labels are wider than the margin
  },
  // Accent palette: red / blue / green / orange / purple / cyan / yellow / rose
  color: ['#f87171','#60a5fa','#86efac','#fb923c','#c084fc','#67e8f9','#fcd34d','#f472b6'],
  xAxis: {
    axisLine:      { lineStyle: { color: '#3a3a3a' } },
    axisLabel:     { color: '#a3a3a3' },
    splitLine:     { lineStyle: { color: '#1f1f1f' } },
    nameTextStyle: { color: '#a3a3a3', padding: [8, 0, 0, 0] },
    nameLocation:  'end',
  },
  yAxis: {
    axisLine:      { lineStyle: { color: '#3a3a3a' } },
    axisLabel:     { color: '#a3a3a3' },
    splitLine:     { lineStyle: { color: '#1f1f1f' } },
    nameTextStyle: { color: '#a3a3a3', padding: [0, 0, 8, 0] },
    nameLocation:  'end',
  },
}

/** Recursively merge base into override — override values always win. */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(override)) {
    const b = base[k]
    if (
      v !== null && typeof v === 'object' && !Array.isArray(v) &&
      b !== null && typeof b === 'object' && !Array.isArray(b)
    ) {
      result[k] = deepMerge(
        b as Record<string, unknown>,
        v as Record<string, unknown>
      )
    } else {
      result[k] = v
    }
  }
  return result
}

/**
 * scheduleIdle — cross-browser requestIdleCallback wrapper.
 * Returns a cancel function.
 */
function scheduleIdle(cb: () => void): () => void {
  if (typeof requestIdleCallback !== 'undefined') {
    const id = requestIdleCallback(cb, { timeout: 2000 })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(cb, 16)
  return () => clearTimeout(id)
}

/**
 * fixSeriesDataFormat
 *
 * Defensive repair for the most common LLM data format mistake:
 *   xAxis.type: "value"  +  series[i].data: [y0, y1, …]   ← flat, no x coords
 *
 * ECharts silently produces an empty chart in this case because "value" axes
 * expect [[x, y], …] pairs, not flat y-arrays.
 *
 * When all of the following are true the function synthesises x-coords:
 *  • option.xAxis is a single object (not an array) with type === "value"
 *  • option.xAxis has min / max defined (so we can derive the x range)
 *  • a series element has data that is a flat array of numbers (not [[x,y]…])
 *
 * Any series already in [[x,y]…] format is left unchanged.
 */
function fixSeriesDataFormat(opt: Record<string, unknown>): Record<string, unknown> {
  const xAxis = opt.xAxis
  if (!xAxis || Array.isArray(xAxis) || typeof xAxis !== 'object') return opt
  const xa = xAxis as Record<string, unknown>
  if (xa['type'] !== 'value') return opt

  const xMin  = typeof xa['min']  === 'number' ? xa['min']  : null
  const xMax  = typeof xa['max']  === 'number' ? xa['max']  : null
  const xData = Array.isArray(xa['data']) ? xa['data'] as unknown[] : null

  const rawSeries = opt.series
  if (!Array.isArray(rawSeries)) return opt

  const fixedSeries = rawSeries.map((s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return s
    const series = s as Record<string, unknown>
    const data   = series['data']
    if (!Array.isArray(data) || data.length === 0) return series

    // Already [[x,y],…] — leave as-is
    if (Array.isArray(data[0])) return series

    // Flat number array — synthesise x coordinates
    const n = data.length
    let xs: number[]

    if (xData && xData.length === n) {
      xs = xData.map(Number)
    } else if (xMin !== null && xMax !== null) {
      xs = Array.from({ length: n }, (_, i) => xMin + (i / (n - 1)) * (xMax - xMin))
    } else {
      return series  // can't fix — no x reference
    }

    return { ...series, data: data.map((y, i) => [xs[i], Number(y)]) }
  })

  return { ...opt, series: fixedSeries }
}

// ----------------------------------------------------------------
// sanitizeFormatters
//
// Strips formatter strings that ECharts cannot safely evaluate:
//  - JS function strings ("function(...)" or arrow "=>")
//  - Partial-substitution hybrids: "{value} units", "150×{value}"
//
// A formatter is KEPT when it consists entirely of:
//  - ECharts template tokens: {a}, {b}, {c}, {d}, {e}, {value} (+ optional %)
//  - Safe separators: whitespace, \n, colon, comma, slash, pipe, <br/>
//
// Examples kept:  "{value}"  "{c}"  "{b}"  "{d}%"  "{c}\n{b}"  "{b}: {c}"
// Examples dropped: "{value} AD"  "function(v){...}"  "Year {c}"
// ----------------------------------------------------------------
function isSafeFormatter(v: string): boolean {
  if (v.includes('function') || v.includes('=>')) return false
  // Strip all valid ECharts tokens (single letter or "value", optional %)
  const stripped = v
    .replace(/\{(?:[a-eA-E]|value)\}%?/g, '')
    .replace(/<br\s*\/?>/gi, '')
  // Remaining chars must only be safe separator characters
  return /^[\s\n:,/|]*$/.test(stripped)
}

function sanitizeFormatters(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sanitizeFormatters)
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === 'formatter' && typeof v === 'string' && !isSafeFormatter(v)) {
        // Drop unsafe formatter — ECharts default is always readable
        continue
      }
      result[k] = sanitizeFormatters(v)
    }
    return result
  }
  return obj
}

// ----------------------------------------------------------------
// fixYearAxes
//
// ECharts type:"value" axes auto-format numbers with locale commas:
// 1260 → "1,260". For year-range axes (min ≥ 1000, max ≤ 2200) this
// looks wrong. Setting formatter:"{value}" bypasses locale formatting
// and shows the raw integer — "1260", "1271", etc.
//
// Only patches axes that are type:"value" with min/max in the year
// range AND have no explicit formatter already set.
// ----------------------------------------------------------------
function isYearRange(axis: Record<string, unknown>): boolean {
  if (axis['type'] !== 'value') return false
  const min = typeof axis['min'] === 'number' ? axis['min'] : null
  const max = typeof axis['max'] === 'number' ? axis['max'] : null
  // If explicit min/max in year range, or if series data implies years
  if (min !== null && max !== null) {
    return min >= 800 && max <= 2200 && (max - min) < 1000
  }
  return false
}

function fixYearAxes(opt: Record<string, unknown>): Record<string, unknown> {
  const patchAxis = (axis: unknown): unknown => {
    if (!axis || typeof axis !== 'object' || Array.isArray(axis)) return axis
    const a = axis as Record<string, unknown>
    if (!isYearRange(a)) return axis
    // Only add formatter if not already set
    if (a['axisLabel'] && typeof a['axisLabel'] === 'object') {
      const al = a['axisLabel'] as Record<string, unknown>
      if (al['formatter']) return axis  // already has one, leave alone
      return { ...a, axisLabel: { ...al, formatter: '{value}' } }
    }
    return { ...a, axisLabel: { ...(a['axisLabel'] as object ?? {}), formatter: '{value}' } }
  }

  const result = { ...opt }
  if (result['xAxis']) result['xAxis'] = Array.isArray(result['xAxis'])
    ? (result['xAxis'] as unknown[]).map(patchAxis)
    : patchAxis(result['xAxis'])
  if (result['yAxis']) result['yAxis'] = Array.isArray(result['yAxis'])
    ? (result['yAxis'] as unknown[]).map(patchAxis)
    : patchAxis(result['yAxis'])
  return result
}

// ----------------------------------------------------------------
// looksLikeEChartsOption
//
// Returns true when a parsed JSON object looks like an ECharts option
// (has a series array). Used to route ```json blocks that the model
// accidentally tagged as json instead of echarts.
// ----------------------------------------------------------------
function looksLikeEChartsOption(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const obj = parsed as Record<string, unknown>
  return Array.isArray(obj['series']) && obj['series'].length > 0
}

interface EchartsBlockProps {
  code: string
}

function EchartsBlock({ code }: EchartsBlockProps) {
  const isStreaming = useContext(StreamingCtx)

  // `option` = parsed + dark-themed + format-fixed option object.
  // `renderOption` = what ReactECharts actually receives, deferred to idle time
  // so that echarts.init() never blocks a streaming token render.
  const [option,       setOption]       = useState<Record<string, unknown> | null>(null)
  const [renderOption, setRenderOption] = useState<Record<string, unknown> | null>(null)
  const [error,        setError]        = useState<string | null>(null)

  const lastParsedCode = useRef<string | null>(null)

  // ── Parse JSON when code changes (debounced while streaming) ──
  useEffect(() => {
    if (code === lastParsedCode.current) return
    const delay = isStreaming ? 600 : 0
    let cancelled = false

    const timer = setTimeout(() => {
      if (cancelled) return

      // ── JSON repair: fix the most common model output mistakes ───
      // Models occasionally produce slightly malformed JSON:
      //   1. Trailing commas before } or ]
      //   2. A stray { before a "key": pair inside an object
      // We try the raw code first, then the repaired version.
      function repairEChartsJson(raw: string): string {
        let s = raw.trim()
        s = s.replace(/,(\s*[}\]])/g, '$1')                        // trailing commas
        s = s.replace(/([,{\[]\s*)\{(\s*"[^"]+"\s*:)/g, '$1$2')   // stray { before key
        return s
      }

      function tryParse(src: string): Record<string, unknown> {
        const p = JSON.parse(src)
        if (typeof p !== 'object' || Array.isArray(p) || p === null)
          throw new Error('ECharts option must be a JSON object')
        return p as Record<string, unknown>
      }

      try {
        let parsed: Record<string, unknown>
        try {
          parsed = tryParse(code)
        } catch {
          // First parse failed — attempt light repair
          parsed = tryParse(repairEChartsJson(code))
        }
        lastParsedCode.current = code
        const merged    = deepMerge(ECHARTS_DARK_BASE, parsed)
        // Order matters: sanitize model formatters FIRST, then fixYearAxes adds correct ones.
        // If reversed, fixYearAxes skips axes that already have a (bad) model formatter,
        // then sanitizeFormatters removes it — leaving year axes with no formatter at all.
        const sanitized = sanitizeFormatters(fixSeriesDataFormat(merged)) as Record<string, unknown>
        const fixed     = fixYearAxes(sanitized)
        setOption(fixed)
        setError(null)
      } catch (err) {
        lastParsedCode.current = code
        setError(err instanceof Error ? err.message : String(err))
        setOption(null)
        setRenderOption(null)
      }
    }, delay)

    return () => { cancelled = true; clearTimeout(timer) }
  }, [code, isStreaming])

  // ── Defer ReactECharts mount to idle time ──────────────────────
  // echarts.init() + setOption() is synchronous CPU work (~200–500 ms).
  // Running it in componentDidMount of ReactECharts blocks the main thread
  // and causes streaming token renders to visually pause.
  // scheduleIdle() pushes the mount until the browser has a free moment,
  // so streaming text always stays responsive.
  useEffect(() => {
    if (!option) { setRenderOption(null); return }
    const cancel = scheduleIdle(() => setRenderOption(option))
    return cancel
  }, [option])

  const border = error ? 'border-accent-900/30' : 'border-surface-border/60'

  return (
    <div
      className={`group my-4 rounded-xl overflow-hidden border ${border}`}
      style={{ background: '#141414' }}
    >
      {/* Header bar */}
      <div
        className={`flex items-center justify-between px-4 py-2.5 border-b ${border}`}
        style={{ background: '#111' }}
      >
        <div className="flex items-center gap-2">
          <BarChart2 className={`w-3.5 h-3.5 ${error ? 'text-accent-800' : 'text-content-muted'}`} />
          <span className={`text-[11px] font-mono font-medium tracking-wide uppercase ${error ? 'text-accent-800' : 'text-content-tertiary'}`}>
            {error ? 'Plot (parse error)' : 'Plot'}
          </span>
        </div>
        <CopyButton text={code} />
      </div>

      {/* Body */}
      {error ? (
        <div className="overflow-x-auto">
          <pre className="p-4 m-0 text-[13px] leading-relaxed font-mono text-content-secondary whitespace-pre">
            {code}
          </pre>
        </div>
      ) : !renderOption ? (
        // Shown while: (a) still streaming/debouncing, (b) idle-scheduled, (c) error
        <div className="px-4 py-6 flex justify-center" style={{ height: '80px' }}>
          <div className="w-4 h-4 rounded-full border-2 border-surface-border border-t-accent-600 animate-spin" />
        </div>
      ) : (
        <div className="p-2">
          <ReactECharts
            option={renderOption}
            style={{ height: '360px', width: '100%' }}
            opts={{ renderer: 'svg', locale: 'EN' }}
            notMerge
          />
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// SVG render block
//
// Renders raw SVG markup from ```svg fenced code blocks directly into
// the chat. Uses dangerouslySetInnerHTML — safe here because the only
// source is the local LLM (same trust level as the Mermaid path which
// also uses dangerouslySetInnerHTML on line ~299).
//
// Streaming behaviour: same debounce pattern as MermaidBlock.
//   isStreaming=true  → 600ms debounce (waits for ``` close)
//   isStreaming=false → renders immediately
// The rendered SVG is stored in state so partial SVG mid-stream never
// flashes corrupted markup — we only commit once the code stabilises.
//
// Layout: reuses DiagramCard shell (header bar + copy button) with a
// dedicated "SVG" label and the Shapes icon from lucide-react.
// ----------------------------------------------------------------

interface SvgBlockProps {
  code: string
}

function SvgBlock({ code }: SvgBlockProps) {
  const isStreaming = useContext(StreamingCtx)
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null)
  const lastRenderedCode = useRef<string | null>(null)

  useEffect(() => {
    if (code === lastRenderedCode.current) return

    const delay = isStreaming ? 600 : 0
    let cancelled = false

    const timer = setTimeout(() => {
      if (cancelled) return
      // Basic structural validation — must contain an opening <svg tag
      if (!code.trim().toLowerCase().includes('<svg')) {
        setRenderedSvg(null)
        return
      }
      lastRenderedCode.current = code
      setRenderedSvg(code)
    }, delay)

    return () => { cancelled = true; clearTimeout(timer) }
  }, [code, isStreaming])

  if (!renderedSvg) {
    return (
      <div
        className="my-4 rounded-xl border border-surface-border/60 px-4 py-6 flex justify-center"
        style={{ background: '#141414' }}
      >
        <div className="w-4 h-4 rounded-full border-2 border-surface-border border-t-accent-600 animate-spin" />
      </div>
    )
  }

  return (
    <DiagramCard
      code={code}
      icon={<Shapes className="w-3.5 h-3.5 text-content-muted" />}
      label="SVG"
    >
      <div
        className="p-4 diagram-block"
        dangerouslySetInnerHTML={{ __html: renderedSvg }}
      />
    </DiagramCard>
  )
}

// ----------------------------------------------------------------
// Copy button
// ----------------------------------------------------------------
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    const markCopied = () => { setCopied(true); setTimeout(() => setCopied(false), 2000) }
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback for environments without clipboard API
      const el = document.createElement('textarea')
      el.value = text
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    }
    markCopied()
  }, [text])

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
        'transition-all duration-150',
        'border',
        copied
          ? 'bg-emerald-950/50 border-emerald-800/40 text-emerald-400'
          : 'bg-surface-DEFAULT border-surface-border text-content-tertiary hover:text-content-secondary hover:border-surface-hover'
      )}
    >
      {copied
        ? <><Check className="w-3 h-3" />Copied</>
        : <><Copy className="w-3 h-3" />Copy</>
      }
    </button>
  )
}

// ----------------------------------------------------------------
// Code block component
// ----------------------------------------------------------------
// Matplotlib block
//
// Sends the Python script to the main process via window.api.renderMatplotlib,
// which wraps it with: dark-theme rcParams, pre-imported plt/np, and the
// savefig → base64 epilogue.  The result is displayed as a PNG image.
//
// While streaming, rendering is deferred (same 600ms debounce as ECharts/Mermaid).
// If python3 is missing or matplotlib is not installed, the error is shown
// and the raw code is displayed as a fallback.
// ----------------------------------------------------------------
interface MatplotlibBlockProps {
  code: string
}

function MatplotlibBlock({ code }: MatplotlibBlockProps) {
  const isStreaming = useContext(StreamingCtx)
  const chatId      = useContext(ChatIdCtx)
  const [imageBase64, setImageBase64] = useState<string | null>(null)
  const [error,       setError]       = useState<string | null>(null)
  const [running,     setRunning]     = useState(false)
  const lastRenderedCode = useRef<string | null>(null)
  // Always holds the latest code value so timeout callbacks can detect staleness.
  const lastCodeRef = useRef<string>(code)

  useEffect(() => {
    lastCodeRef.current = code

    // Skip if we already rendered this exact code.
    if (code === lastRenderedCode.current) return

    let cancelled = false

    // While streaming: wait 800ms of code stability before executing.
    // At ~71 tok/s, 800ms ≈ 57 tokens of silence — reliable indicator that
    // the closing ``` has been received and the model has moved on.
    // After streaming ends: 200ms settle delay is sufficient.
    const delay = isStreaming ? 800 : 200

    const timer = setTimeout(async () => {
      if (cancelled) return
      // If code changed during our wait (another effect ran), abort — the
      // newer invocation will handle the updated code.
      if (lastCodeRef.current !== code) return

      setRunning(true)
      lastRenderedCode.current = code
      try {
        const result = await window.api.renderMatplotlib(code)
        if (cancelled) return
        if (result.success && result.imageBase64) {
          setImageBase64(result.imageBase64)
          setError(null)
          
          // Image RAG: Fire and forget storage. Extract caption directly from code.
          if (chatId) {
            const titleMatch  = code.match(/plt\.(?:title|suptitle)\(\s*['"]([^'"]+)['"]/)
            const xlabelMatch = code.match(/plt\.xlabel\(\s*['"]([^'"]+)['"]/)
            const varMatch    = code.match(/^(\w+)\s*=/m)
            const extractedCaption = titleMatch?.[1] ?? xlabelMatch?.[1] ?? (varMatch ? `chart of ${varMatch[1]}` : 'chart')
            window.api.storePlot({ chatId, code, imageBase64: result.imageBase64, caption: String(extractedCaption) })
              .catch(err => console.warn('[MatplotlibBlock] Could not store plot:', err))
          }
        } else {
          setError(result.error ?? 'matplotlib render failed')
          setImageBase64(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setRunning(false)
      }
    }, delay)

    return () => { cancelled = true; clearTimeout(timer) }
  }, [code, isStreaming, chatId])

  const border = error ? 'border-accent-900/30' : 'border-surface-border/60'

  return (
    <div
      className={`group my-4 rounded-xl overflow-hidden border ${border}`}
      style={{ background: '#141414' }}
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between px-4 py-2.5 border-b ${border}`}
        style={{ background: '#111' }}
      >
        <div className="flex items-center gap-2">
          <LineChart className={`w-3.5 h-3.5 ${error ? 'text-accent-800' : 'text-content-muted'}`} />
          <span className={`text-[11px] font-mono font-medium tracking-wide uppercase ${error ? 'text-accent-800' : 'text-content-tertiary'}`}>
            {error ? 'Plot (error)' : 'Plot'}
          </span>
        </div>
        <CopyButton text={code} />
      </div>

      {/* Body */}
      {(running || (!imageBase64 && !error && (isStreaming || Boolean(code)))) ? (
        <div className="px-4 py-6 flex items-center justify-center gap-3" style={{ minHeight: '80px' }}>
          <div className="w-4 h-4 rounded-full border-2 border-surface-border border-t-accent-600 animate-spin" />
          <span className="text-xs text-content-muted">{running ? 'Running Python…' : 'Rendering…'}</span>
        </div>
      ) : error ? (
        <div className="p-4 space-y-2">
          <p className="text-xs text-accent-500 font-mono whitespace-pre-wrap">
            {error.split('\n').slice(0, 3).join('\n')}
          </p>
          <details className="group">
            <summary className="text-xs text-content-tertiary cursor-pointer select-none hover:text-content-secondary">
              Show code
            </summary>
            <pre className="mt-2 text-[12px] leading-relaxed font-mono text-content-secondary whitespace-pre overflow-x-auto">
              {code}
            </pre>
          </details>
        </div>
      ) : imageBase64 ? (
        <div className="p-2">
          <img
            src={`data:image/png;base64,${imageBase64}`}
            alt="matplotlib chart"
            className="w-full rounded-lg"
            style={{ background: '#0f0f0f' }}
          />
        </div>
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------
interface CodeProps extends ComponentPropsWithoutRef<'code'> {
  inline?:    boolean
  className?: string
  children?:  React.ReactNode
}

function CodeBlock({ className, children, inline }: CodeProps) {
  const rawCode = String(children ?? '').replace(/\n$/, '')
  const match   = /language-(\w+)/.exec(className ?? '')
  const lang    = match?.[1]
  const kind    = classifyCodeBlock(lang)

  // ── Inline code ──
  // react-markdown sets inline=true for `backtick` spans inside paragraphs.
  // Fenced code blocks (``` ... ```) always receive inline=undefined, even
  // when no language tag is given — classifyCodeBlock would return 'inline'
  // for those too, so we gate on the inline prop rather than kind to avoid
  // rendering plain ``` fences as inline <code> spans.
  if (inline) {
    return <code className={className}>{children}</code>
  }

  // ── Mermaid diagram ──
  if (kind === 'mermaid') {
    return <MermaidBlock code={rawCode} />
  }

  // ── Matplotlib chart ──
  if (kind === 'matplotlib') {
    return <MatplotlibBlock code={rawCode} />
  }

  // ── SVG diagram ──
  if (kind === 'svg') {
    return <SvgBlock code={rawCode} />
  }

  // ── ECharts interactive plot ──
  // Also catches ```json blocks that the model tagged incorrectly — if the
  // parsed object looks like an ECharts option (has a series array) we render
  // it as a chart instead of a syntax-highlighted code block.
  if (kind === 'echarts') {
    return <EchartsBlock code={rawCode} />
  }
  if (lang === 'json') {
    try {
      const parsed = JSON.parse(rawCode)
      if (looksLikeEChartsOption(parsed)) {
        return <EchartsBlock code={rawCode} />
      }
    } catch { /* not valid JSON — fall through to code block */ }
  }

  // ── Syntax-highlighted code block (highlight.js) ──
  let highlighted = rawCode
  try {
    highlighted = hljs.highlight(rawCode, { language: lang!, ignoreIllegals: true }).value
  } catch {
    try {
      highlighted = hljs.highlightAuto(rawCode).value
    } catch { /* use raw */ }
  }

  return (
    <div
      className="group my-4 rounded-xl overflow-hidden border border-surface-border/60"
      style={{ background: '#141414' }}
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b border-surface-border/60"
        style={{ background: '#111' }}
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-content-muted" />
          <span className="text-[11px] font-mono font-medium text-content-tertiary tracking-wide uppercase">
            {lang ?? 'code'}
          </span>
        </div>
        <CopyButton text={rawCode} />
      </div>

      {/* Code body */}
      <div className="overflow-x-auto">
        <pre className="p-4 m-0 text-[13px] leading-relaxed font-mono">
          <code
            className={lang ? `hljs language-${lang}` : 'hljs'}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// Component map — created ONCE per MarkdownRenderer instance.
//
// isStreaming is NOT threaded through here any more.  MermaidBlock
// reads it from StreamingCtx so this object never needs to be
// recreated, which means no MermaidBlock ever remounts mid-stream
// and loses its already-rendered SVG.
// ----------------------------------------------------------------

function buildComponents(): Components {
  return {
    code: (props) => <CodeBlock {...props} />,

    // Suppress the default <pre> wrapper — CodeBlock renders its own
    pre: ({ children }) => <>{children}</>,

    // Open links in default OS browser via Electron shell.openExternal
    a: ({ href, children }) => (
      <a
        href={href}
        className="text-accent-400 underline underline-offset-2 hover:text-accent-300 cursor-pointer transition-colors"
        onClick={(e) => {
          e.preventDefault()
          if (href) window.api.openExternal(href).catch(console.error)
        }}
      >
        {children}
      </a>
    ),

    // ── GFM table components ─────────────────────────────────────
    table: ({ children }) => (
      <div
        className="my-4 w-full overflow-x-auto rounded-xl border border-surface-border/60"
        style={{ background: '#141414' }}
      >
        <table className="w-full border-collapse text-[13px]">
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => (
      <thead style={{ background: '#111' }}>{children}</thead>
    ),
    tbody: ({ children }) => (
      <tbody>{children}</tbody>
    ),
    tr: ({ children }) => (
      <tr className="border-b border-surface-border/50 last:border-0">{children}</tr>
    ),
    th: ({ children }) => (
      <th className="px-4 py-2.5 text-left text-[11px] font-semibold tracking-wide uppercase
                     text-content-tertiary border-r border-surface-border/40 last:border-0">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-4 py-2.5 text-content-secondary leading-relaxed
                     border-r border-surface-border/30 last:border-0">
        {children}
      </td>
    ),

    // ── GFM task-list checkbox ────────────────────────────────────
    input: ({ type, checked }) =>
      type === 'checkbox' ? (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          className="mr-2 accent-accent-600 cursor-default"
        />
      ) : null,
  }
}

// ----------------------------------------------------------------
// MarkdownRenderer — public API
// ----------------------------------------------------------------

interface MarkdownRendererProps {
  content:     string
  isStreaming?: boolean
  variant?:    'assistant' | 'user'   // default: 'assistant'
}

export function MarkdownRenderer({ content, isStreaming = false, variant = 'assistant' }: MarkdownRendererProps) {
  // ── Hooks that must run unconditionally (before any early return) ─────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const userComponents = useMemo(() => buildComponents(), [])
  // Prepend hard line breaks to non-fence lines so Shift+Enter newlines render
  // as <br> in the user bubble. Must be computed unconditionally.
  const prepared = useMemo(() => prepareUserContent(content), [content])

  // ── User variant — no think parsing, no escaping, no cursor ──────────────
  if (variant === 'user') {
    return (
      <StreamingCtx.Provider value={false}>
        <div className="prose-chat prose-user selectable">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={userComponents}
          >
            {prepared}
          </ReactMarkdown>
        </div>
      </StreamingCtx.Provider>
    )
  }

  // ── Assistant variant — existing logic unchanged ──────────────────────────
  // Memoised so the O(n) string scans only run when content actually changes,
  // not on every re-render during streaming (which can fire 10–50× per second).
  const { thought, answer: rawAnswer, isThinking } = useMemo(
    () => parseThinkBlocks(content, !isStreaming),
    [content, isStreaming]
  )
  // Escape currency dollar signs ($164.65 → \$164.65) before remarkMath sees
  // the content, so price strings are never fed to KaTeX as inline math.
  const answer = useMemo(() => escapeCurrencyDollars(rawAnswer), [rawAnswer])
  const hasThought = thought.length > 0

  // buildComponents() has no deps — created once, never recreated.
  // isStreaming is propagated to MermaidBlock via StreamingCtx instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const components = useMemo(() => buildComponents(), [])

  return (
    <StreamingCtx.Provider value={isStreaming}>
    <div className="prose-chat selectable">

      {/* ── Thought Process accordion ─────────────────────────── */}
      {hasThought && (
        <details
          className="group/think mb-3 rounded-lg overflow-hidden
                     border border-accent-900/30
                     bg-[rgba(127,29,29,0.04)]"
        >
          <summary
            className="flex items-center gap-2 px-3 py-2
                       text-[11px] font-medium text-content-muted
                       cursor-pointer select-none list-none
                       [&::-webkit-details-marker]:hidden
                       hover:text-content-secondary transition-colors duration-100"
          >
            <ChevronRight
              className="w-3 h-3 flex-shrink-0 transition-transform duration-150
                         group-open/think:rotate-90"
            />
            {isThinking ? 'Thinking…' : 'Thought Process'}
            {isThinking && (
              <span
                className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-accent-600 animate-pulse"
              />
            )}
          </summary>

          {/* Thought body */}
          <div
            className="px-3 pb-3 pt-2 border-t border-accent-900/20
                       max-h-52 overflow-y-auto
                       text-[11px] text-content-muted/70 font-mono
                       leading-relaxed whitespace-pre-wrap"
          >
            {thought || '…'}
          </div>
        </details>
      )}

      {/* ── Main answer ───────────────────────────────────────── */}
      {answer && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={components}
        >
          {answer}
        </ReactMarkdown>
      )}

      {/* Blinking cursor while streaming (shown during thinking OR answer) */}
      {isStreaming && (isThinking || answer) && (
        <span className="cursor-blink" aria-hidden />
      )}
    </div>
    </StreamingCtx.Provider>
  )
}
