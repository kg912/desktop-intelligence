/**
 * MultiAgentSidecarManager — Phase 1 skeleton.
 *
 * Exposes the full lifecycle interface the IPC handlers and Phase 2 will need,
 * but contains no process-spawning or HTTP logic. Every method returns a
 * synthetic response describing the "sidecar not running" state.
 *
 * Phase 2 wires the real process spawn, health-check loop, and clean-kill
 * into index.ts, then fills in the TODO stubs below.
 *
 * Intentionally dependency-free (no Electron imports, no child_process) so
 * this class can be unit-tested without any Electron bootstrap.
 */

import type {
  SidecarStatus,
  MultiAgentStartPayload,
  StartRunResult,
  HitlResponse,
} from '../../shared/types'

export class MultiAgentSidecarManager {
  private _status: SidecarStatus = 'stopped'

  getStatus(): SidecarStatus {
    return this._status
  }

  startRun(_payload: MultiAgentStartPayload): StartRunResult {
    // TODO(Phase 2): spawn sidecar + POST /run
    return { ok: false, reason: 'sidecar_unavailable' }
  }

  respondHitl(_response: HitlResponse): void {
    // TODO(Phase 2): POST /run/{id}/resume
  }

  abortRun(_runId: string): void {
    // TODO(Phase 2): DELETE /run/{id}
  }
}

export const multiAgentSidecar = new MultiAgentSidecarManager()
