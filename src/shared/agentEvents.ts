// ============================================================
// AgentEvent runtime validation
// SSE payloads arrive as untrusted JSON — validate before use.
// Hand-written, no new dependencies.
// ============================================================

import type { AgentEvent } from './types'

type Prim = 'string' | 'number' | 'boolean'

const KNOWN_TYPES = new Set<string>([
  'orchestrator_plan',
  'agent_start',
  'agent_token',
  'agent_complete',
  'reflection_start',
  'reflection_result',
  'retry',
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
    case 'orchestrator_plan':
      if (!Array.isArray(obj.steps)) return '"steps" must be an array'
      return null

    case 'agent_start':
      return checkFields(obj, [['agentId', 'string'], ['role', 'string'], ['model', 'string']])

    case 'agent_token':
      return checkFields(obj, [['agentId', 'string'], ['token', 'string']])

    case 'agent_complete':
      return checkFields(obj, [
        ['agentId',    'string'],
        ['output',     'string'],
        ['tokenCount', 'number'],
        ['costUsd',    'number'],
      ])

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

export function isAgentEvent(raw: unknown): raw is AgentEvent {
  if (typeof raw !== 'object' || raw === null) return false
  const obj = raw as Record<string, unknown>
  if (typeof obj.runId !== 'string') return false
  if (typeof obj.seq   !== 'number') return false
  if (typeof obj.ts    !== 'number') return false
  if (typeof obj.type  !== 'string' || !KNOWN_TYPES.has(obj.type)) return false
  return validateVariant(obj) === null
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
  const variantError = validateVariant(obj)
  if (variantError) throw new Error(`Invalid AgentEvent (type="${obj.type as string}"): ${variantError}`)
  return raw as AgentEvent
}
