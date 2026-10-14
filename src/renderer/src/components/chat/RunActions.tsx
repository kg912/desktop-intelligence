// Spec B 7d: what the pre-flight editor and the step controls can do for the run on screen. Layout provides it;
// without it (older callers, read-only reviews) the editor and controls are not shown.
import { createContext } from 'react'
import type { AgentStep } from '../../../../shared/types'
import type { CostEstimate } from '../../../../shared/multiAgentModels'

export interface RunActions {
  /** The run's models (role models, escalation, assess): what a step may run on. */
  models: string[]
  estimateFor: (steps: AgentStep[]) => CostEstimate | null
  steer: (agentId: string, message: string) => Promise<void>
  rerun: (stepId: string, options: { model?: string; withDependents?: boolean }) => Promise<boolean>
  lock: (stepId: string, locked: boolean) => Promise<void>
}

export const RunActionsContext = createContext<RunActions | null>(null)
