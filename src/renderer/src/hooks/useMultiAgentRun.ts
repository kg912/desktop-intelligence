import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import type { AgentEvent, MultiAgentConfig } from '../../../shared/types'
import { isTerminalAgentEvent } from '../../../shared/agentEvents'
import type { ModelPricing } from '../../../shared/multiAgentModels'
import { applyAgentEvent, emptyRunView, reduceRunEvents } from '../lib/multiAgentRunState'
import type { RunView } from '../lib/multiAgentRunState'

export interface ActiveRun {
  chatId: string
  task: string
  view: RunView
  /** A persisted run opened for review — read-only, no controls. */
  review: boolean
  /** Config the run was started with (for the pre-flight estimate). */
  config: MultiAgentConfig
}

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

    const started = await window.api.startMultiAgentRun({ chatId, task, config })
    if (!started.ok) {
      setStartError(started.reason)
      return false
    }
    const buffered = early.current.filter((e) => e.runId === started.runId)
    early.current = early.current.filter((e) => e.runId !== started.runId)
    const view = buffered.reduce(applyAgentEvent, emptyRunView(started.runId))
    const next: ActiveRun = { chatId, task, view, review: false, config: started.config ?? config }
    runRef.current = next
    setRun(next)
    if (buffered.some(isTerminalAgentEvent)) finishedRef.current(chatId)
    return true
  }, [])

  const review = useCallback(async (chatId: string, task = ''): Promise<boolean> => {
    const record = await window.api.getMultiAgentRun(chatId).catch(() => null)
    if (!record || record.mode !== 'multi-agent' || record.executionTrace.length === 0) return false
    const runId = record.executionTrace[0].runId
    const next: ActiveRun = {
      chatId, task, review: true, config: DEFAULT_MULTI_AGENT_CONFIG,
      view: reduceRunEvents(runId, record.executionTrace),
    }
    runRef.current = next
    setRun(next)
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

  const abort = useCallback(() => {
    const current = runRef.current
    if (!current || current.review) return
    window.api.abortMultiAgentRun(current.view.runId).catch((err: unknown) => {
      setStartError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  return { run, startError, setStartError, pricing, start, review, dismiss, approvePlan, abort }
}
