/**
 * Multi-Agent Phase 1 — MultiAgentSidecarManager unit tests.
 *
 * The manager has no Electron or native-module dependency, so no mocking
 * is needed — import and test directly.
 */

import { describe, it, expect } from 'vitest'
import { MultiAgentSidecarManager } from '../MultiAgentSidecarManager'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import type { MultiAgentStartPayload } from '../../../shared/types'

const validPayload: MultiAgentStartPayload = {
  chatId: 'chat-123',
  task:   'Summarise the repo',
  config: DEFAULT_MULTI_AGENT_CONFIG,
}

describe('MultiAgentSidecarManager', () => {
  it('getStatus() returns "stopped" on a fresh instance', () => {
    const mgr = new MultiAgentSidecarManager()
    expect(mgr.getStatus()).toBe('stopped')
  })

  it('startRun() returns ok=false', () => {
    const mgr = new MultiAgentSidecarManager()
    const result = mgr.startRun(validPayload)
    expect(result.ok).toBe(false)
  })

  it('startRun() returns exact shape { ok: false, reason: "sidecar_unavailable" }', () => {
    const mgr = new MultiAgentSidecarManager()
    expect(mgr.startRun(validPayload)).toEqual({ ok: false, reason: 'sidecar_unavailable' })
  })

  it('startRun() reason is exactly "sidecar_unavailable"', () => {
    const mgr = new MultiAgentSidecarManager()
    const result = mgr.startRun(validPayload)
    if (!result.ok) {
      expect(result.reason).toBe('sidecar_unavailable')
    }
  })

  it('respondHitl() does not throw', () => {
    const mgr = new MultiAgentSidecarManager()
    expect(() => mgr.respondHitl({ runId: 'r1', agentId: 'a1', approved: true })).not.toThrow()
  })

  it('respondHitl() with approved=false does not throw', () => {
    const mgr = new MultiAgentSidecarManager()
    expect(() => mgr.respondHitl({ runId: 'r1', agentId: 'a1', approved: false })).not.toThrow()
  })

  it('abortRun() does not throw', () => {
    const mgr = new MultiAgentSidecarManager()
    expect(() => mgr.abortRun('run-999')).not.toThrow()
  })

  it('startRun() does not mutate status away from "stopped"', () => {
    const mgr = new MultiAgentSidecarManager()
    mgr.startRun(validPayload)
    expect(mgr.getStatus()).toBe('stopped')
  })

  it('multiple startRun() calls all return the same synthetic failure', () => {
    const mgr = new MultiAgentSidecarManager()
    expect(mgr.startRun(validPayload)).toEqual({ ok: false, reason: 'sidecar_unavailable' })
    expect(mgr.startRun(validPayload)).toEqual({ ok: false, reason: 'sidecar_unavailable' })
    expect(mgr.startRun(validPayload)).toEqual({ ok: false, reason: 'sidecar_unavailable' })
  })

  it('status remains "stopped" after respondHitl() and abortRun()', () => {
    const mgr = new MultiAgentSidecarManager()
    mgr.respondHitl({ runId: 'r1', agentId: 'a1', approved: true })
    mgr.abortRun('r1')
    expect(mgr.getStatus()).toBe('stopped')
  })

  it('two independent instances have independent state', () => {
    const a = new MultiAgentSidecarManager()
    const b = new MultiAgentSidecarManager()
    expect(a.getStatus()).toBe('stopped')
    expect(b.getStatus()).toBe('stopped')
  })
})
