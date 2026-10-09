// ============================================================
// AgentEvent runtime validation
// SSE payloads arrive as untrusted JSON — validate before use.
// Hand-written, no new dependencies.
// ============================================================

import type { AgentEvent } from './types'

type Prim = 'string' | 'number' | 'boolean'

const KNOWN_TYPES = new Set<string>([
  'orchestrator_plan',
  'run_config',
  'agent_start',
  'agent_token',
  'agent_reasoning',
  'tool_start',
  'tool_done',
  'agent_complete',
  'agent_failed',
  'reflection_start',
  'reflection_result',
  'retry',
  'context_compacted',
  'agent_degraded',
  'hitl_pause',
  'hitl_resume',
  'synthesis_start',
  'synthesis_token',
  'task_complete',
  'task_failed',
])

function checkPrim(obj: Record<string, unknown>, key: string, expected: Prim): string | null {
  if (typeof obj[key] !== expected) {
    return `"${key}" must be ${expected}, got ${typeof obj[key]}`
  }
  return null
}

function checkFields(obj: Record<string, unknown>, fields: Array<[string, Prim]>): string | null {
  for (const [key, type] of fields) {
    const err = checkPrim(obj, key, type)
    if (err) return err
  }
  return null
}

function validateVariant(obj: Record<string, unknown>): string | null {
  switch (obj.type as string) {
    case 'orchestrator_plan': {
      if (!Array.isArray(obj.steps)) return '"steps" must be an array'
      for (const [i, step] of (obj.steps as unknown[]).entries()) {
        if (typeof step !== 'object' || step === null) return `"steps[${i}]" must be an object`
        const err = checkFields(step as Record<string, unknown>, [
          ['id', 'string'], ['label', 'string'], ['stage', 'string'],
          ['role', 'string'], ['model', 'string'], ['phase', 'number'],
        ])
        if (err) return `"steps[${i}]": ${err}`
        const deps = (step as Record<string, unknown>).dependsOn
        if (deps !== undefined && !(Array.isArray(deps) && deps.every((d) => typeof d === 'string'))) {
          return `"steps[${i}].dependsOn" must be an array of strings`
        }
      }
      return null
    }

    case 'run_config': {
      for (const key of ['models', 'sources'] as const) {
        if (typeof obj[key] !== 'object' || obj[key] === null) return `"${key}" must be an object`
      }
      return checkFields(obj, [
        ['catalogueChecked', 'boolean'], ['maxAgents', 'number'], ['budgetCapUsd', 'number'],
        ['reflectionPassThreshold', 'number'], ['maxRetriesPerAgent', 'number'], ['reasoningEffort', 'string'],
      ])
    }

    case 'agent_start':
      return checkFields(obj, [['agentId', 'string'], ['role', 'string'], ['model', 'string']])

    case 'agent_token':
      return checkFields(obj, [['agentId', 'string'], ['token', 'string']])

    case 'agent_reasoning':
      return checkFields(obj, [['agentId', 'string'], ['attempt', 'number'], ['token', 'string']])

    case 'tool_start':
      return checkFields(obj, [
        ['agentId', 'string'], ['attempt', 'number'], ['callId', 'string'],
        ['tool', 'string'], ['server', 'string'], ['argsPreview', 'string'],
      ])

    case 'tool_done':
      return checkFields(obj, [
        ['agentId', 'string'], ['attempt', 'number'], ['callId', 'string'], ['ok', 'boolean'],
        ['durationMs', 'number'], ['resultPreview', 'string'], ['resultChars', 'number'],
      ])

    case 'agent_complete':
      return checkFields(obj, [
        ['agentId',    'string'],
        ['output',     'string'],
        ['tokenCount', 'number'],
        ['costUsd',    'number'],
      ])

    case 'agent_failed':
      return checkFields(obj, [['agentId', 'string'], ['reason', 'string']])

    case 'reflection_start':
      return checkFields(obj, [['agentId', 'string']])

    case 'reflection_result':
      return checkFields(obj, [
        ['agentId', 'string'],
        ['score',   'number'],
        ['passed',  'boolean'],
        ['reason',  'string'],
      ])

    case 'retry':
      return checkFields(obj, [
        ['agentId',  'string'],
        ['attempt',  'number'],
        ['reason',   'string'],
      ])

    case 'context_compacted':
      return checkFields(obj, [['agentId', 'string'], ['attempt', 'number'], ['stubbed', 'number'], ['tokensFreed', 'number']])

    case 'agent_degraded': {
      const err = checkFields(obj, [['agentId', 'string'], ['attempt', 'number'], ['score', 'number']])
      if (err) return err
      if (!Array.isArray(obj.issues) || !obj.issues.every((i) => typeof i === 'string')) return '"issues" must be an array of strings'
      if (typeof obj.claimStatuses !== 'object' || obj.claimStatuses === null || Array.isArray(obj.claimStatuses)) return '"claimStatuses" must be an object'
      return null
    }

    case 'hitl_pause': {
      const err = checkFields(obj, [
        ['agentId',    'string'],
        ['role',       'string'],
        ['toolName',   'string'],
        ['serverName', 'string'],
      ])
      if (err) return err
      if (typeof obj.args !== 'object' || obj.args === null || Array.isArray(obj.args)) {
        return '"args" must be a non-null object'
      }
      return null
    }

    case 'hitl_resume':
      return checkFields(obj, [['agentId', 'string'], ['approved', 'boolean']])

    case 'synthesis_start':
      return null

    case 'synthesis_token':
      return checkFields(obj, [['token', 'string']])

    case 'task_complete':
      return checkFields(obj, [
        ['finalOutput',  'string'],
        ['totalCostUsd', 'number'],
        ['totalTokens',  'number'],
      ])

    case 'task_failed':
      return checkFields(obj, [['reason', 'string']])

    default:
      return `unknown type "${obj.type as string}"`
  }
}

function validateRunTotals(obj: Record<string, unknown>): string | null {
  if (obj.runTotals === undefined) return null
  if (typeof obj.runTotals !== 'object' || obj.runTotals === null) return '"runTotals" must be an object'
  const err = checkFields(obj.runTotals as Record<string, unknown>, [
    ['costUsd', 'number'], ['tokens', 'number'], ['budgetReached', 'boolean'],
  ])
  return err ? `"runTotals": ${err}` : null
}

export function isAgentEvent(raw: unknown): raw is AgentEvent {
  if (typeof raw !== 'object' || raw === null) return false
  const obj = raw as Record<string, unknown>
  if (typeof obj.runId !== 'string') return false
  if (typeof obj.seq   !== 'number') return false
  if (typeof obj.ts    !== 'number') return false
  if (typeof obj.type  !== 'string' || !KNOWN_TYPES.has(obj.type)) return false
  return validateVariant(obj) === null && validateRunTotals(obj) === null
}

export function parseAgentEvent(raw: unknown): AgentEvent {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('AgentEvent must be a non-null object')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.runId !== 'string') throw new Error('"runId" must be a string')
  if (typeof obj.seq   !== 'number') throw new Error('"seq" must be a number')
  if (typeof obj.ts    !== 'number') throw new Error('"ts" must be a number')
  if (typeof obj.type  !== 'string') throw new Error('"type" must be a string')
  if (!KNOWN_TYPES.has(obj.type))   throw new Error(`Unknown AgentEvent type: "${obj.type}"`)
  const variantError = validateVariant(obj) ?? validateRunTotals(obj)
  if (variantError) throw new Error(`Invalid AgentEvent (type="${obj.type as string}"): ${variantError}`)
  return raw as AgentEvent
}

/** Run-level terminal events — a run emits exactly one, last. */
export function isTerminalAgentEvent(
  event: AgentEvent
): event is Extract<AgentEvent, { type: 'task_complete' | 'task_failed' }> {
  return event.type === 'task_complete' || event.type === 'task_failed'
}

/** Trace `stepType` (spec §08 Observability): which part of the run an event belongs to. */
export type AgentTraceStepType = 'orchestrator' | 'worker' | 'reflection' | 'synthesizer' | 'run'

export function agentEventStepType(event: AgentEvent): AgentTraceStepType {
  switch (event.type) {
    case 'orchestrator_plan':
    case 'run_config':
      return 'orchestrator'
    case 'reflection_start':
    case 'reflection_result':
      return 'reflection'
    case 'synthesis_start':
    case 'synthesis_token':
      return 'synthesizer'
    case 'task_complete':
    case 'task_failed':
      return 'run'
    case 'hitl_pause':
    case 'hitl_resume':
      return event.agentId === 'orchestrator' ? 'orchestrator' : 'worker'
    default:
      return 'worker'
  }
}
