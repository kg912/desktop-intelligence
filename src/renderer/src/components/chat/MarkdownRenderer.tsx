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
import { Check, Copy, Terminal, ChevronRight, GitBranch } from 'lucide-react'
import hljs from 'highlight.js'
import mermaid from 'mermaid'
import { cn } from '../../lib/utils'
import {
  parseThinkBlocks,
  classifyCodeBlock,
  isValidMermaidSyntax,
} from '../../lib/markdownUtils'

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
  return svg
    .replace(/(<svg\b[^>]*?)\s+width="[\d.]+(?:px)?"/i,  '$1')
    .replace(/(<svg\b[^>]*?)\s+height="[\d.]+(?:px)?"/i, '$1')
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
    if (!isValidMermaidSyntax(code)) {
      setError('Unrecognised diagram syntax — showing source')
      return
    }

    // Nothing to do if the code hasn't changed since last render.
    // This fires when isStreaming flips false after a block already rendered.
    if (code === lastRenderedCode.current) return

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
        const { svg: out } = await mermaid.render(id.current, code)
        if (!cancelled) {
          lastRenderedCode.current = code
          setSvg(makeResponsiveSvg(out))
          setError(null)
        }
      } catch (err) {
        console.error('[Mermaid] render failed:', err)
        if (!cancelled) {
          lastRenderedCode.current = code   // don't retry identical bad code
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
      <div
        className="group my-4 rounded-xl overflow-hidden border border-accent-900/30"
        style={{ background: '#141414' }}
      >
        <div
          className="flex items-center justify-between px-4 py-2.5 border-b border-accent-900/30"
          style={{ background: '#111' }}
        >
          <div className="flex items-center gap-2">
            <GitBranch className="w-3.5 h-3.5 text-accent-800" />
            <span className="text-[11px] font-mono font-medium text-accent-800 tracking-wide uppercase">
              Diagram (parse error)
            </span>
          </div>
          <CopyButton text={code} />
        </div>
        <div className="overflow-x-auto">
          <pre className="p-4 m-0 text-[13px] leading-relaxed font-mono text-content-secondary whitespace-pre">
            {code}
          </pre>
        </div>
      </div>
    )
  }

  // ── Loading (valid syntax, awaiting async render) ──
  if (!svg) {
    return (
      <div
        className="my-4 rounded-xl border border-surface-border/60 px-4 py-6 flex justify-center"
        style={{ background: '#141414' }}
      >
        <div
          className="w-4 h-4 rounded-full border-2 border-surface-border border-t-accent-600 animate-spin"
        />
      </div>
    )
  }

  // ── Success: render the SVG ──
  return (
    <div
      className="group my-4 rounded-xl overflow-hidden border border-surface-border/60"
      style={{ background: '#141414' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b border-surface-border/60"
        style={{ background: '#111' }}
      >
        <div className="flex items-center gap-2">
          <GitBranch className="w-3.5 h-3.5 text-content-muted" />
          <span className="text-[11px] font-mono font-medium text-content-tertiary tracking-wide uppercase">
            Diagram
          </span>
        </div>
        <CopyButton text={code} />
      </div>

      {/* SVG viewport — max-height caps very tall diagrams;
          overflow-auto lets the user scroll within the card */}
      <div
        className="overflow-auto p-4 flex justify-center diagram-block"
        style={{ maxHeight: '70vh' }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}

// ----------------------------------------------------------------
// Copy button
// ----------------------------------------------------------------
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for environments without clipboard API
      const el = document.createElement('textarea')
      el.value = text
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
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
interface CodeProps extends ComponentPropsWithoutRef<'code'> {
  inline?:    boolean
  className?: string
  children?:  React.ReactNode
}

function CodeBlock({ className, children }: CodeProps) {
  const rawCode = String(children ?? '').replace(/\n$/, '')
  const match   = /language-(\w+)/.exec(className ?? '')
  const lang    = match?.[1]
  const kind    = classifyCodeBlock(lang)

  // ── Inline code ──
  if (kind === 'inline') {
    return <code className={className}>{children}</code>
  }

  // ── Mermaid diagram ──
  if (kind === 'mermaid') {
    return <MermaidBlock code={rawCode} />
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
            {lang}
          </span>
        </div>
        <CopyButton text={rawCode} />
      </div>

      {/* Code body */}
      <div className="overflow-x-auto">
        <pre className="p-4 m-0 text-[13px] leading-relaxed font-mono">
          <code
            className={`hljs language-${lang}`}
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

    // Open links in default OS browser (handled by Electron shell)
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          console.log('External link:', href)
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
}

export function MarkdownRenderer({ content, isStreaming = false }: MarkdownRendererProps) {
  const { thought, answer, isThinking } = parseThinkBlocks(content)
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
