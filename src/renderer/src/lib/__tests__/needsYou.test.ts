// Spec B 7e: when the run needs the user — the first "Needs you" item of a batch, or an assess question — a notification
// is asked for (main shows it only while the window is unfocused).
import { describe, it, expect } from 'vitest'
import { needsYou, nextNotification } from '../needsYou'
import { reduceRunEvents } from '../multiAgentRunState'
import type { AgentEvent, McpToolPermissionRequest } from '../../../../shared/types'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'r', seq, ts: seq, ...e }) as unknown as AgentEvent
const steps = [{ id: '1.2', label: 'Leg 2', stage: 'worker', role: 'Leg 2', model: 'm', phase: 1, dependsOn: [] }]
const plan = ev(1, { type: 'orchestrator_plan', steps })
const preflight = ev(2, { type: 'hitl_pause', agentId: 'orchestrator', role: 'O', serverName: 'multi-agent', toolName: 'approve_plan', args: {} })
const approved = ev(3, { type: 'hitl_resume', agentId: 'orchestrator', approved: true })
const req = (n: number): McpToolPermissionRequest => ({ serverName: 'builtin', toolName: 'builtin__brave_web_search', args: {}, requestId: `q${n}`, chatId: 'c',
  agent: { runId: 'r', agentId: '1.2', role: 'Leg 2', model: 'm' }, timeoutMs: 1 })
const RULES = { checklist: { open: 1, total: 1 }, waves: { used: 1, max: 2 }, budget: { spentUsd: 0, capUsd: 1 }, progress: 'first', tools: 'n/a' }

describe('needsYou', () => {
  it('counts the plan approval, tool approvals of this run, and an assess pause', () => {
    expect(needsYou(reduceRunEvents('r', [plan, preflight]), []).count).toBe(1)
    expect(needsYou(reduceRunEvents('r', [plan, preflight, approved]), [req(1), req(2), { ...req(3), agent: { ...req(3).agent!, runId: 'other' } }]).count).toBe(2)
    expect(needsYou(reduceRunEvents('r', [plan, preflight]), [], true).count).toBe(0)  // a read-only review needs nothing
  })
})

describe('nextNotification', () => {
  const idle = { count: 0 }
  it('the first item of a batch notifies; more items in the same batch do not', () => {
    const one = needsYou(reduceRunEvents('r', [plan, preflight, approved]), [req(1)])
    expect(nextNotification(idle, one)).toEqual({ title: 'A multi-agent run needs you', body: 'Leg 2 asks to run brave_web_search.' })
    const two = needsYou(reduceRunEvents('r', [plan, preflight, approved]), [req(1), req(2)])
    expect(nextNotification(one, two)).toBeNull()
    expect(nextNotification(two, idle)).toBeNull()
    expect(nextNotification(idle, two)).toEqual({ title: 'A multi-agent run needs you', body: '2 approvals are waiting.' })
  })

  it('the plan approval and a follow-up approval say what they are', () => {
    expect(nextNotification(idle, needsYou(reduceRunEvents('r', [plan, preflight]), []))).toEqual({ title: 'A multi-agent run needs you', body: 'Review the plan before any agent starts.' })
    const followUp = reduceRunEvents('r', [plan, preflight, approved,
      ev(4, { type: 'assess_decision', wave: 1, decision: 'follow_up', reason: '', steps: [], unclosable: [], costUsd: 0, durationMs: 0, model: 'm', rules: RULES, estimatedUsd: 0.4, autoRun: false }),
      ev(5, { type: 'hitl_pause', agentId: 'assess', role: 'Assess', serverName: 'multi-agent', toolName: 'approve_followup', args: {} })])
    expect(nextNotification(idle, needsYou(followUp, []))).toEqual({ title: 'A multi-agent run needs you', body: 'Approve or skip the follow-up research.' })
  })

  it('an assess question always notifies, with the question', () => {
    const asking = reduceRunEvents('r', [plan, preflight, approved,
      ev(4, { type: 'assess_decision', wave: 1, decision: 'ask_user', reason: '', question: 'Kayseri or Nevşehir?', steps: [], unclosable: [], costUsd: 0, durationMs: 0, model: 'm', rules: RULES }),
      ev(5, { type: 'hitl_pause', agentId: 'assess', role: 'Assess', serverName: 'multi-agent', toolName: 'ask_user', args: { question: 'Kayseri or Nevşehir?' } })])
    const state = needsYou(asking, [req(1)])
    expect(nextNotification(needsYou(reduceRunEvents('r', [plan, preflight, approved]), [req(1)]), state)).toEqual({ title: 'A multi-agent run has a question', body: 'Kayseri or Nevşehir?' })
    expect(nextNotification(state, state)).toBeNull()  // the same question once
  })
})
