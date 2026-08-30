/**
 * MTPLXDaemonManager unit tests
 *
 * Focus: the ownership-tracking logic that distinguishes a server WE started from
 * one the user's own MTPLX GUI app was already running. Getting this wrong means
 * Desktop Intelligence tears down someone else's model on quit.
 *
 * Coverage goals:
 *   ✓ Pre-flight succeeds  → spawnedByUs stays false, `mtplx serve` never spawned
 *   ✓ Pre-flight succeeds  → shutdown() does NOT call `mtplx stop`
 *   ✓ Pre-flight fails     → `mtplx serve --port <port>` spawned, spawnedByUs true
 *   ✓ Pre-flight fails     → shutdown() DOES call `mtplx stop`
 *   ✓ start() never called → shutdown() no-ops (no binary resolved)
 *   ✓ No model-load step is ever run — MTPLX owns its own model selection
 *   ✓ Port comes from the saved mtplxBaseUrl, not the hardcoded default
 *   ✓ Phase reaches 'ready' on both the attach path and the spawn path
 *   ✓ resolveMtplxPort parsing, including malformed input
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAxiosGet    = vi.fn()
const mockSpawn       = vi.fn()
const mockExecFileSync = vi.fn()
const mockExistsSync  = vi.fn()
const mockReadSettings = vi.fn()

vi.mock('axios', () => ({
  default: { get: (...args: unknown[]) => mockAxiosGet(...args) },
}))

vi.mock('child_process', () => ({
  spawn:        (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}))

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

vi.mock('../../services/SettingsStore', () => ({
  readSettings: () => mockReadSettings(),
}))

import { MTPLXDaemonManager, resolveMtplxPort } from '../MTPLXDaemonManager'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A fake ChildProcess that exits cleanly on the next microtask. */
function makeFakeChild(exitCode: number | null = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    killed: boolean
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill   = vi.fn()
  child.killed = false
  queueMicrotask(() => child.emit('close', exitCode))
  return child
}

/** Pre-flight / readiness probe answers 200 — i.e. a server is listening. */
function serverUp() {
  mockAxiosGet.mockResolvedValue({ status: 200 })
}

/** Pre-flight probe refuses, then the post-spawn readiness probe succeeds. */
function serverDownThenUp() {
  mockAxiosGet
    .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    .mockResolvedValue({ status: 200 })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Binary discovery: /opt/homebrew/bin/mtplx is the first candidate and exists.
  mockExistsSync.mockImplementation((p: string) => p === '/opt/homebrew/bin/mtplx')
  mockReadSettings.mockReturnValue({})
  mockSpawn.mockImplementation(() => makeFakeChild(0))
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── resolveMtplxPort ─────────────────────────────────────────────────────────

describe('resolveMtplxPort', () => {
  it('defaults to 8000 when no base URL is saved', () => {
    expect(resolveMtplxPort(undefined)).toBe(8000)
  })

  it('reads an explicit non-default port — confirmed working on 6000 locally', () => {
    expect(resolveMtplxPort('http://localhost:6000')).toBe(6000)
  })

  it('tolerates a trailing slash', () => {
    expect(resolveMtplxPort('http://localhost:6000/')).toBe(6000)
  })

  it('falls back to 8000 for an unparseable URL', () => {
    expect(resolveMtplxPort('not a url')).toBe(8000)
  })

  it('uses the protocol default port when the URL omits one', () => {
    expect(resolveMtplxPort('http://localhost')).toBe(80)
    expect(resolveMtplxPort('https://mtplx.internal')).toBe(443)
  })
})

// ─── Attach path: a server is already running ─────────────────────────────────

describe('start() — server already running (externally managed)', () => {
  it('does not spawn `mtplx serve` when pre-flight succeeds', async () => {
    serverUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('leaves spawnedByUs false so shutdown knows the server is not ours', async () => {
    serverUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mgr.didSpawnServer()).toBe(false)
  })

  it('reaches phase "ready" without a model-load step', async () => {
    serverUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mgr.getState().phase).toBe('ready')
    expect(mgr.getState().error).toBeNull()
  })

  it('shutdown() does NOT run `mtplx stop` — that would kill the MTPLX app\'s server', async () => {
    serverUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()
    await mgr.shutdown()

    // execFileSync is only used for `which` lookups and `mtplx stop`; neither
    // should have fired with a 'stop' argument here.
    const stopCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('stop'),
    )
    expect(stopCalls).toHaveLength(0)
  })
})

// ─── Spawn path: no server running ────────────────────────────────────────────

describe('start() — no server running (we own it)', () => {
  it('spawns `mtplx serve --port 8000` by default', async () => {
    serverDownThenUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [bin, args] = mockSpawn.mock.calls[0]
    expect(bin).toBe('/opt/homebrew/bin/mtplx')
    expect(args).toEqual(['serve', '--port', '8000'])
  })

  it('never uses `mtplx start` — that would launch the interactive wizard', async () => {
    serverDownThenUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    const args = mockSpawn.mock.calls[0][1] as string[]
    expect(args[0]).toBe('serve')
    expect(args).not.toContain('start')
  })

  it('uses the port from the saved mtplxBaseUrl, not the hardcoded default', async () => {
    mockReadSettings.mockReturnValue({ mtplxBaseUrl: 'http://localhost:6000' })
    serverDownThenUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mockSpawn.mock.calls[0][1]).toEqual(['serve', '--port', '6000'])
    // The health probe targets the same port.
    expect(mockAxiosGet).toHaveBeenCalledWith(
      'http://127.0.0.1:6000/health',
      expect.anything(),
    )
  })

  it('sets spawnedByUs true after a successful spawn', async () => {
    serverDownThenUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mgr.didSpawnServer()).toBe(true)
  })

  it('reaches phase "ready" with no model-load step in between', async () => {
    serverDownThenUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mgr.getState().phase).toBe('ready')
    // Exactly one spawn — the serve call. No `load`-equivalent second command.
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('shutdown() DOES run `mtplx stop` for a server we started', async () => {
    serverDownThenUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()
    mockExecFileSync.mockClear()

    await mgr.shutdown()

    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/opt/homebrew/bin/mtplx',
      ['stop'],
      { timeout: 10_000 },
    )
  })

  it('shutdown() swallows a failing `mtplx stop` rather than throwing', async () => {
    serverDownThenUp()
    const mgr = new MTPLXDaemonManager()
    await mgr.start()
    mockExecFileSync.mockImplementation(() => { throw new Error('not running') })

    await expect(mgr.shutdown()).resolves.toBeUndefined()
  })
})

// ─── No binary / never started ────────────────────────────────────────────────

describe('start() — mtplx binary not installed', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false)
    mockExecFileSync.mockImplementation(() => { throw new Error('not found') })
  })

  it('does not spawn anything and stays idle — HTTP polling takes over', async () => {
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mgr.getState().phase).toBe('idle')
  })

  it('shutdown() no-ops when the binary was never resolved', async () => {
    const mgr = new MTPLXDaemonManager()
    await mgr.start()
    mockExecFileSync.mockClear()

    await expect(mgr.shutdown()).resolves.toBeUndefined()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })
})

describe('shutdown() before start()', () => {
  it('no-ops when start() was never called at all', async () => {
    const mgr = new MTPLXDaemonManager()

    await expect(mgr.shutdown()).resolves.toBeUndefined()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mgr.didSpawnServer()).toBe(false)
  })
})

// ─── Failure handling ─────────────────────────────────────────────────────────

describe('start() — spawn fails', () => {
  it('transitions to error when `mtplx serve` exits non-zero', async () => {
    mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'))
    mockSpawn.mockImplementation(() => makeFakeChild(1))

    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mgr.getState().phase).toBe('error')
    expect(mgr.getState().error).toContain('exited with code 1')
  })

  it('leaves spawnedByUs false when the spawn itself failed', async () => {
    mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'))
    mockSpawn.mockImplementation(() => makeFakeChild(1))

    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    // The flag is only set after runCommand resolves, so a failed spawn must not
    // arm the shutdown path.
    expect(mgr.didSpawnServer()).toBe(false)
  })

  it('shutdown() after a failed spawn does not run `mtplx stop`', async () => {
    mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'))
    mockSpawn.mockImplementation(() => makeFakeChild(1))

    const mgr = new MTPLXDaemonManager()
    await mgr.start()
    mockExecFileSync.mockClear()
    await mgr.shutdown()

    expect(mockExecFileSync).not.toHaveBeenCalled()
  })
})
