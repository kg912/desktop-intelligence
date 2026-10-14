// Spec B 7a: claim chips wherever a run's text is shown — the final answer, agent reports, the focus view and the
// run's answer message in the chat. Layout provides the run and the drawer; without it, plain markdown as before.
import { createContext, useContext, useMemo } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { linkClaims, refFromHref } from '../../lib/claimsView'
import type { RunView } from '../../lib/multiAgentRunState'
import type { ClaimTarget } from './ClaimsDrawer'

export interface ClaimLinks {
  view: RunView
  open: (target: ClaimTarget) => void
  onSelectAgent?: (agentId: string) => void
}

export const ClaimLinksContext = createContext<ClaimLinks | null>(null)

/** Markdown with [1.2] / [1.2 c3] chips (and [c3] as agent `own`'s claim). `onlyIf`: link only this exact text (the
 *  run's own final answer), so another run's message never borrows this run's statuses. */
export function ClaimLinkedMarkdown({ text, own, isStreaming, onlyIf }: { text: string; own?: string; isStreaming?: boolean; onlyIf?: (links: ClaimLinks) => boolean }) {
  const ctx = useContext(ClaimLinksContext)
  const active = !!ctx && (!onlyIf || onlyIf(ctx))
  const linked = useMemo(() => (active && ctx ? linkClaims(text, new Set(ctx.view.steps.map((s) => s.id)), ctx.view, own) : text), [active, ctx, text, own])
  if (!active || !ctx) return <MarkdownRenderer content={text} isStreaming={isStreaming} />
  return (
    <div className="provenance" onClickCapture={(e) => {
      const href = (e.target as HTMLElement).closest('a')?.getAttribute('href') ?? ''
      const ref = refFromHref(href)
      if (ref) {
        e.preventDefault()
        e.stopPropagation()
        ctx.open({ agentId: ref.split(' ')[0], ref })
      } else if (href.startsWith('#agent-') && ctx.onSelectAgent) {
        e.preventDefault()
        e.stopPropagation()
        ctx.onSelectAgent(href.slice('#agent-'.length))
      }
    }}>
      <MarkdownRenderer content={linked} isStreaming={isStreaming} />
    </div>
  )
}
