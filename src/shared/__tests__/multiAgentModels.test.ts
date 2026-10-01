import { describe, it, expect } from 'vitest'
import {
  estimateRunCost,
  filterModelCatalogue,
  formatPricePerMillion,
  formatUsd,
  sanitizeMultiAgentConfig,
  type OpenRouterModelInfo,
} from '../multiAgentModels'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../types'
import type { AgentStep, MultiAgentConfig } from '../types'

const m = (id: string, over: Partial<OpenRouterModelInfo> = {}): OpenRouterModelInfo => ({
  id, name: id, contextLength: 128_000, promptPrice: 1e-6, completionPrice: 2e-6, supportsTools: true, ...over,
})

describe('filterModelCatalogue (spec §06 filters)', () => {
  const models = [
    m('b/cheap', { promptPrice: 1e-7, completionPrice: 1e-7 }),
    m('a/pricey', { promptPrice: 1e-5, completionPrice: 3e-5 }),
    m('c/no-tools', { supportsTools: false }),
    m('d/short', { contextLength: 8_000 }),
    m('e/unpriced', { promptPrice: null, completionPrice: null }),
  ]

  it('keeps tool-capable, long-enough models sorted by ascending price, unpriced last', () => {
    expect(filterModelCatalogue(models, { requireTools: true, minContext: 32_000, sortByPrice: true }).map((x) => x.id))
      .toEqual(['b/cheap', 'a/pricey', 'e/unpriced'])
  })

  it('can relax every filter and sort alphabetically', () => {
    expect(filterModelCatalogue(models, { requireTools: false, minContext: 0, sortByPrice: false }).map((x) => x.id))
      .toEqual(['a/pricey', 'b/cheap', 'c/no-tools', 'd/short', 'e/unpriced'])
  })
})

describe('formatting', () => {
  it('shows per-1M prompt / completion prices', () => {
    expect(formatPricePerMillion(m('x', { promptPrice: 1.5e-7, completionPrice: 6e-7 }))).toBe('$0.150 / $0.600 per 1M')
    expect(formatPricePerMillion(m('x', { promptPrice: 3e-6, completionPrice: 1.5e-5 }))).toBe('$3.00 / $15.00 per 1M')
    expect(formatPricePerMillion(m('x', { promptPrice: 0, completionPrice: 0 }))).toBe('$0 / $0 per 1M')
    expect(formatPricePerMillion(m('x', { promptPrice: null }))).toBe('price n/a')
  })
  it('formats USD with sub-cent precision', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatUsd(0.184)).toBe('$0.18')
  })
})

describe('estimateRunCost (pre-flight range)', () => {
  const steps: AgentStep[] = [
    { id: '1.1', label: 'Research', stage: 'worker', role: 'Researcher', model: 'w', phase: 1 },
    { id: '1.2', label: 'Analyze', stage: 'worker', role: 'Analyzer', model: 'w', phase: 1 },
    { id: '2.1', label: 'Review', stage: 'worker', role: 'Reviewer', model: 'w', phase: 2 },
  ]
  const config: MultiAgentConfig = { ...DEFAULT_MULTI_AGENT_CONFIG, models: { orchestrator: 'o', worker: 'w', reflection: 'r', synthesizer: 's' } }
  const pricing = { w: { prompt: 1e-6, completion: 4e-6 }, r: { prompt: 1e-7, completion: 1e-7 }, s: { prompt: 2e-6, completion: 8e-6 } }

  it('returns a positive range with worst case above best case', () => {
    const est = estimateRunCost({ task: 'Analyze the repo', steps, config, pricing })
    expect(est.minUsd).toBeGreaterThan(0)
    expect(est.maxUsd).toBeGreaterThan(est.minUsd * 5)
    expect(est.unpricedModels).toEqual([])
  })

  it('grows with retries and agents', () => {
    const base = estimateRunCost({ task: 't', steps, config, pricing })
    const moreRetries = estimateRunCost({ task: 't', steps, config: { ...config, maxRetriesPerAgent: 4 }, pricing })
    const fewerAgents = estimateRunCost({ task: 't', steps: steps.slice(0, 1), config, pricing })
    expect(moreRetries.maxUsd).toBeGreaterThan(base.maxUsd)
    expect(moreRetries.minUsd).toBe(base.minUsd)
    expect(fewerAgents.maxUsd).toBeLessThan(base.maxUsd)
  })

  it('sizes a dependant\'s prompt from its dependencies only; pre-graph steps keep the phase rule', () => {
    const legacy = estimateRunCost({ task: 't', steps, config, pricing })
    const sameAsLegacy = estimateRunCost({ task: 't', steps: steps.map((s) => ({ ...s, dependsOn: s.phase === 2 ? ['1.1', '1.2'] : [] })), config, pricing })
    const narrower = estimateRunCost({ task: 't', steps: steps.map((s) => ({ ...s, dependsOn: s.phase === 2 ? ['1.1'] : [] })), config, pricing })
    expect(sameAsLegacy).toEqual(legacy)
    expect(narrower.minUsd).toBeLessThan(legacy.minUsd)
    expect(narrower.maxUsd).toBeLessThan(legacy.maxUsd)
  })

  it('lists models without a price instead of silently pricing them', () => {
    const est = estimateRunCost({ task: 't', steps, config, pricing: { w: pricing.w } })
    expect(est.unpricedModels).toEqual(['r', 's'])
  })
})

describe('sanitizeMultiAgentConfig', () => {
  it('fills defaults for missing input', () => {
    expect(sanitizeMultiAgentConfig(undefined)).toEqual(DEFAULT_MULTI_AGENT_CONFIG)
  })
  it('clamps every numeric field to the spec ranges', () => {
    const c = sanitizeMultiAgentConfig({
      maxAgents: 99, budgetCapUsd: -1, reflectionPassThreshold: 0, maxRetriesPerAgent: 12, hitlTimeoutMs: 5,
    } as Partial<MultiAgentConfig>)
    expect(c).toMatchObject({ maxAgents: 8, budgetCapUsd: 0.5, reflectionPassThreshold: 1, maxRetriesPerAgent: 5, hitlTimeoutMs: 10_000 })
  })
  it('accepts the four reasoning efforts and falls back to medium otherwise', () => {
    for (const effort of ['off', 'low', 'medium', 'high'] as const) expect(sanitizeMultiAgentConfig({ reasoningEffort: effort }).reasoningEffort).toBe(effort)
    expect(sanitizeMultiAgentConfig({ reasoningEffort: 'max' as never }).reasoningEffort).toBe('medium')
  })

  it('rejects garbage types and trims model ids', () => {
    const c = sanitizeMultiAgentConfig({
      maxAgents: 'lots' as unknown as number, requirePermissions: 'yes' as unknown as boolean,
      models: { orchestrator: '  x/y  ', worker: 42 as unknown as string, reflection: '', synthesizer: 's' },
    })
    expect(c.maxAgents).toBe(4)
    expect(c.requirePermissions).toBe(true)
    expect(c.models).toEqual({ orchestrator: 'x/y', worker: '', reflection: '', synthesizer: 's' })
  })
})
