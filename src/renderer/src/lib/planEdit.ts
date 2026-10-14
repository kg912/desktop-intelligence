// Spec B 7d: the pre-flight plan editor's checks and edits (pure). The sidecar runs the planner's checks again on
// whatever is approved (approve_node → edited_plan).
import type { AgentStep } from '../../../shared/types'
import type { CostEstimate } from '../../../shared/multiAgentModels'

const usd = (n: number): string => `$${n.toFixed(2)}`

function cycleOf(steps: AgentStep[]): string[] | null {
  const by = new Map(steps.map((s) => [s.id, s]))
  const state = new Map<string, 'open' | 'done'>()
  const visit = (id: string, trail: string[]): string[] | null => {
    if (state.get(id) === 'done') return null
    if (state.get(id) === 'open') return [...trail.slice(trail.indexOf(id)), id]
    state.set(id, 'open')
    for (const d of by.get(id)?.dependsOn ?? []) {
      if (by.has(d)) {
        const found = visit(d, [...trail, id])
        if (found) return found
      }
    }
    state.set(id, 'done')
    return null
  }
  for (const s of steps) {
    const found = visit(s.id, [])
    if (found) return found
  }
  return null
}

/** Problems with an edited plan, in the order the editor shows them; [] when it can be approved. */
export function validatePlanEdit(steps: AgentStep[], limits: { maxAgents: number; budgetCapUsd: number }, estimate?: CostEstimate | null): string[] {
  const errors: string[] = []
  if (steps.some((s) => !s.id.trim() || !s.label.trim())) errors.push('Every step needs an id and a title.')
  if (steps.length > limits.maxAgents) errors.push(`${steps.length} steps: the maximum is ${limits.maxAgents}.`)
  const ids = new Set(steps.map((s) => s.id))
  for (const s of steps) {
    for (const d of s.dependsOn ?? []) if (!ids.has(d)) errors.push(`${s.id} depends on ${d}, which is not in the plan.`)
  }
  const cycle = cycleOf(steps)
  if (cycle) errors.push(`Dependency cycle: ${cycle.join(' → ')}.`)
  else {
    steps.forEach((s, i) => {
      for (const d of s.dependsOn ?? []) {
        const at = steps.findIndex((x) => x.id === d)
        if (at > i) errors.push(`${s.id} is listed before ${d}, which it depends on.`)
      }
    })
  }
  const budgets = steps.reduce((n, s) => n + (s.budgetUsd ?? 0), 0)
  if (budgets > limits.budgetCapUsd + 1e-9) errors.push(`Step budgets add up to ${usd(budgets)}, over the ${usd(limits.budgetCapUsd)} budget cap.`)
  else if (estimate && estimate.minUsd > limits.budgetCapUsd) errors.push(`Even the low estimate (${usd(estimate.minUsd)}) is over the ${usd(limits.budgetCapUsd)} budget cap.`)
  return errors
}

export function moveStep(steps: AgentStep[], from: number, to: number): AgentStep[] {
  const out = [...steps]
  const [moved] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, moved)
  return out
}

/** A new empty step at the end: the last phase's next free id ("1.5" after "1.4"). */
export function addStep(steps: AgentStep[], model: string): AgentStep[] {
  const last = steps.at(-1)?.id ?? '1.0'
  const [major] = last.split('.')
  let n = 1
  while (steps.some((s) => s.id === `${major}.${n}`)) n++
  return [...steps, { id: `${major}.${n}`, label: '', stage: 'worker', role: 'Researcher', model, phase: 1, dependsOn: [] }]
}

export function removeStep(steps: AgentStep[], id: string): AgentStep[] {
  return steps.filter((s) => s.id !== id).map((s) => ({ ...s, dependsOn: (s.dependsOn ?? []).filter((d) => d !== id) }))
}

/** Dependency depth of the deepest step (the "n phases" of the header). A cycle counts what it can. */
export function phasesOf(steps: AgentStep[]): number {
  const by = new Map(steps.map((s) => [s.id, s]))
  const memo = new Map<string, number>()
  const depth = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!
    if (seen.has(id)) return 1
    const deps = (by.get(id)?.dependsOn ?? []).filter((d) => by.has(d))
    const d = 1 + Math.max(0, ...deps.map((x) => depth(x, new Set([...seen, id]))))
    memo.set(id, d)
    return d
  }
  return Math.max(0, ...steps.map((s) => depth(s.id, new Set())))
}
