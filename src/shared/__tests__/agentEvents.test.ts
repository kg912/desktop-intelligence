import { describe, it, expect } from 'vitest'
import { isAgentEvent, parseAgentEvent } from '../agentEvents'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../types'

// ── Fixtures — one well-formed example per variant ───────────────────────────

const BASE = { runId: 'run-1', seq: 0, ts: 1700000000000 }

const VALID_EVENTS = {
  orchestrator_plan: {
    ...BASE,
    type: 'orchestrator_plan',
    steps: [{ id: '1.1', label: 'Research', stage: 'worker', role: 'researcher', model: 'openai/gpt-4o', phase: 1 }],
  },
  agent_start: {
    ...BASE,
    type: 'agent_start',
    agentId: 'a1',
    role: 'researcher',
    model: 'openai/gpt-4o',
  },
  agent_token: {
    ...BASE,
    type: 'agent_token',
    agentId: 'a1',
    token: 'Hello',
  },
  agent_complete: {
    ...BASE,
    type: 'agent_complete',
    agentId: 'a1',
    output: 'Done.',
    tokenCount: 42,
    costUsd: 0.001,
  },
  reflection_start: {
    ...BASE,
    type: 'reflection_start',
    agentId: 'a1',
  },
  reflection_result: {
    ...BASE,
    type: 'reflection_result',
    agentId: 'a1',
    score: 4,
    passed: true,
    reason: 'Meets quality bar',
  },
  retry: {
    ...BASE,
    type: 'retry',
    agentId: 'a1',
    attempt: 1,
    reason: 'Score too low',
  },
  hitl_pause: {
    ...BASE,
    type: 'hitl_pause',
    agentId: 'a1',
    role: 'worker',
    toolName: 'read_file',
    serverName: 'filesystem',
    args: { path: '/tmp/foo.txt' },
  },
  hitl_resume: {
    ...BASE,
    type: 'hitl_resume',
    agentId: 'a1',
    approved: true,
  },
  synthesis_start: {
    ...BASE,
    type: 'synthesis_start',
  },
  synthesis_token: {
    ...BASE,
    type: 'synthesis_token',
    token: 'Summary',
  },
  task_complete: {
    ...BASE,
    type: 'task_complete',
    finalOutput: 'All done.',
    totalCostUsd: 0.05,
    totalTokens: 1000,
  },
  task_failed: {
    ...BASE,
    type: 'task_failed',
    reason: 'Max retries exceeded',
  },
} as const

// ── Accept: all 13 variants ───────────────────────────────────────────────────

describe('isAgentEvent — accepts all 13 variants', () => {
  for (const [variant, event] of Object.entries(VALID_EVENTS)) {
    it(`accepts ${variant}`, () => {
      expect(isAgentEvent(event)).toBe(true)
    })
  }
})

describe('parseAgentEvent — accepts all 13 variants', () => {
  for (const [variant, event] of Object.entries(VALID_EVENTS)) {
    it(`parses ${variant} and returns the event object`, () => {
      expect(parseAgentEvent(event)).toBe(event)
    })
  }
})

// ── Reject: unknown type ──────────────────────────────────────────────────────

describe('rejects unknown type', () => {
  const unknown = { ...BASE, type: 'sandbox_exec' }
  it('isAgentEvent returns false', () => expect(isAgentEvent(unknown)).toBe(false))
  it('parseAgentEvent throws with type name', () => {
    expect(() => parseAgentEvent(unknown)).toThrow('sandbox_exec')
  })
})

// ── Reject: missing base fields ───────────────────────────────────────────────

describe('rejects missing base fields on agent_start', () => {
  it('missing runId', () => {
    const bad = { seq: 0, ts: 1, type: 'agent_start', agentId: 'a', role: 'r', model: 'm' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"runId"')
  })

  it('missing seq', () => {
    const bad = { runId: 'r', ts: 1, type: 'agent_start', agentId: 'a', role: 'r', model: 'm' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"seq"')
  })

  it('missing ts', () => {
    const bad = { runId: 'r', seq: 0, type: 'agent_start', agentId: 'a', role: 'r', model: 'm' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"ts"')
  })
})

// ── Reject: missing variant-specific required fields ─────────────────────────

describe('rejects missing variant fields', () => {
  it('orchestrator_plan missing steps', () => {
    const bad = { ...BASE, type: 'orchestrator_plan' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"steps"')
  })

  it('agent_complete missing tokenCount', () => {
    const bad = { ...BASE, type: 'agent_complete', agentId: 'a1', output: 'x', costUsd: 0.01 }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"tokenCount"')
  })

  it('reflection_result missing reason', () => {
    const bad = { ...BASE, type: 'reflection_result', agentId: 'a1', score: 3, passed: true }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"reason"')
  })

  it('hitl_pause missing serverName', () => {
    const bad = { ...BASE, type: 'hitl_pause', agentId: 'a1', role: 'worker', toolName: 'x', args: {} }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"serverName"')
  })

  it('hitl_pause args is array (not plain object)', () => {
    const bad = { ...BASE, type: 'hitl_pause', agentId: 'a1', role: 'worker', toolName: 'x', serverName: 's', args: [] }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"args"')
  })

  it('task_complete missing totalCostUsd', () => {
    const bad = { ...BASE, type: 'task_complete', finalOutput: 'x', totalTokens: 10 }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"totalCostUsd"')
  })

  it('task_failed missing reason', () => {
    const bad = { ...BASE, type: 'task_failed' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"reason"')
  })
})

// ── Reject: wrong primitive types on variant fields ───────────────────────────

describe('rejects wrong primitive types', () => {
  it('reflection_result: score as string', () => {
    const bad = { ...BASE, type: 'reflection_result', agentId: 'a1', score: '4', passed: true, reason: 'ok' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"score" must be number')
  })

  it('reflection_result: passed as number', () => {
    const bad = { ...BASE, type: 'reflection_result', agentId: 'a1', score: 4, passed: 1, reason: 'ok' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"passed" must be boolean')
  })

  it('hitl_resume: approved as string', () => {
    const bad = { ...BASE, type: 'hitl_resume', agentId: 'a1', approved: 'yes' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"approved" must be boolean')
  })

  it('agent_complete: costUsd as string', () => {
    const bad = { ...BASE, type: 'agent_complete', agentId: 'a1', output: 'x', tokenCount: 1, costUsd: '0.01' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"costUsd" must be number')
  })

  it('task_complete: totalTokens as boolean', () => {
    const bad = { ...BASE, type: 'task_complete', finalOutput: 'x', totalCostUsd: 0.1, totalTokens: true }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"totalTokens" must be number')
  })
})

// ── Reject: wrong primitive types on base fields ──────────────────────────────

describe('validates base field types on a representative event', () => {
  it('runId as number', () => {
    const bad = { runId: 42, seq: 0, ts: 1, type: 'synthesis_start' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"runId"')
  })

  it('seq as string', () => {
    const bad = { runId: 'r', seq: '0', ts: 1, type: 'synthesis_start' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"seq"')
  })

  it('ts as boolean', () => {
    const bad = { runId: 'r', seq: 0, ts: true, type: 'synthesis_start' }
    expect(isAgentEvent(bad)).toBe(false)
    expect(() => parseAgentEvent(bad)).toThrow('"ts"')
  })
})

// ── Reject: non-object input ──────────────────────────────────────────────────

describe('rejects non-object input', () => {
  it('null', () => {
    expect(isAgentEvent(null)).toBe(false)
    expect(() => parseAgentEvent(null)).toThrow()
  })

  it('string', () => {
    expect(isAgentEvent('{"type":"agent_start"}')).toBe(false)
    expect(() => parseAgentEvent('{"type":"agent_start"}')).toThrow()
  })

  it('number', () => {
    expect(isAgentEvent(42)).toBe(false)
    expect(() => parseAgentEvent(42)).toThrow()
  })
})

// ── DEFAULT_MULTI_AGENT_CONFIG exact defaults ─────────────────────────────────

describe('DEFAULT_MULTI_AGENT_CONFIG', () => {
  it('maxAgents is 4', () => expect(DEFAULT_MULTI_AGENT_CONFIG.maxAgents).toBe(4))
  it('budgetCapUsd is 0.5', () => expect(DEFAULT_MULTI_AGENT_CONFIG.budgetCapUsd).toBe(0.5))
  it('reflectionPassThreshold is 3', () => expect(DEFAULT_MULTI_AGENT_CONFIG.reflectionPassThreshold).toBe(3))
  it('maxRetriesPerAgent is 2', () => expect(DEFAULT_MULTI_AGENT_CONFIG.maxRetriesPerAgent).toBe(2))
  it('hitlTimeoutMs is 300000', () => expect(DEFAULT_MULTI_AGENT_CONFIG.hitlTimeoutMs).toBe(300000))
  it('models.orchestrator is empty string', () => expect(DEFAULT_MULTI_AGENT_CONFIG.models.orchestrator).toBe(''))
  it('models.worker is empty string', () => expect(DEFAULT_MULTI_AGENT_CONFIG.models.worker).toBe(''))
  it('models.reflection is empty string', () => expect(DEFAULT_MULTI_AGENT_CONFIG.models.reflection).toBe(''))
  it('models.synthesizer is empty string', () => expect(DEFAULT_MULTI_AGENT_CONFIG.models.synthesizer).toBe(''))
})

// ── task_failed: optional partialOutputs ─────────────────────────────────────

describe('task_failed with optional partialOutputs', () => {
  it('accepts task_failed without partialOutputs', () => {
    expect(isAgentEvent(VALID_EVENTS.task_failed)).toBe(true)
  })

  it('accepts task_failed with partialOutputs object', () => {
    const withPartial = { ...VALID_EVENTS.task_failed, partialOutputs: { 'a1': 'partial result' } }
    expect(isAgentEvent(withPartial)).toBe(true)
    const parsed = parseAgentEvent(withPartial)
    expect(parsed).toBe(withPartial)
  })
})
