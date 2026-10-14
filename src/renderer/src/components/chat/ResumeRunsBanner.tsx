import { useEffect, useState } from 'react'
import type { ResumableRun } from '../../../../shared/types'

/** Spec B Phase 5: multi-agent runs a sidecar restart interrupted, offered once on start as Resume / Discard. */
export function ResumeRunsBanner({ onResume }: { onResume: (run: ResumableRun) => void }) {
  const [runs, setRuns] = useState<ResumableRun[]>([])
  useEffect(() => {
    let cancelled = false
    // Older preloads (and test doubles) have no such method: nothing to offer.
    Promise.resolve(window.api.listResumableMultiAgentRuns?.() ?? []).then((list) => { if (!cancelled && Array.isArray(list)) setRuns(list) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const drop = (runId: string) => setRuns((list) => list.filter((r) => r.runId !== runId))
  if (!runs.length) return null
  return (
    <>
      {runs.map((run) => (
        <div key={run.runId} data-testid={`resume-run-${run.runId}`} role="status"
          className="mx-4 mb-1 flex items-start gap-2 rounded-lg border-[0.5px] border-[#e6b422]/35 bg-[#e6b422]/[0.05] px-3 py-2 text-[12.5px] text-[#e8c77f]">
          <span className="min-w-0 flex-1">
            A multi-agent run was interrupted: <span className="text-ma-text">{run.task}</span>.{' '}
            {run.finishedSteps.length} of {run.totalSteps} steps finished; those are kept.
          </span>
          <button onClick={() => { drop(run.runId); onResume(run) }}
            className="h-6 flex-none rounded-[6px] border-[0.5px] border-ma-red bg-ma-red px-2.5 text-[12px] font-medium text-white hover:bg-[#d8322e]">Resume</button>
          <button onClick={() => { drop(run.runId); void window.api.discardMultiAgentRun(run.runId).catch(() => {}) }}
            className="h-6 flex-none rounded-[6px] border-[0.5px] border-white/[0.09] px-2.5 text-[12px] text-ma-mute hover:bg-ma-bg3 hover:text-ma-text">Discard</button>
        </div>
      ))}
    </>
  )
}
