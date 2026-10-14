// Spec B 7e: what the run is waiting on the user for, and when that is worth a notification (pure).
import type { McpToolPermissionRequest } from '../../../shared/types'
import type { RunView } from './multiAgentRunState'

export interface NeedsYou {
  count: number
  /** An assess ask_user question, when one is open. */
  question?: string
  headline?: string
}

/** The plan approval, this run's tool approvals and an assess pause. A read-only review needs nothing. */
export function needsYou(view: RunView, requests: McpToolPermissionRequest[], readOnly = false): NeedsYou {
  if (readOnly) return { count: 0 }
  const tools = requests.filter((r) => r.agent?.runId === view.runId)
  const plan = view.phase === 'preflight' && !!view.planPause
  const assess = view.assessPause
  const count = tools.length + (plan ? 1 : 0) + (assess ? 1 : 0)
  const question = assess?.toolName === 'ask_user' ? String(view.assess.at(-1)?.question ?? assess.args.question ?? '') : undefined
  const headline = plan ? 'Review the plan before any agent starts.'
    : assess?.toolName === 'approve_followup' ? 'Approve or skip the follow-up research.'
    : tools.length === 1 ? `${tools[0].agent?.role ?? 'An agent'} asks to run ${tools[0].toolName.split('__').pop()}.`
    : tools.length > 1 ? `${tools.length} approvals are waiting.` : undefined
  return { count, ...(question ? { question } : {}), ...(headline ? { headline } : {}) }
}

/** A notification for the first item of a batch (the count leaving 0) or a new assess question; else null. */
export function nextNotification(prev: NeedsYou, next: NeedsYou): { title: string; body: string } | null {
  if (next.question && next.question !== prev.question) return { title: 'A multi-agent run has a question', body: next.question }
  if (prev.count === 0 && next.count > 0 && next.headline) return { title: 'A multi-agent run needs you', body: next.headline }
  return null
}
