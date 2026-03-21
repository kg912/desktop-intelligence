/**
 * MarkdownRenderer
 *
 * Renders AI markdown responses with:
 *  - react-markdown for structure
 *  - remark-math + rehype-katex for LaTeX ($...$ and $$...$$)
 *  - highlight.js for syntax-highlighted code blocks
 *  - Custom CodeBlock with language badge + copy button
 *  - <think>...</think> accordion — model reasoning shown in a
 *    collapsible "Thought Process" disclosure widget
 */

import 'katex/dist/katex.min.css'

import { useState, useCallback, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { Check, Copy, Terminal, ChevronRight } from 'lucide-react'
import hljs from 'highlight.js'
import { cn } from '../../lib/utils'
import type { Components } from 'react-markdown'

// ----------------------------------------------------------------
// <think> tag parser
// ----------------------------------------------------------------
interface ParsedContent {
  thought:    string   // text inside <think>
  answer:     string   // text after </think>
  isThinking: boolean  // true if <think> is open but not yet closed
}

function parseThinkBlocks(raw: string): ParsedContent {
  // Fully closed: <think>...</think> (then optional whitespace, then the answer)
  const closed = /^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/m.exec(raw)
  if (closed) {
    return { thought: closed[1].trim(), answer: closed[2], isThinking: false }
  }
  // Still open (streaming the thought right now)
  if (raw.startsWith('<think>')) {
    return { thought: raw.slice('<think>'.length), answer: '', isThinking: true }
  }
  // No think tags — plain response
  return { thought: '', answer: raw, isThinking: false }
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
  inline?: boolean
  className?: string
  children?: React.ReactNode
}

function CodeBlock({ inline, className, children }: CodeProps) {
  const rawCode = String(children ?? '').replace(/\n$/, '')
  const match   = /language-(\w+)/.exec(className ?? '')
  const lang    = match?.[1]

  // ── Inline code ──
  if (inline || !lang) {
    return (
      <code className={className}>
        {children}
      </code>
    )
  }

  // ── Block: highlight with hljs ──
  let highlighted = rawCode
  try {
    highlighted = hljs.highlight(rawCode, { language: lang, ignoreIllegals: true }).value
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
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-border/60"
           style={{ background: '#111' }}>
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
// MarkdownRenderer
// ----------------------------------------------------------------
const COMPONENTS: Components = {
  code: CodeBlock as Components['code'],

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
    <div className="my-4 w-full overflow-x-auto rounded-xl border border-surface-border/60"
         style={{ background: '#141414' }}>
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

interface MarkdownRendererProps {
  content:     string
  isStreaming?: boolean
}

export function MarkdownRenderer({ content, isStreaming = false }: MarkdownRendererProps) {
  const { thought, answer, isThinking } = parseThinkBlocks(content)
  const hasThought = thought.length > 0

  return (
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
          components={COMPONENTS}
        >
          {answer}
        </ReactMarkdown>
      )}

      {/* Blinking cursor while streaming (shown during thinking OR answer) */}
      {isStreaming && (isThinking || answer) && (
        <span className="cursor-blink" aria-hidden />
      )}
    </div>
  )
}
