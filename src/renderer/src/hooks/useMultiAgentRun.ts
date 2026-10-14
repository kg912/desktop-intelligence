import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import type { AgentEvent, MultiAgentConfig } from '../../../shared/types'
import { isTerminalAgentEvent } from '../../../shared/agentEvents'
import type { ModelPricing } from '../../../shared/multiAgentModels'
import { applyAgentEvent, emptyRunView, isRunActive, reduceRunEvents } from '../lib/multiAgentRunState'
import type { RunView } from '../lib/multiAgentRunState'

export interface ActiveRun {
  chatId: string
  task: string
  view: RunView
  /** A persisted run opened for review — read-only, no controls. */
  review: boolean
  /** Config the run was started with (for the pre-flight estimate). */
  config: MultiAgentConfig
  /** Every run of this chat, oldest first (absent until the chat has run history). */
  runIds?: string[]
  /** Live runs only: false = started with observability off, so this run has no log. */
  recorded?: boolean
}

/** Run id of the placeholder shown between send and the sidecar's reply (the planning view, never an empty pane). */
export const PENDING_RUN_PREFIX = 'pending:'

/** Events for a run id the renderer has not learned yet (IPC reply vs first stream event race). */
const MAX_EARLY_EVENTS = 500

export function useMultiAgentRun(onRunFinished: (chatId: string) => void) {
  const [run, setRun] = useState<ActiveRun | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [pricing, setPricing] = useState<Record<string, ModelPricing>>({})
  const queue = useRef<AgentEvent[]>([])
  const early = useRef<AgentEvent[]>([])
  const frame = useRef<number | null>(null)
  const runRef = useRef<ActiveRun | null>(null)
  const finishedRef = useRef(onRunFinished)
  finishedRef.current = onRunFinished
  runRef.current = run

  // Batch per animation frame: one React update per frame, not per token.
  const flush = useCallback(() => {
    frame.current = null
    const batch = queue.current
    queue.current = []
    const current = runRef.current
    if (!current) {
      early.current = [...early.current, ...batch].slice(-MAX_EARLY_EVENTS)
      return
    }
    const mine = batch.filter((e) => e.runId === current.view.runId)
    const others = batch.filter((e) => e.runId !== current.view.runId)
    if (others.length) early.current = [...early.current, ...others].slice(-MAX_EARLY_EVENTS)
    if (!mine.length) return
    const view = mine.reduce(applyAgentEvent, current.view)
    const next = { ...current, view }
    runRef.current = next
    setRun(next)
    if (mine.some(isTerminalAgentEvent)) finishedRef.current(current.chatId)
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onMultiAgentEvent((event) => {
      queue.current.push(event)
      if (frame.current === null) frame.current = requestAnimationFrame(flush)
    })
    return () => {
      unsubscribe()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [flush])

  const start = useCallback(async (chatId: string, task: string): Promise<boolean> => {
    setStartError(null)
    // Planning starts now from the user's point of view: show it while the sidecar starts the run.
    const provisional: ActiveRun = { chatId, task, view: emptyRunView(`${PENDING_RUN_PREFIX}${Date.now()}`), review: false, config: DEFAULT_MULTI_AGENT_CONFIG }
    runRef.current = provisional
    setRun(provisional)
    // Settings may have changed since mount — always start with the saved config.
    const config: MultiAgentConfig = await window.api
      .getMultiAgentConfig()
      .catch(() => DEFAULT_MULTI_AGENT_CONFIG)
    window.api
      .getMultiAgentCatalogue()
      .then(({ models }) => {
        const map: Record<string, ModelPricing> = {}
        for (const m of models) {
          if (m.promptPrice !== null && m.completionPrice !== null) map[m.id] = { prompt: m.promptPrice, completion: m.completionPrice }
        }
        setPricing(map)
      })
      .catch(() => { /* estimate falls back to "price unknown" */ })

    const started = await window.api.startMultiAgentRun({ chatId, task, config }).catch((err: unknown) =>
      ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }))
    if (!started.ok) {
      if (runRef.current === provisional) {
        runRef.current = null
        setRun(null)
      }
      setStartError(started.reason)
      return false
    }
    const buffered = early.current.filter((e) => e.runId === started.runId)
    early.current = early.current.filter((e) => e.runId !== started.runId)
    const view = buffered.reduce(applyAgentEvent, emptyRunView(started.runId, provisional.view.startedAt))
    const next: ActiveRun = { chatId, task, view, review: false, config: started.config ?? config, runIds: started.runIds, recorded: started.recorded }
    runRef.current = next
    setRun(next)
    if (buffered.some(isTerminalAgentEvent)) finishedRef.current(chatId)
    return true
  }, [])

  /** Open a saved run read-only — the chat's latest, or `runId` (an earlier one). */
  const review = useCallback(async (chatId: string, task = '', runId?: string): Promise<boolean> => {
    // A live run is never replaced by a saved one; its events would be lost.
    const current = runRef.current
    if (current && !current.review && isRunActive(current.view)) return false
    const record = await window.api.getMultiAgentRun(chatId, runId).catch(() => null)
    if (!record || record.mode !== 'multi-agent' || record.executionTrace.length === 0) return false
    const next: ActiveRun = {
      chatId, task: record.task ?? task, review: true, config: DEFAULT_MULTI_AGENT_CONFIG,
      view: reduceRunEvents(record.executionTrace[0].runId, record.executionTrace),
      runIds: record.runIds,
    }
    runRef.current = next
    setRun(next)
    return true
  }, [])

  /** Spec B Phase 5: resume an interrupted run, or re-run one step of a finished one (`rerun`). The saved run goes live
   *  (its trace stays; new events apply on top). A refusal leaves it open read-only with the reason. */
  const continueRun = useCallback(async (chatId: string, runId: string, rerun?: { stepId: string; model?: string; withDependents?: boolean }): Promise<boolean> => {
    const current = runRef.current
    if (current && !current.review && isRunActive(current.view)) return false
    setStartError(null)
    const record = await window.api.getMultiAgentRun(chatId, runId).catch(() => null)
    if (!record || record.mode !== 'multi-agent' || record.executionTrace.length === 0) return false
    const config: MultiAgentConfig = await window.api.getMultiAgentConfig().catch(() => DEFAULT_MULTI_AGENT_CONFIG)
    const next: ActiveRun = { chatId, task: record.task ?? '', review: false, config, view: reduceRunEvents(runId, record.executionTrace), runIds: record.runIds }
    runRef.current = next
    setRun(next)
    const result = await (rerun
      ? window.api.rerunMultiAgentStep({ runId, chatId, config, ...rerun })
      : window.api.resumeMultiAgentRun({ runId, chatId, config })
    ).catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }))
    if (!result.ok) {
      const readOnly = { ...next, review: true }
      runRef.current = readOnly
      setRun(readOnly)
      setStartError(result.reason)
      return false
    }
    return true
  }, [])

  const dismiss = useCallback(() => {
    runRef.current = null
    setRun(null)
    setStartError(null)
  }, [])

  const approvePlan = useCallback((approved: boolean) => {
    const current = runRef.current
    if (!current || current.review) return
    window.api.respondMultiAgentPlan(current.view.runId, approved).catch((err: unknown) => {
      setStartError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  /** Slow-plan escape hatch: stop the orchestrator and take the quick fallback plan (still needs approval). */
  const quickPlan = useCallback(async (): Promise<void> => {
    const current = runRef.current
    if (!current || current.review || current.view.runId.startsWith(PENDING_RUN_PREFIX)) return
    await window.api.useQuickMultiAgentPlan(current.view.runId).catch((err: unknown) => {
      setStartError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  const abort = useCallback(() => {
    const current = runRef.current
    if (!current || current.review) return
    window.api.abortMultiAgentRun(current.view.runId).catch((err: unknown) => {
      setStartError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  // Memoised so Layout's callbacks that depend on it (handleSend → the memo'd
  // InputBar) keep their identity across unrelated Layout renders.
  return useMemo(
    () => ({ run, startError, setStartError, pricing, start, review, continueRun, dismiss, approvePlan, abort, quickPlan }),
    [run, startError, pricing, start, review, continueRun, dismiss, approvePlan, abort, quickPlan],
  )
}
