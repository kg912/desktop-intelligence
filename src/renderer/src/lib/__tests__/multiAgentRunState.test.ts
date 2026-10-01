import { describe, it, expect } from 'vitest'
import {
  applyAgentEvent,
  emptyRunView,
  inputLockMessage,
  linkProvenance,
  pausedAgents,
  reduceRunEvents,
  formatElapsed,
} from '../multiAgentRunState'
import type { AgentEvent } from '../../../../shared/types'

let seq = 0
const ev = (e: Record<string, unknown>): AgentEvent => ({ runId: 'r', seq: ++seq, ts: 1_000 * seq, ...e }) as AgentEvent
const steps = [
  { id: '1.1', label: 'Research', stage: 'worker', role: 'Researcher', model: 'w', phase: 1 },
  { id: '1.2', label: 'Analyze', stage: 'worker', role: 'Analyzer', model: 'w', phase: 1 },
]

describe('multi-agent run view', () => {
  it('walks the layout state machine: planning → preflight → running → synthesizing → complete', () => {
    seq = 0
    let v = emptyRunView('r')
    expect(v.phase).toBe('planning')
    expect(inputLockMessage(v)).toBe('Orchestrator is planning…')

    v = applyAgentEvent(v, ev({ type: 'orchestrator_plan', steps }))
    v = applyAgentEvent(v, ev({ type: 'hitl_pause', agentId: 'orchestrator', role: 'O', serverName: 'multi-agent', toolName: 'approve_plan', args: {} }))
    expect(v.phase).toBe('preflight')
    expect(inputLockMessage(v)).toMatch(/approve or cancel/)

    v = applyAgentEvent(v, ev({ type: 'hitl_resume', agentId: 'orchestrator', approved: true }))
    v = applyAgentEvent(v, ev({ type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'w' }))
    expect(v.phase).toBe('running')
    expect(inputLockMessage(v)).toBe('Agents running…')

    v = applyAgentEvent(v, ev({ type: 'synthesis_start' }))
    v = applyAgentEvent(v, ev({ type: 'synthesis_token', token: 'Final ' }))
    v = applyAgentEvent(v, ev({ type: 'synthesis_token', token: '[1.1]' }))
    expect(v.phase).toBe('synthesizing')
    expect(v.synthesis).toBe('Final [1.1]')

    v = applyAgentEvent(v, ev({ type: 'task_complete', finalOutput: 'Final [1.1]', totalCostUsd: 0.02, totalTokens: 900 }))
    expect(v.phase).toBe('complete')
    expect(v.totals).toMatchObject({ costUsd: 0.02, tokens: 900 })
    expect(inputLockMessage(v)).toBeNull()
  })

  it('streams tokens, then a failed reflection resets the live text for the retry attempt', () => {
    seq = 0
    let v = reduceRunEvents('r', [
      ev({ type: 'orchestrator_plan', steps }),
      ev({ type: 'agent_start', agentId: '1.2', role: 'Analyzer', model: 'w' }),
      ev({ type: 'agent_token', agentId: '1.2', token: 'Analysis ' }),
      ev({ type: 'agent_token', agentId: '1.2', token: 'v1' }),
    ])
    expect(v.agents['1.2']).toMatchObject({ status: 'running', liveText: 'Analysis v1', streamedTokens: 2, attempt: 1 })
    v = applyAgentEvent(v, ev({ type: 'agent_complete', agentId: '1.2', output: 'Analysis v1', tokenCount: 150, costUsd: 0.001 }))
    v = applyAgentEvent(v, ev({ type: 'reflection_start', agentId: '1.2' }))
    expect(v.agents['1.2'].status).toBe('reflecting')
    v = applyAgentEvent(v, ev({ type: 'reflection_result', agentId: '1.2', score: 2, passed: false, reason: 'shallow' }))
    v = applyAgentEvent(v, ev({ type: 'retry', agentId: '1.2', attempt: 1, reason: 'shallow' }))
    expect(v.agents['1.2']).toMatchObject({ status: 'retrying', liveText: '', attempt: 2 })
    expect(v.agents['1.2'].output).toBeUndefined()
    expect(v.agents['1.2'].reflections).toEqual([{ attempt: 1, score: 2, passed: false, reason: 'shallow' }])
    v = applyAgentEvent(v, ev({ type: 'agent_token', agentId: '1.2', token: 'v2' }))
    expect(v.agents['1.2'].status).toBe('running')
  })

  it('tracks per-agent HITL pauses and names the waiting agent in the input bar', () => {
    seq = 0
    let v = reduceRunEvents('r', [
      ev({ type: 'orchestrator_plan', steps }),
      ev({ type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'w' }),
      ev({ type: 'hitl_pause', agentId: '1.1', role: 'Researcher', serverName: 'fs', toolName: 'read', args: {} }),
    ])
    expect(pausedAgents(v).map((a) => a.step.id)).toEqual(['1.1'])
    expect(inputLockMessage(v)).toBe('Researcher Agent needs your approval')
    v = applyAgentEvent(v, ev({ type: 'hitl_resume', agentId: '1.1', approved: true }))
    expect(v.agents['1.1'].status).toBe('running')
    expect(pausedAgents(v)).toEqual([])
  })

  it('agent_failed fails one agent; task_failed stops the rest and records the reason', () => {
    seq = 0
    let v = reduceRunEvents('r', [
      ev({ type: 'orchestrator_plan', steps }),
      ev({ type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'w' }),
      ev({ type: 'agent_start', agentId: '1.2', role: 'Analyzer', model: 'w' }),
      ev({ type: 'agent_failed', agentId: '1.1', reason: 'approval timed out' }),
    ])
    expect(v.agents['1.1']).toMatchObject({ status: 'failed', failure: 'approval timed out' })
    expect(v.phase).toBe('running')
    v = applyAgentEvent(v, ev({ type: 'task_failed', reason: 'Run aborted by user' }))
    expect(v.phase).toBe('failed')
    expect(v.failureReason).toBe('Run aborted by user')
    expect(v.agents['1.2'].status).toBe('cancelled')
    expect(v.agents['1.1'].status).toBe('failed')
  })

  it('ignores other runs, duplicates and stale sequence numbers; picks up runTotals', () => {
    seq = 0
    const v1 = applyAgentEvent(emptyRunView('r'), ev({ type: 'orchestrator_plan', steps, runTotals: { costUsd: 0.01, tokens: 10, budgetReached: true } }))
    expect(v1.totals.budgetReached).toBe(true)
    expect(applyAgentEvent(v1, { ...ev({ type: 'synthesis_start' }), runId: 'other' } as AgentEvent)).toBe(v1)
    expect(applyAgentEvent(v1, { ...ev({ type: 'synthesis_start' }), seq: 1 } as AgentEvent)).toBe(v1)
  })

  it('reduceRunEvents replays an out-of-order persisted trace in seq order', () => {
    seq = 0
    const events = [ev({ type: 'orchestrator_plan', steps }), ev({ type: 'agent_start', agentId: '1.1', role: 'R', model: 'w' })]
    expect(reduceRunEvents('r', [...events].reverse()).agents['1.1'].status).toBe('running')
  })
})

describe('linkProvenance', () => {
  it('links known agent markers only, leaving existing links and unknown markers alone', () => {
    const ids = new Set(['1.1', '1.2', '1.3b'])
    expect(linkProvenance('A [1.1], B [1.2] C [9.9] and [1.3b] [link](http://x) [1.1](#agent-1.1)', ids))
      .toBe('A [1.1](#agent-1.1), B [1.2](#agent-1.2) C [9.9] and [1.3b](#agent-1.3b) [link](http://x) [1.1](#agent-1.1)')
  })
})

describe('formatElapsed', () => {
  it('formats seconds and minutes', () => {
    expect(formatElapsed(9_400)).toBe('9s')
    expect(formatElapsed(125_000)).toBe('2m 05s')
  })
})

describe('per-agent timeline (refinement Phase 2)', () => {
  it('reduces reasoning, tool calls, output and gates into arrival-order items, separated by attempt', () => {
    seq = 0
    const v = reduceRunEvents('r', [
      ev({ type: 'orchestrator_plan', steps }),
      ev({ type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'w', attempt: 0 }),
      ev({ type: 'agent_reasoning', agentId: '1.1', attempt: 0, token: 'Check ' }),
      ev({ type: 'agent_reasoning', agentId: '1.1', attempt: 0, token: 'rail.' }),
      ev({ type: 'tool_start', agentId: '1.1', attempt: 0, callId: 'c1', tool: 'search', server: 'brave', argsPreview: '{"q":"rail"}' }),
      ev({ type: 'agent_token', agentId: '1.2', attempt: 0, token: 'other agent' }),
      ev({ type: 'tool_done', agentId: '1.1', attempt: 0, callId: 'c1', ok: true, durationMs: 1200, resultPreview: '8 results', resultChars: 900 }),
      ev({ type: 'agent_token', agentId: '1.1', attempt: 0, token: 'Hourly ' }),
      ev({ type: 'agent_token', agentId: '1.1', attempt: 0, token: 'trains.' }),
      ev({ type: 'agent_complete', agentId: '1.1', attempt: 0, output: 'Hourly trains.', tokenCount: 10, costUsd: 0 }),
      ev({ type: 'reflection_start', agentId: '1.1', attempt: 0 }),
      ev({ type: 'reflection_result', agentId: '1.1', attempt: 0, score: 2, passed: false, reason: 'unverified', model: 'judge/m', issues: ['Cite the timetable'] }),
      ev({ type: 'retry', agentId: '1.1', attempt: 1, reason: 'unverified' }),
      ev({ type: 'agent_reasoning', agentId: '1.1', attempt: 1, token: 'Retry.' }),
      ev({ type: 'agent_token', agentId: '1.1', attempt: 1, token: 'Hourly [verified].' }),
    ])
    expect(v.agents['1.1'].timeline).toEqual([
      { kind: 'reasoning', attempt: 0, text: 'Check rail.', startedAt: 3_000, endedAt: 4_000 },
      {
        kind: 'tool', attempt: 0, callId: 'c1', tool: 'search', server: 'brave', argsPreview: '{"q":"rail"}', startedAt: 5_000,
        done: { ok: true, durationMs: 1200, resultPreview: '8 results', resultChars: 900 },
      },
      { kind: 'output', attempt: 0, text: 'Hourly trains.' },
      { kind: 'gate', attempt: 0, score: 2, passed: false, reason: 'unverified', model: 'judge/m', issues: ['Cite the timetable'] },
      { kind: 'reasoning', attempt: 1, text: 'Retry.', startedAt: 14_000, endedAt: 14_000 },
      { kind: 'output', attempt: 1, text: 'Hourly [verified].' },
    ])
    expect(v.agents['1.2'].timeline).toEqual([{ kind: 'output', attempt: 0, text: 'other agent' }])
    // Reasoning never leaks into the live answer text.
    expect(v.agents['1.1'].liveText).toBe('Hourly [verified].')
  })

  it('replays a pre-Phase-2 trace (no attempt fields) with 0-based attempts inferred', () => {
    seq = 0
    const v = reduceRunEvents('r', [
      ev({ type: 'orchestrator_plan', steps }),
      ev({ type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'w' }),
      ev({ type: 'agent_token', agentId: '1.1', token: 'old' }),
      ev({ type: 'reflection_result', agentId: '1.1', score: 5, passed: true, reason: 'fine' }),
    ])
    expect(v.agents['1.1'].timeline).toEqual([
      { kind: 'output', attempt: 0, text: 'old' },
      { kind: 'gate', attempt: 0, score: 5, passed: true, reason: 'fine' },
    ])
  })
})

describe('run_config (refinement Phase 3)', () => {
  it('keeps the snapshot of what the run used', () => {
    seq = 0
    const config = {
      type: 'run_config', models: { orchestrator: 'o', worker: 'w', reflection: 'r', synthesizer: 's' },
      sources: { orchestrator: 'saved', worker: 'active', reflection: 'default', synthesizer: 'saved' }, catalogueChecked: true,
      maxAgents: 4, budgetCapUsd: 0.5, reflectionPassThreshold: 3, maxRetriesPerAgent: 2, reasoningEffort: 'medium',
    }
    const v = reduceRunEvents('r', [ev({ type: 'orchestrator_plan', steps }), ev(config)])
    expect(v.runConfig).toMatchObject(config)
  })
})
