/**
 * Prints a multi-agent run's baseline summary (spec multi-agent-reliability-and-cost.md Phase 0)
 * and writes it to <run dir>/baseline.json. A bare name resolves under the fixture runs folder.
 *   npm run baseline -- fixtures/istanbul-3leg
 */
import { existsSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { readRun, summariseRun } from '../src/main/services/MultiAgentRunLogger'

const FIXTURE_RUNS = resolve(__dirname, '../resources/python/tests/fixtures/runs')

async function main(): Promise<number> {
  const arg = process.argv[2]
  if (!arg) {
    console.error('usage: npm run baseline -- <run dir | fixtures/<name>>')
    return 2
  }
  const dir = existsSync(join(arg, 'run.meta.json')) ? resolve(arg) : join(FIXTURE_RUNS, basename(arg))
  const s = summariseRun(await readRun(dir))
  const usd = (n: number): string => `$${n.toFixed(4)}`
  const pct = (n: number): string => `${Math.round(100 * n)}%`
  const rows: Array<[string, string]> = [
    ['Total cost', usd(s.costUsd)],
    ...(['planner', 'worker', 'judge', 'synthesizer'] as const).map((r): [string, string] =>
      [`  ${r}`, `${usd(s.costByRole[r])} (${pct(s.costByRole[r] / s.costUsd)}, ${s.calls[r]} calls)`]),
    ['Wall time', s.wallMs == null ? '—' : `${(s.wallMs / 1000).toFixed(1)} s`],
    ['Critical path', s.criticalPath.join(' → ')],
    ...Object.entries(s.agents).map(([id, a]): [string, string] =>
      [`  agent ${id}`, `${a.attempts} attempt(s), ${usd(a.costUsd)}, ends at ${(a.endMs / 1000).toFixed(1)} s${a.cacheHitRate == null ? '' : `, cache hit ${pct(a.cacheHitRate)}`}`]),
    ['Agent cost mean / p90', `${usd(s.meanAgentCostUsd)} / ${usd(s.p90AgentCostUsd)}`],
    ['Retries', `${s.retries} (worker retry cost ${usd(s.retryCostUsd)}, ${pct(s.retryCostUsd / s.costUsd)})`],
    ['Attempt-0 claims failing', `${s.claims.attempt0.failing}; classes ${JSON.stringify(s.claims.attempt0.byFailureClass)}`],
    ['Attempt-0 claims gate passed', `${s.claims.attempt0.agentsPassed.length}/${s.claims.attempt0.agents} (${s.claims.attempt0.agentsPassed.join(', ') || 'none'})`],
    ['Prompt tokens (all / workers)', `${s.promptTokens} / ${s.workerPromptTokens}`],
    ['Unique tool text tokens', `${s.uniqueToolTokens}`],
    ['Worker prompt amplification', `${s.amplification.toFixed(2)}x`],
    ['Cached tokens', s.cachedTokens == null ? 'not logged' : `${s.cachedTokens}`],
    ['Judge input tokens', `${s.judge.inputTokens} (${s.judge.inputTokensPerCall.join(', ')})`],
    ['Judge reasoning share of output', pct(s.judge.reasoningTokens / Math.max(1, s.judge.outputTokens))],
    ['Tool results', `${s.toolResults.count}, median ${(s.toolResults.medianChars / 1000).toFixed(1)} KB`],
    ['Approval wait (pause→resume)', `${(s.approvals.waitMs / 1000).toFixed(1)} s over ${s.approvals.count}; longest ${(s.approvals.maxWaitMs / 1000).toFixed(1)} s (${s.approvals.maxWaitAgent ?? '—'}); plan ${(s.approvals.planWaitMs / 1000).toFixed(1)} s`],
  ]
  const width = Math.max(...rows.map(([k]) => k.length))
  for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${v}`)
  writeFileSync(join(dir, 'baseline.json'), JSON.stringify(s, null, 2) + '\n')
  console.log(`\nwrote ${join(dir, 'baseline.json')}`)
  return 0
}

main().then((code) => process.exit(code))
