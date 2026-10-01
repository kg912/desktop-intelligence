/**
 * Browser-preview stand-in for a multi-agent run (no sidecar, no OpenRouter):
 * a scripted itinerary run that exercises the dock end to end — plan approval,
 * three parallel agents with reasoning and tool calls, one tool approval, a
 * dependent fourth agent whose first gate fails, and a streamed synthesis.
 */
import type {
  AgentEvent, AgentStep, BackendSettings, McpToolPermissionRequest, MultiAgentRunRecord, RunTotals, StartRunResult,
} from '../../../shared/types'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'

type Listener<T> = (value: T) => void
const listeners = { events: [] as Listener<AgentEvent>[], permissions: [] as Listener<McpToolPermissionRequest>[] }
const subscribe = <T,>(list: Listener<T>[], fn: Listener<T>) => {
  list.push(fn)
  return () => { list.splice(list.indexOf(fn), 1) }
}

const WORKER = 'deepseek/deepseek-v4.1-flash'
const STEPS: AgentStep[] = [
  { id: '1.1', label: 'Research destinations', stage: 'worker', role: 'GeoAgent', model: WORKER, phase: 1, dependsOn: [] },
  { id: '1.2', label: 'Research rail and bus links', stage: 'worker', role: 'TransAgent', model: WORKER, phase: 1, dependsOn: [] },
  { id: '1.3', label: 'Find lodging by base town', stage: 'worker', role: 'StayAgent', model: WORKER, phase: 1, dependsOn: [] },
  { id: '2.1', label: 'Draft day-by-day itinerary', stage: 'worker', role: 'ItinAgent', model: WORKER, phase: 2, dependsOn: ['1.1', '1.2', '1.3'] },
]

const traces = new Map<string, AgentEvent[]>()
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function multiAgentDemoApi(saveAnswer: (chatId: string, text: string) => Promise<void>) {
  let planAnswer: ((approved: boolean) => void) | null = null
  const toolAnswers = new Map<string, (approved: boolean) => void>()
  let aborted = false
  let currentRunId = ''

  async function run(runId: string, chatId: string): Promise<void> {
    const started = Date.now()
    const trace: AgentEvent[] = []
    traces.set(chatId, trace)
    const totals: RunTotals = { costUsd: 0, tokens: 0, budgetReached: false }
    let seq = 0
    const emit = (type: string, body: Record<string, unknown> = {}): void => {
      if (aborted && type !== 'task_failed') return
      const event = { runId, seq: ++seq, ts: Date.now(), elapsedMs: Date.now() - started, type, ...body, ...(totals.tokens && { runTotals: { ...totals } }) } as AgentEvent
      trace.push(event)
      listeners.events.forEach((l) => l(event))
    }
    const spend = (tokens: number): void => {
      totals.tokens += tokens
      totals.costUsd = Math.round((totals.costUsd + tokens * 9e-7) * 1e6) / 1e6
    }
    const stream = async (type: 'agent_token' | 'agent_reasoning', agentId: string, text: string, ms: number, attempt = 0) => {
      const parts = text.match(/.{1,6}/gs) ?? []
      for (const token of parts) {
        emit(type, { agentId, attempt, token })
        spend(2)
        await wait(ms / parts.length)
      }
    }
    const tool = async (agentId: string, callId: string, name: string, args: string, chars: number, ms: number, attempt = 0) => {
      emit('tool_start', { agentId, attempt, callId, tool: name, server: 'brave', argsPreview: args })
      await wait(ms)
      emit('tool_done', { agentId, attempt, callId, ok: true, durationMs: ms, resultPreview: `${name} results for ${args}`, resultChars: chars })
    }
    const gate = async (agentId: string, score: number, reason: string, attempt = 0, issues: string[] = []) => {
      emit('reflection_start', { agentId, attempt })
      await wait(400)
      emit('reflection_result', {
        agentId, attempt, score, passed: score >= 3, reason, issues, model: DEFAULT_MULTI_AGENT_CONFIG.models.reflection,
        rubric: ['Answers the subtask it was given', 'Claims are backed by tool evidence or explicitly marked as unverified'],
      })
    }
    const outputs: Record<string, string> = {}
    const finish = async (agentId: string, text: string, ms: number, score: number, reason: string) => {
      await stream('agent_token', agentId, text, ms)
      outputs[agentId] = text
      emit('agent_complete', { agentId, attempt: 0, output: text, tokenCount: 4_000 + text.length * 9, costUsd: 0.004 })
      await gate(agentId, score, reason)
    }

    await wait(300)
    emit('orchestrator_plan', { steps: STEPS })
    emit('run_config', {
      models: { ...DEFAULT_MULTI_AGENT_CONFIG.models, worker: WORKER },
      sources: { orchestrator: 'default', worker: 'active', reflection: 'default', synthesizer: 'default' },
      catalogueChecked: true, maxAgents: 4, budgetCapUsd: 0.65, reflectionPassThreshold: 3, maxRetriesPerAgent: 2, reasoningEffort: 'medium',
    })
    emit('hitl_pause', { agentId: 'orchestrator', role: 'Orchestrator', model: DEFAULT_MULTI_AGENT_CONFIG.models.orchestrator, toolName: 'approve_plan', serverName: 'multi-agent', args: { steps: STEPS } })
    const approved = await new Promise<boolean>((r) => { planAnswer = r })
    emit('hitl_resume', { agentId: 'orchestrator', approved })
    if (!approved) return emit('task_failed', { reason: 'Plan not approved', partialOutputs: {} })

    const geo = (async () => {
      emit('agent_start', { agentId: '1.1', role: 'GeoAgent', model: WORKER, attempt: 0 })
      await stream('agent_reasoning', '1.1', 'Group the Alps by rail access: Salzburg and Innsbruck are hubs; Füssen hangs off Reutte; Hallstatt needs a train plus the ferry.', 1200)
      await tool('1.1', 'g1', 'brave_web_search', '"Hallstatt winter ferry Hallstatt Markt timetable"', 6_100, 800)
      await finish('1.1', 'Base towns ranked by rail access: **Salzburg**, **Innsbruck**, Füssen (via Reutte), Hallstatt by train + ferry. Each is under 2h from the next.', 1400, 5, 'Covers every cluster and cites rail access for each.')
    })()
    const trans = (async () => {
      await wait(80)
      emit('agent_start', { agentId: '1.2', role: 'TransAgent', model: WORKER, attempt: 0 })
      await stream('agent_reasoning', '1.2', 'Salzburg to Innsbruck is the long leg. The direct Railjet takes about two hours, so a base change on Dec 15 works. I should confirm Christmas Eve service before suggesting a late return to Vienna…', 1800)
      await tool('1.2', 't1', 'brave_web_search', '"ÖBB Salzburg Innsbruck Railjet 24 December timetable"', 3_900, 1200)
      await tool('1.2', 't2', 'fetch', 'oebb.at/en/…/christmas-eve-service', 4_200, 900)
      await finish('1.2', 'Vienna → Salzburg Hbf runs every 30 minutes on the Railjet, about 2h22. Salzburg → Innsbruck takes 1h50 via Kufstein. On 24 December the last Railjet back to Vienna leaves Innsbruck at 17:14 [verified on oebb.at].', 9000, 4, 'Timetables backed by the ÖBB page; bus links marked unverified.')
    })()
    const stay = (async () => {
      await wait(160)
      emit('agent_start', { agentId: '1.3', role: 'StayAgent', model: WORKER, attempt: 0 })
      await stream('agent_reasoning', '1.3', 'Small towns book out before Christmas. Search family-run places near each station first.', 900)
      emit('tool_start', { agentId: '1.3', attempt: 0, callId: 's1', tool: 'web_search', server: 'brave', argsPreview: '{"q":"family-run hotels Füssen near Hbf"}' })
      emit('hitl_pause', { agentId: '1.3', role: 'StayAgent', model: WORKER, toolName: 'web_search', serverName: 'brave', args: { q: 'family-run hotels Füssen near Hbf' }, attempt: 0 })
      const request: McpToolPermissionRequest = {
        serverName: 'brave', toolName: 'brave__web_search', args: { q: 'family-run hotels Füssen near Hbf' }, requestId: 'demo-q1', chatId,
        agent: { runId, agentId: '1.3', role: 'StayAgent', model: WORKER }, timeoutMs: 300_000,
      }
      listeners.permissions.forEach((l) => l(request))
      const ok = await new Promise<boolean>((r) => toolAnswers.set('demo-q1', r))
      emit('hitl_resume', { agentId: '1.3', approved: ok, attempt: 0 })
      emit('tool_done', { agentId: '1.3', attempt: 0, callId: 's1', ok, durationMs: 300, resultPreview: ok ? '8 results' : 'Tool request denied', resultChars: ok ? 5_300 : 19 })
      await finish('1.3', 'Füssen: Hotel Sonne (family-run, 4 min from Hbf). Salzburg: Hotel Stein. Innsbruck: Weisses Kreuz. Book Füssen early, since the town is small.', 1500, 4, 'Specific, near stations, prices marked unverified.')
    })()
    await Promise.all([geo, trans, stay])

    emit('agent_start', { agentId: '2.1', role: 'ItinAgent', model: WORKER, attempt: 0 })
    await stream('agent_reasoning', '2.1', 'Twelve days, four bases. Put Hallstatt mid-trip and keep Dec 24 short.', 700)
    await stream('agent_token', '2.1', 'Day 7: Hallstatt and Füssen.', 500)
    emit('agent_complete', { agentId: '2.1', attempt: 0, output: 'Day 7: Hallstatt and Füssen.', tokenCount: 2_100, costUsd: 0.002 })
    await gate('2.1', 2, 'Day 7 puts Hallstatt and Füssen on the same day, 5h apart by rail.', 0, ['Give Hallstatt its own day', 'Move Füssen to the Innsbruck leg'])
    emit('retry', { agentId: '2.1', attempt: 1, reason: 'Day 7 puts Hallstatt and Füssen on the same day' })
    await stream('agent_reasoning', '2.1', 'Split Hallstatt into its own day and move Füssen to the Innsbruck leg…', 700, 1)
    const itinerary = 'Days 1–2 Vienna [1.1]. Days 3–5 Salzburg with a Hallstatt day trip [1.2]. Days 6–9 Innsbruck with Füssen [1.3]. Days 10–12 back via Salzburg, home on the 17:14 Railjet on 24 December [1.2].'
    await stream('agent_token', '2.1', itinerary, 1500, 1)
    outputs['2.1'] = itinerary
    emit('agent_complete', { agentId: '2.1', attempt: 1, output: itinerary, tokenCount: 5_400, costUsd: 0.005 })
    await gate('2.1', 4, 'Feasible legs; every transfer cites 1.2.', 1)

    emit('synthesis_start')
    const final = 'Fly into Vienna and spend two nights there [1.1], then take the Railjet to Salzburg [1.2]. Book Füssen lodging early, since the town is small [1.3]. The full day-by-day plan follows [2.1]:\n\n' + itinerary
    for (const token of final.match(/.{1,8}/gs) ?? []) {
      emit('synthesis_token', { token })
      await wait(25)
    }
    await saveAnswer(chatId, final)
    emit('task_complete', { finalOutput: final, totalCostUsd: totals.costUsd, totalTokens: totals.tokens })
  }

  return {
    getBackendSettings: async (): Promise<BackendSettings> => ({
      provider: 'openrouter', nvidiaApiKey: '', nvidiaModel: '', ollamaApiKey: '', ollamaModel: '', ollamaBaseUrl: '',
      openrouterApiKey: 'demo', openrouterModel: WORKER, mtplxBaseUrl: '', mtplxModel: '',
    }),
    getMultiAgentSidecarStatus: async () => 'running' as const,
    onMultiAgentEvent: (cb: Listener<AgentEvent>) => subscribe(listeners.events, cb),
    onMcpToolPermissionRequest: (cb: Listener<McpToolPermissionRequest>) => subscribe(listeners.permissions, cb),
    startMultiAgentRun: async ({ chatId }: { chatId: string }): Promise<StartRunResult> => {
      const runId = `demo-${Date.now()}`
      currentRunId = runId
      aborted = false
      void run(runId, chatId)
      return { ok: true, runId, config: { ...DEFAULT_MULTI_AGENT_CONFIG, budgetCapUsd: 0.65, models: { ...DEFAULT_MULTI_AGENT_CONFIG.models, worker: WORKER } } }
    },
    respondMultiAgentPlan: async (_runId: string, approved: boolean) => planAnswer?.(approved),
    mcpRespondToPermission: async (response: { requestId: string; approved: boolean }) => toolAnswers.get(response.requestId)?.(response.approved),
    abortMultiAgentRun: async () => {
      aborted = true
      listeners.events.forEach((l) => l({ runId: currentRunId, seq: 1e9, ts: Date.now(), type: 'task_failed', reason: 'Run aborted by user' } as AgentEvent))
    },
    getMultiAgentRun: async (chatId: string): Promise<MultiAgentRunRecord | null> => {
      const trace = traces.get(chatId)
      return trace ? { mode: 'multi-agent', runStatus: 'completed', agentGraph: STEPS, executionTrace: [...trace] } : null
    },
  }
}
