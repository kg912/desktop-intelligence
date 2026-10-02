/**
 * Browser-preview data for Settings → Debug → Multi-agent runs (observability spec §5).
 * Shape-only fixtures: in the app these come from the run log tree on disk.
 * `?obs=off` in the preview URL starts with observability off.
 */
import type { RunDetail, RunListRow, TimelineCall } from '../../../main/services/MultiAgentRunLogger'
import type { DebugPrefs, MultiAgentTraceLogEntry } from '../../../main/services/ObservabilityService'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import type { AgentEvent } from '../../../shared/types'

const MODELS = { orchestrator: 'meta-llama/llama-3.3-70b-instruct', worker: 'deepseek/deepseek-v4.1-flash', reflection: 'meta-llama/llama-3.3-70b-instruct', synthesizer: 'qwen/qwen3-235b-a22b-2507' }
const HOUR = 3_600_000
const now = Date.now()

let prefs: DebugPrefs = {
  observabilityEnabled: typeof location === 'undefined' || !location.search.includes('obs=off'),
  includeImages: false,
}

let runs: RunListRow[] = [
  { runId: '7f3c2a10-9b1e-4c55-a0d4-5e8f1c2be21a', chatId: 'chat-hotels', chatTitle: 'Compare castle hotels near Füssen', startedAt: now - 1 * HOUR, status: 'completed', models: MODELS, costUsd: 0.0412, durationMs: 48_200, anomalyCount: 2 },
  { runId: '2b9d0f44-1c3a-4e8b-9f21-77aa01c3d5e0', chatId: 'chat-board', chatTitle: 'Summarise the Q3 board pack', startedAt: now - 3 * HOUR, status: 'failed', models: MODELS, costUsd: 0.009, durationMs: 21_000, anomalyCount: 4 },
  { runId: 'c41e7b2d-5a60-4f19-8e3b-0d2f6a9c1b77', chatId: 'chat-trip', chatTitle: 'Trip plan: Munich to Salzburg', startedAt: now - 20 * HOUR, status: 'incomplete', models: MODELS, costUsd: null, durationMs: null, anomalyCount: null },
  { runId: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d', chatId: 'chat-tickets', chatTitle: 'Which castle tickets sell out first?', startedAt: now - 44 * HOUR, status: 'not_recorded', models: {}, costUsd: null, durationMs: null, anomalyCount: null },
]

const call = (seq: number, role: TimelineCall['role'], agentId: string | null, start: number, ms: number, extra: Partial<TimelineCall> = {}): TimelineCall => ({
  seq, kind: 'model', role, agentId, attempt: 0, label: role === 'synthesis' ? MODELS.synthesizer : role === 'worker' ? MODELS.worker : MODELS.orchestrator,
  start, ms, finish: 'stop', file: role === 'planner' ? 'planner.md' : role === 'synthesis' ? 'synthesis.md' : `agent-${agentId}.md`, anchor: `call-${seq}`, anomalous: false, ...extra,
})

const DETAIL: RunDetail = {
  meta: {
    schema: 1, runId: runs[0].runId, chatId: runs[0].chatId, chatTitle: runs[0].chatTitle, task: 'Compare castle hotels near Füssen',
    startedAt: runs[0].startedAt, endedAt: runs[0].startedAt + 48_200, status: 'completed', config: { ...DEFAULT_MULTI_AGENT_CONFIG, models: MODELS },
  },
  plan: [
    { id: '1.1', role: 'Scout', label: 'Find hotels within walking distance', dependsOn: [] },
    { id: '1.2', role: 'Analyst', label: 'Compare reviews', dependsOn: [] },
    { id: '1.3', role: 'Pricer', label: 'Collect prices for two nights', dependsOn: [] },
    { id: '2.1', role: 'Editor', label: 'Rank and summarise', dependsOn: ['1.1', '1.2', '1.3'] },
  ],
  calls: [
    call(1, 'planner', null, 0, 3_100),
    call(2, 'worker', '1.1', 3_400, 6_700, { finish: 'tool_calls' }),
    { ...call(3, 'worker', '1.1', 10_100, 2_600), kind: 'tool', label: 'tool builtin__brave_web_search', finish: 'ok' },
    call(4, 'worker', '1.1', 12_700, 5_600, { attempt: 0 }),
    call(5, 'worker', '1.2', 3_400, 10_600),
    call(6, 'worker', '1.3', 3_400, 12_500, { finish: 'length', anomalous: true }),
    call(7, 'reflection', '1.1', 18_400, 2_200),
    call(8, 'reflection', '1.2', 14_100, 2_400),
    call(9, 'reflection', '1.3', 16_000, 2_100),
    call(10, 'worker', '2.1', 20_700, 11_600),
    call(11, 'reflection', '2.1', 32_400, 2_300),
    call(12, 'synthesis', null, 34_900, 10_400),
  ],
  anomalies: [
    { kind: 'length', message: 'worker 1.3 attempt 0 stopped at its token limit (budget bound)', ref: 'agent-1.3.md#call-6' },
    { kind: 'served_model_differs', message: 'worker 1.3 attempt 0 requested `deepseek/deepseek-v4.1-flash`, OpenRouter served `deepseek/deepseek-v4-flash`', ref: 'agent-1.3.md#call-6' },
  ],
  peak: 3,
  files: ['run.md', 'agent-1.1.md', 'agent-1.2.md', 'agent-1.3.md', 'agent-2.1.md', 'planner.md', 'synthesis.md'],
}

const EVENTS: MultiAgentTraceLogEntry[] = Array.from({ length: 60 }, (_, i): MultiAgentTraceLogEntry => {
  const seq = 212 - i * 3
  const event = (i === 0
    ? { runId: DETAIL.meta.runId, seq, ts: now, type: 'task_complete', finalOutput: '…', totalCostUsd: 0.0412, totalTokens: 18_904 }
    : { runId: DETAIL.meta.runId, seq, ts: now, type: 'agent_token', agentId: `1.${(i % 3) + 1}`, attempt: 0, token: '…', runTotals: { costUsd: 0.0412 - i * 0.0006, tokens: 18_904 - i * 250, budgetReached: false } }) as AgentEvent
  return { chatId: DETAIL.meta.chatId, runId: DETAIL.meta.runId, ...('agentId' in event ? { agentId: event.agentId } : {}), stepType: i === 0 ? 'run' : 'worker', event, ...(event.runTotals ? { runCostUsd: event.runTotals.costUsd } : {}) }
})

export const observabilityMock = {
  obsGetPrefs: async (): Promise<DebugPrefs> => prefs,
  obsSetPrefs: async (patch: Partial<DebugPrefs>): Promise<void> => { prefs = { ...prefs, ...patch } },
  obsListSessions: async () => [],
  obsTotalSize: async () => 0,
  obsListMultiAgentRuns: async (): Promise<RunListRow[]> => runs,
  obsGetMultiAgentRun: async (_chatId: string, runId: string): Promise<RunDetail | null> =>
    runId === DETAIL.meta.runId ? DETAIL : null,
  obsListMultiAgentRunEvents: async (_chatId: string, runId: string, offset: number, limit: number) =>
    runId === DETAIL.meta.runId ? { total: EVENTS.length, entries: EVENTS.slice(offset, offset + limit) } : { total: 0, entries: [] },
  obsOpenMultiAgentRunFile: async (): Promise<string> => '',
  obsRevealMultiAgentRun: async (): Promise<void> => {},
  obsDeleteMultiAgentRun: async (_chatId: string, runId: string): Promise<boolean> => {
    runs = runs.filter((r) => r.runId !== runId)
    return true
  },
}
