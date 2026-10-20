/// <reference types="vite/client" />
// Dev-only page for the browser preview (npx vite --config vite.preview.config.ts → http://localhost:5174/gallery.html#d11 … #d14, #settings, #topbar): spec B's UI surfaces
// with the Istanbul fixture's data, to compare against specs/designs/11–14. Not part of the app build.
import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../styles/globals.css'
import type { AgentEvent, EvidenceRecord } from '../../../shared/types'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import { reduceRunEvents } from '../lib/multiAgentRunState'
import { ClaimsDrawer } from '../components/chat/ClaimsDrawer'
import type { ClaimTarget } from '../components/chat/ClaimsDrawer'
import { ClaimLinksContext } from '../components/chat/ClaimLinks'
import { FinalSynthesis } from '../components/chat/MultiAgentSidebarView'
import { AssessCard, CoverageMatrixView, RunTimeline } from '../components/chat/CoveragePanel'
import { GanttView } from '../components/chat/GanttView'
import { PlanEditor } from '../components/chat/PlanEditor'
import { StepControls } from '../components/chat/StepControls'
import { RunActionsContext } from '../components/chat/RunActions'
import { MultiAgentSettingsPanel } from '../components/settings/MultiAgentSettingsPanel'
import { TopBar } from '../components/layout/TopBar'
import { ModelStoreProvider } from '../store/ModelStore'
import LEDGER from '../lib/__tests__/fixtures/istanbul-ledger.json'
import EVENTS_JSONL from '../../../../resources/python/tests/fixtures/runs/istanbul-3leg/events.jsonl?raw'

let seq = 0
const ev = (e: Record<string, unknown>) => ({ runId: 'r', seq: ++seq, ts: 1_000 * seq, ...e }) as unknown as AgentEvent
const RULES = { checklist: { open: 6, total: 18 }, waves: { used: 1, max: 2 }, budget: { spentUsd: 0.63, capUsd: 1 }, progress: 'first', tools: 'partly' }
const config = { ...DEFAULT_MULTI_AGENT_CONFIG, budgetCapUsd: 1, maxAgents: 6, models: { ...DEFAULT_MULTI_AGENT_CONFIG.models, worker: 'deepseek/deepseek-v4.1-flash' } }
const frame: React.CSSProperties = { width: 1440, height: 880, padding: 28, boxSizing: 'border-box', display: 'flex', gap: 20, color: '#e8e8e8' }

const PAGE = '[S17.3] Kayseri (ASR) to İzmir (ADB)\nhttps://example-airline.com/kayseri-izmir\n…schedules change by season. Flights from Kayseri to İzmir operate on Tuesday, Thursday and Saturday in the summer timetable. Check the exact date at booking…'
const EVIDENCE: Record<string, EvidenceRecord> = { call_17: { agentId: '1.2', callId: 'call_17', name: 'brave_search', args: '{}', ok: true, result: PAGE, snippets: { 'S17.3': PAGE.slice(8) } } }
;(window as any).api = new Proxy({
  getMultiAgentEvidence: async (_r: string, _a: string, callId: string) => EVIDENCE[callId] ?? null,
  getMultiAgentConfig: async () => ({ ...config, sidecarPort: 7823 }),
  getMultiAgentSidecarStatus: async () => 'running',
  getMultiAgentCatalogue: async () => ({ error: null, models: [] }),
  getBackendSettings: async () => ({ openrouterModel: 'deepseek/deepseek-v4.1-flash' }),
}, { get: (t, k) => (k in t ? (t as any)[k] : typeof k === 'string' && k.startsWith('on') ? () => () => {} : async () => undefined) })

function D11() {
  const step = (id: string, role: string) => ({ id, label: role, stage: 'worker', role, model: 'm', phase: 1, dependsOn: [] })
  const view = reduceRunEvents('r', [
    ev({ type: 'orchestrator_plan', steps: [step('1.2', 'Flights'), step('1.3', 'Baggage'), step('1.4', 'Transfers'), step('1.5', 'Fallback'), step('2.1', 'Second source')], checklist: [{ id: 'r1', text: 'Days', scope: '1.2' }, { id: 'r2', text: 'Taxi', scope: '1.4' }] }),
    ev({ type: 'reflection_result', agentId: '1.2', attempt: 0, score: 3, passed: false, reason: 'x', claims: [] }),
    ev({ type: 'reflection_result', agentId: '1.2', attempt: 1, score: 3, passed: false, reason: 'x', claims: [] }),
    ev({ type: 'reflection_result', agentId: '1.2', attempt: 2, score: 3, passed: true, reason: 'ok', claimStatuses: { c1: 'verified', c2: 'verified', c3: 'verified', c5: 'unverified_declared' },
      claims: [{ id: 'c1', claim: 'ASR–IST has 8+ daily flights on three carriers.', snippets: ['S2.1'], callId: 'call_2', quote: '8 daily flights' },
        { id: 'c2', claim: 'Typical ASR–IST flight time is 1 h 25 min.', snippets: ['S2.2'], callId: 'call_2', quote: '1 h 25 min' },
        { id: 'c3', claim: 'Direct Kayseri–İzmir flights operate Tuesdays, Thursdays and Saturdays.', snippets: ['S17.3'], callId: 'call_17', quote: 'Flights from Kayseri to İzmir operate on Tuesday, Thursday and Saturday' },
        { id: 'c5', claim: 'Exact departure times for the chosen date.', unverified: true }] }),
    ev({ type: 'reflection_result', agentId: '1.3', score: 5, passed: true, reason: 'ok', claimStatuses: { c2: 'verified', c5: 'unverified_declared' }, claims: [{ id: 'c2', claim: 'Budget fare checked bag 15 kg', snippets: ['S1.1'] }, { id: 'c5', claim: 'Bag fee on the Kayseri leg', unverified: true }] }),
    ev({ type: 'reflection_result', agentId: '1.4', score: 5, passed: true, reason: 'ok', claimStatuses: { c1: 'verified', c3: 'verified' }, claims: [{ id: 'c1', claim: 'Shuttle about 75 minutes', snippets: ['S1.1'] }, { id: 'c3', claim: 'Taxi 1,400–2,100 TRY', snippets: ['S1.2'] }] }),
    ev({ type: 'reflection_result', agentId: '1.5', score: 5, passed: true, reason: 'ok', claimStatuses: { c1: 'verified' }, claims: [{ id: 'c1', claim: 'Overnight bus fallback', snippets: ['S1.1'] }] }),
    ev({ type: 'reflection_result', agentId: '2.1', score: 5, passed: true, reason: 'ok', claimStatuses: { c4: 'verified', c9: 'verified' }, claims: [{ id: 'c4', claim: 'No scheduled direct flight between ASR and ADB on the selected week.', snippets: ['S9.1'], callId: 'call_9' }, { id: 'c9', claim: 'Taxi 900 TRY', snippets: ['S9.2'] }] }),
    ev({ type: 'ledger_update', ledger: { r1: { status: 'conflicted', claimIds: ['1.2 c3', '2.1 c4'], conflict: { claimIds: ['1.2 c3', '2.1 c4'], confirmed: true } }, r2: { status: 'conflicted', claimIds: ['1.4 c3', '2.1 c9'], conflict: { claimIds: ['1.4 c3', '2.1 c9'], confirmed: true } } }, counts: { verified: 0, unverified: 0, conflicted: 2, missing: 0, pending: 0 } }),
    ev({ type: 'synthesis_start' }),
    ev({ type: 'synthesis_token', token: '**Leg 2 · Kayseri → İzmir.** Direct flights are listed on Tuesdays, Thursdays and Saturdays [1.2] [1.2 c3], but a second source shows no direct service in the same window [2.1]. Treat as **unconfirmed** until the date is checked on the airline site.\n\nChecked baggage on the budget fare is 15 kg [1.3 c2]; a bag fee applies on the Kayseri leg [1.3 c5].\n\nAirport to Göreme by shuttle takes about 75 minutes [1.4 c1]. Taxi estimates range from 1,400 to 2,100 TRY [1.4 c3].\n\nIf leg 2 exceeds 5 h door to door, take the overnight bus instead [1.5 c1].' }),
  ])
  const [target, setTarget] = useState<ClaimTarget | null>({ agentId: '1.2', ref: '1.2 c3' })
  return (
    <ClaimLinksContext.Provider value={{ view, open: setTarget }}>
      <div style={frame}><div style={{ flex: 1, maxWidth: 820 }}><FinalSynthesis view={view} onSelectAgent={() => {}} onOpenClaim={setTarget} /></div></div>
      {target && <ClaimsDrawer view={view} target={target} onSelect={setTarget} onClose={() => setTarget(null)} />}
    </ClaimLinksContext.Provider>
  )
}

function D12() {
  const steps = [{ id: '2.1', label: 'Settle ASR–ADB direct service for the target week from airline schedule pages.', stage: 'worker', role: 'Follow-up', model: 'm', phase: 2, dependsOn: ['1.2', '1.5'], covers: ['days-2'], wave: 2 },
    { id: '2.2', label: 'If no direct flight: price the overnight bus fallback.', stage: 'worker', role: 'Follow-up', model: 'm', phase: 3, dependsOn: ['2.1'], covers: ['bag-1'], condition: 'only if 2.1 finds no direct flight', wave: 2 }]
  const view = reduceRunEvents('r', [ev({ type: 'orchestrator_plan', steps: LEDGER.steps, checklist: LEDGER.checklist }), ev({ type: 'ledger_update', ledger: LEDGER.ledger, counts: LEDGER.counts }),
    ev({ type: 'assess_start', wave: 1, open: 6 }),
    ev({ type: 'assess_decision', wave: 1, decision: 'follow_up', reason: 'Two conflicts can be closed with the available tools. Exact-date times cannot.', steps,
      unclosable: [{ checklistId: 'times-2', reason: 'no available tool can close this gap (needs fetch)' }], costUsd: 0.004, durationMs: 2100, model: 'google/gemini-3.8-flash-lite', rules: RULES, estimatedUsd: 0.4, autoRun: false }),
    ev({ type: 'hitl_pause', agentId: 'assess', role: 'Assess', model: 'm', toolName: 'approve_followup', serverName: 'multi-agent', args: {} })])
  return (
    <ClaimLinksContext.Provider value={{ view, open: () => {} }}>
      <div style={frame}>
        <div style={{ flex: 1 }}><CoverageMatrixView view={view} /></div>
        <div style={{ width: 520, display: 'flex', flexDirection: 'column', gap: 16 }}><AssessCard view={view} config={config} readOnly={false} onAssess={() => {}} /><RunTimeline view={view} /></div>
      </div>
    </ClaimLinksContext.Provider>
  )
}

function D13() {
  const events = EVENTS_JSONL.split('\n').filter(Boolean).map((l: string) => JSON.parse(l) as AgentEvent)
  const view = reduceRunEvents(events[0].runId, events)
  return <div style={{ ...frame, height: 820 }}><div style={{ flex: 1 }}><GanttView view={view} /></div></div>
}

function D14() {
  const step = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, label, stage: 'worker', role: 'Leg', model: 'deepseek/deepseek-v4.1-flash', phase: 1, dependsOn: [], budgetUsd: 0.05, ...extra })
  const plan = [step('1.1', 'Leg 1 · Istanbul → Nevşehir: airlines, days, times, baggage'), step('1.2', 'Leg 2 · Kayseri → İzmir: settle direct flight'),
    step('1.3', 'Leg 2 fallback: overnight bus', { dependsOn: ['1.2'], condition: 'only if 1.2 > 5 h', budgetUsd: 0.04 }), step('1.4', 'Leg 3 · İzmir → Istanbul'), step('1.5', 'Transfers and baggage across all legs')]
  const view = reduceRunEvents('r', [ev({ type: 'orchestrator_plan', steps: plan }), ev({ type: 'plan_step_removed', stepId: '2.1', label: 'Merge findings', reason: 'merge' })])
  const running = reduceRunEvents('r', [ev({ type: 'orchestrator_plan', steps: plan }), ev({ type: 'hitl_resume', agentId: 'orchestrator', approved: true }),
    ev({ type: 'agent_start', agentId: '1.2', role: 'Leg', model: 'm' }), ...[1, 2, 3].map((n) => ev({ type: 'tool_start', agentId: '1.2', attempt: 0, callId: `c${n}`, tool: 'brave_search', server: 'builtin', argsPreview: '' }))])
  const finishedEvents = [ev({ type: 'orchestrator_plan', steps: plan }), ev({ type: 'agent_start', agentId: '1.4', role: 'Leg', model: 'm' }),
    ev({ type: 'agent_complete', agentId: '1.4', output: 'x', tokenCount: 1, costUsd: 0.04 }), ev({ type: 'reflection_result', agentId: '1.4', score: 4, passed: true, reason: 'ok' }),
    ev({ type: 'task_complete', finalOutput: 'a', totalCostUsd: 0.3, totalTokens: 1 })]
  const finished = reduceRunEvents('r', finishedEvents)
  const actions = { models: ['deepseek/deepseek-v4.1-flash', 'anthropic/claude-sonnet-5-5'], estimateFor: (s: unknown[]) => ({ minUsd: 0.06 * s.length, maxUsd: 0.09 * s.length, unpricedModels: [] }),
    steer: async () => {}, rerun: async () => ({ ok: true as const }), rerunUnavailable: null }
  return (
    <RunActionsContext.Provider value={actions}>
      <div style={frame}>
        <div style={{ flex: 1 }}><PlanEditor view={view} config={config} onApprove={() => {}} onCancel={() => {}} /></div>
        <div style={{ width: 540, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <StepControls view={running} agentId="1.2" />
          <StepControls view={finished} agentId="1.4" />
          {/* An old trace whose finished step 1.4 was locked (rectification R3: no lock UI, re-run disabled with a reason). */}
          <StepControls view={reduceRunEvents('r', [...finishedEvents, ev({ type: 'step_locked', agentId: '1.4', locked: true })])} agentId="1.4" />
          <RunActionsContext.Provider value={{ ...actions, rerunUnavailable: 'Re-run is only available for the latest run of this chat' }}>
            <StepControls view={finished} agentId="1.4" />
          </RunActionsContext.Provider>
        </div>
      </div>
    </RunActionsContext.Provider>
  )
}

function Settings() {
  return <div style={{ ...frame, height: 'auto', display: 'block', background: '#0f0f0f' }}><MultiAgentSettingsPanel /></div>
}

/** Rectification R2: the multi-agent top bar at a given chat-column width (?w=1100&collapsed=1&live=1). */
function TopBarAt() {
  const q = new URLSearchParams(location.search)
  const [view, setView] = useState<'list' | 'graph' | 'gantt'>('gantt')
  const events = EVENTS_JSONL.split('\n').filter(Boolean).map((l: string) => JSON.parse(l) as AgentEvent)
  const live = q.get('live') === '1'
  const cut = live ? events.slice(0, events.findIndex((e) => e.type === 'agent_complete')) : events
  const run = { view: reduceRunEvents(events[0].runId, cut), runIds: [events[0].runId], live }
  return (
    <ModelStoreProvider>
      <div data-testid="topbar-frame" style={{ width: Number(q.get('w') ?? 1100), background: '#000' }}>
        <TopBar activeChatId="c" onCompactComplete={() => {}} sidebarCollapsed={q.get('collapsed') === '1'} onSidebarToggle={() => {}}
          chatSystemInstructions={null} onUpdateChatSystemInstructions={() => {}} mode="multi-agent" agentRun={run} agentDockOpen
          agentViewMode={view} onAgentViewMode={setView} />
      </div>
    </ModelStoreProvider>
  )
}

const SECTIONS: Record<string, () => React.ReactElement> = { d11: D11, d12: D12, d13: D13, d14: D14, settings: Settings, topbar: TopBarAt }
const Section = SECTIONS[location.hash.slice(1)] ?? D11
ReactDOM.createRoot(document.getElementById('root')!).render(<Section />)
