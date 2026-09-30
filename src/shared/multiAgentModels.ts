// OpenRouter model catalogue filtering and pre-flight cost estimation for
// Multi-Agent mode (MULTI_AGENT_SPEC.html §06). Pure functions — shared by the
// renderer (settings dropdowns, pre-flight screen) and the main process.

import { DEFAULT_MULTI_AGENT_CONFIG } from './types'
import type { AgentStep, MultiAgentConfig } from './types'

export interface OpenRouterModelInfo {
  id: string
  name: string
  contextLength: number
  /** USD per token; null when OpenRouter publishes no price. */
  promptPrice: number | null
  completionPrice: number | null
  supportsTools: boolean
}

export interface CatalogueFilter {
  requireTools: boolean
  minContext: number
  /** Ascending price (prompt + completion); otherwise by id. */
  sortByPrice: boolean
}

export const DEFAULT_CATALOGUE_FILTER: CatalogueFilter = {
  requireTools: true,
  minContext: 32_000,
  sortByPrice: true,
}

const blendedPrice = (m: OpenRouterModelInfo): number =>
  (m.promptPrice ?? Number.POSITIVE_INFINITY) + (m.completionPrice ?? 0)

export function filterModelCatalogue(
  models: OpenRouterModelInfo[],
  filter: CatalogueFilter
): OpenRouterModelInfo[] {
  const kept = models.filter(
    (m) => (!filter.requireTools || m.supportsTools) && m.contextLength >= filter.minContext
  )
  return kept.sort((a, b) =>
    filter.sortByPrice ? blendedPrice(a) - blendedPrice(b) || a.id.localeCompare(b.id) : a.id.localeCompare(b.id)
  )
}

/** "$0.15 / $0.60 per 1M" — prompt / completion. */
export function formatPricePerMillion(m: OpenRouterModelInfo): string {
  if (m.promptPrice === null || m.completionPrice === null) return 'price n/a'
  const fmt = (perToken: number): string => {
    const perM = perToken * 1_000_000
    return perM === 0 ? '$0' : `$${perM < 1 ? perM.toFixed(3) : perM.toFixed(2)}`
  }
  return `${fmt(m.promptPrice)} / ${fmt(m.completionPrice)} per 1M`
}

// ── Pre-flight cost estimate ──────────────────────────────────────────────────
// Rough by design (spec §06: "token counts for tool calls are unknown
// pre-execution"). The range spans a best case (one attempt, no tool calls,
// short answers) and a worst case (every retry used, every tool round used,
// long answers, growing context). Mirrors the sidecar's limits.

export const ESTIMATE = {
  workerSystemTokens: 250,
  workerOutMin: 500,
  workerOutMax: 1_500,
  /** Must match MAX_TOOL_ROUNDS in multi_agent_sidecar.py. */
  toolRoundsMax: 6,
  toolCallOutTokens: 120,
  toolResultTokens: 800,
  reflectionPromptOverhead: 150,
  reflectionOut: 120,
  synthesisPromptOverhead: 250,
  synthesisOutMin: 400,
  synthesisOutMax: 1_500,
} as const

export interface ModelPricing {
  prompt: number
  completion: number
}

export interface CostEstimate {
  minUsd: number
  maxUsd: number
  /** Models with no published price — counted as $0, so the range is a lower bound. */
  unpricedModels: string[]
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export function estimateRunCost(input: {
  task: string
  steps: AgentStep[]
  config: MultiAgentConfig
  pricing: Record<string, ModelPricing | undefined>
}): CostEstimate {
  const { task, steps, config, pricing } = input
  const unpriced = new Set<string>()
  const cost = (model: string, promptTokens: number, completionTokens: number): number => {
    const p = pricing[model]
    if (!p) {
      if (model) unpriced.add(model)
      return 0
    }
    return promptTokens * p.prompt + completionTokens * p.completion
  }

  const taskTokens = estimateTokens(task)
  const phases = [...new Set(steps.map((s) => s.phase))].sort((a, b) => a - b)
  let min = 0
  let max = 0
  let priorOutMin = 0
  let priorOutMax = 0
  let allOutMin = 0
  let allOutMax = 0
  const attemptsMax = config.maxRetriesPerAgent + 1

  for (const phase of phases) {
    const phaseSteps = steps.filter((s) => s.phase === phase)
    for (const step of phaseSteps) {
      const base = ESTIMATE.workerSystemTokens + taskTokens + estimateTokens(step.label)

      // Best case: one attempt, one round, short answer, one reflection.
      min += cost(step.model, base + priorOutMin, ESTIMATE.workerOutMin)
      min += cost(
        config.models.reflection,
        ESTIMATE.reflectionPromptOverhead + taskTokens + ESTIMATE.workerOutMin,
        ESTIMATE.reflectionOut
      )

      // Worst case: every attempt runs every tool round with growing context.
      for (let attempt = 0; attempt < attemptsMax; attempt++) {
        for (let round = 0; round < ESTIMATE.toolRoundsMax; round++) {
          const prompt =
            base + priorOutMax + round * (ESTIMATE.toolCallOutTokens + ESTIMATE.toolResultTokens)
          const last = round === ESTIMATE.toolRoundsMax - 1
          max += cost(step.model, prompt, last ? ESTIMATE.workerOutMax : ESTIMATE.toolCallOutTokens)
        }
        max += cost(
          config.models.reflection,
          ESTIMATE.reflectionPromptOverhead + taskTokens + ESTIMATE.workerOutMax,
          ESTIMATE.reflectionOut
        )
      }
    }
    priorOutMin += phaseSteps.length * ESTIMATE.workerOutMin
    priorOutMax += phaseSteps.length * ESTIMATE.workerOutMax
    allOutMin = priorOutMin
    allOutMax = priorOutMax
  }

  min += cost(config.models.synthesizer, ESTIMATE.synthesisPromptOverhead + allOutMin, ESTIMATE.synthesisOutMin)
  max += cost(config.models.synthesizer, ESTIMATE.synthesisPromptOverhead + allOutMax, ESTIMATE.synthesisOutMax)

  return { minUsd: min, maxUsd: max, unpricedModels: [...unpriced].sort() }
}

/** "$0.04 – $0.18" with sensible precision for sub-cent values. */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

// ── Config validation ─────────────────────────────────────────────────────────

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/**
 * Merge a partial/untrusted config over the defaults and clamp every field to
 * the spec's ranges (§08 Settings): 1–8 agents, threshold 1–5, 0–5 retries,
 * a non-negative budget, and a HITL timeout between 10 s and 1 h.
 */
export function sanitizeMultiAgentConfig(input: Partial<MultiAgentConfig> | null | undefined): MultiAgentConfig {
  const d = DEFAULT_MULTI_AGENT_CONFIG
  const c = input ?? {}
  const model = (value: unknown, fallback: string): string => (typeof value === 'string' ? value.trim() : fallback)
  const budget = Number(c.budgetCapUsd)
  return {
    maxAgents: clampInt(c.maxAgents, 1, 8, d.maxAgents),
    budgetCapUsd: Number.isFinite(budget) && budget >= 0 ? budget : d.budgetCapUsd,
    models: {
      orchestrator: model(c.models?.orchestrator, d.models.orchestrator),
      worker: model(c.models?.worker, d.models.worker),
      reflection: model(c.models?.reflection, d.models.reflection),
      synthesizer: model(c.models?.synthesizer, d.models.synthesizer),
    },
    reflectionPassThreshold: clampInt(c.reflectionPassThreshold, 1, 5, d.reflectionPassThreshold),
    maxRetriesPerAgent: clampInt(c.maxRetriesPerAgent, 0, 5, d.maxRetriesPerAgent),
    hitlTimeoutMs: clampInt(c.hitlTimeoutMs, 10_000, 3_600_000, d.hitlTimeoutMs),
    requirePermissions: typeof c.requirePermissions === 'boolean' ? c.requirePermissions : d.requirePermissions,
  }
}
