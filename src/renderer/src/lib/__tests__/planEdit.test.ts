// Spec B 7d: pre-flight plan edits are checked before they are sent (the sidecar checks again): a missing dependency,
// a cycle, an order that runs a step before what it needs, too many steps, and a plan over the budget cap.
import { describe, it, expect } from 'vitest'
import { addStep, moveStep, removeStep, validatePlanEdit, phasesOf } from '../planEdit'
import type { AgentStep } from '../../../../shared/types'

const step = (id: string, dependsOn: string[] = [], extra: Partial<AgentStep> = {}): AgentStep =>
  ({ id, label: `Step ${id}`, stage: 'worker', role: 'R', model: 'm/w', phase: 1, dependsOn, ...extra })
const PLAN = [step('1.1'), step('1.2'), step('1.3', ['1.2'], { condition: 'only if 1.2 > 5 h' }), step('1.4')]
const LIMITS = { maxAgents: 6, budgetCapUsd: 1 }

describe('validatePlanEdit', () => {
  it('a valid plan has no errors', () => {
    expect(validatePlanEdit(PLAN, LIMITS)).toEqual([])
  })

  it('a dependency on a step that is not in the plan', () => {
    expect(validatePlanEdit([...PLAN, step('2.1', ['9.9'])], LIMITS)).toEqual(['2.1 depends on 9.9, which is not in the plan.'])
  })

  it('a cycle', () => {
    expect(validatePlanEdit([step('1.1', ['1.2']), step('1.2', ['1.1'])], LIMITS)).toContain('Dependency cycle: 1.1 → 1.2 → 1.1.')
  })

  it('an order that lists a step before a step it depends on', () => {
    expect(validatePlanEdit([step('1.3', ['1.2']), step('1.2')], LIMITS)).toEqual(['1.3 is listed before 1.2, which it depends on.'])
  })

  it('over budget: the step budgets, or the estimate, above the cap; too many steps', () => {
    const budgets = PLAN.map((s, i) => ({ ...s, budgetUsd: i < 3 ? 0.3 : 0.2 }))
    expect(validatePlanEdit(budgets, LIMITS)).toEqual(['Step budgets add up to $1.10, over the $1.00 budget cap.'])
    expect(validatePlanEdit(PLAN, LIMITS, { minUsd: 1.2, maxUsd: 3, unpricedModels: [] })).toEqual(['Even the low estimate ($1.20) is over the $1.00 budget cap.'])
    expect(validatePlanEdit(PLAN, { ...LIMITS, maxAgents: 3 })).toEqual(['4 steps: the maximum is 3.'])
    expect(validatePlanEdit([...PLAN.slice(0, 3), step('', [])], LIMITS)).toEqual(['Every step needs an id and a title.'])
  })
})

describe('editing', () => {
  it('moveStep reorders; a drop that breaks the order is then flagged (and the editor keeps the old order)', () => {
    const moved = moveStep(PLAN, 2, 0)
    expect(moved.map((s) => s.id)).toEqual(['1.3', '1.1', '1.2', '1.4'])
    expect(validatePlanEdit(moved, LIMITS)).toEqual(['1.3 is listed before 1.2, which it depends on.'])
  })

  it('addStep gets the next free id of the last phase; removeStep also drops it from dependencies', () => {
    const added = addStep(PLAN, 'm/w')
    expect(added.at(-1)).toMatchObject({ id: '1.5', label: '', role: 'Researcher', model: 'm/w', dependsOn: [] })
    expect(removeStep(PLAN, '1.2').map((s) => [s.id, s.dependsOn])).toEqual([['1.1', []], ['1.3', []], ['1.4', []]])
  })

  it('phasesOf counts dependency depth for the header', () => {
    expect(phasesOf(PLAN)).toBe(2)
    expect(phasesOf([step('1.1')])).toBe(1)
  })
})
