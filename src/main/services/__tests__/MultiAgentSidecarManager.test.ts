import { EventEmitter } from 'events'
import { describe, it, expect, vi } from 'vitest'
import { MultiAgentSidecarManager } from '../MultiAgentSidecarManager'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'

const payload = { chatId: 'chat-123', task: 'Summarise the repo', config: DEFAULT_MULTI_AGENT_CONFIG }

function child(): any {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.killed = false
  proc.kill = vi.fn(() => { proc.killed = true })
  return proc
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('MultiAgentSidecarManager', () => {
  it('starts via SandboxService only and returns a sidecar run id', async () => {
    const proc = child()
    const spawnPersistent = vi.fn().mockResolvedValue(proc)
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ runId: 'run-from-sidecar' }))
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const manager = new MultiAgentSidecarManager({ fetchFn: fetchFn as typeof fetch, spawnPersistent })
    manager.configure({ scriptPath: '/app/multi_agent_sidecar.py', workspaceDir: '/tmp/sidecar', openRouterApiKey: 'secret', port: 7823 })

    await expect(manager.startRun(payload)).resolves.toEqual({ ok: true, runId: 'run-from-sidecar' })
    expect(spawnPersistent).toHaveBeenCalledWith(expect.objectContaining({
      executionProfile: 'lightweight', allowedDomains: ['openrouter.ai'], callerLabel: 'multi-agent-sidecar',
      command: "python3 /app/multi_agent_sidecar.py",
    }))
    expect(manager.getStatus()).toBe('running')
  })

  it('does not start when no OpenRouter key is configured', async () => {
    const spawnPersistent = vi.fn()
    const manager = new MultiAgentSidecarManager({ spawnPersistent })
    manager.configure({ scriptPath: '/app/sidecar.py', workspaceDir: '/tmp/sidecar', openRouterApiKey: '' })
    await expect(manager.startRun(payload)).resolves.toEqual(expect.objectContaining({ ok: false }))
    expect(spawnPersistent).not.toHaveBeenCalled()
  })

  it('validates SSE events before emitting them and drops malformed data', async () => {
    const manager = new MultiAgentSidecarManager()
    const received: unknown[] = []
    manager.on('event', (event) => received.push(event))
    ;(manager as any).handleSseFrame('data: {"runId":"r","seq":1,"ts":1,"type":"synthesis_token","token":"Hi"}')
    ;(manager as any).handleSseFrame('data: {"type":"unknown"}')
    expect(received).toEqual([expect.objectContaining({ type: 'synthesis_token', token: 'Hi' })])
  })

  it('aborts an active stream and sends DELETE to the sidecar', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({}))
    const manager = new MultiAgentSidecarManager({ fetchFn: fetchFn as typeof fetch })
    manager.configure({ scriptPath: '/app/sidecar.py', workspaceDir: '/tmp/sidecar', openRouterApiKey: 'secret' })
    const controller = new AbortController()
    ;(manager as any).streams.set('r1', controller)
    await manager.abortRun('r1')
    expect(controller.signal.aborted).toBe(true)
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/run/r1'), expect.objectContaining({ method: 'DELETE' }))
  })

  it('kills the sidecar and aborts streams on clean shutdown', async () => {
    const manager = new MultiAgentSidecarManager()
    const proc = child()
    const controller = new AbortController()
    ;(manager as any).process = proc
    ;(manager as any).streams.set('r1', controller)
    await manager.stop()
    expect(proc.kill).toHaveBeenCalledOnce()
    expect(controller.signal.aborted).toBe(true)
    expect(manager.getStatus()).toBe('stopped')
  })
})
