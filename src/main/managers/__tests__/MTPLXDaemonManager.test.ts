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
 *
 * REGRESSION — `mtplx serve` is a long-running foreground process:
 *   ✓ start() reaches 'ready' when the child NEVER emits 'close'
 *   ✓ start() does not SIGTERM the server it just spawned
 *   ✓ the persistent child is still tracked for killAllChildren()/shutdown()
 *   ✓ --no-stats-footer is passed so the live dashboard does not spam stdout
 *
 *   The original implementation routed the spawn through an LMSDaemonManager-style
 *   runCommand() helper that resolved on the child's 'close' event. `mtplx serve`
 *   never closes, so every cold start hung until the 30s timeout guard fired,
 *   SIGTERMed the freshly-started server and reported a false failure. The
 *   makePersistentChild() helper below models the real process; makeFakeChild()
 *   (which closes immediately) models LM Studio's fork-and-exit and is why the
 *   original test suite missed this.
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

/**
 * A fake ChildProcess that models `mtplx serve`: it starts and STAYS RUNNING.
 * No 'close', no 'exit', no 'error' — ever. Anything that awaits its exit hangs.
 */
function makePersistentChild() {
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
    expect(args).toEqual(['serve', '--port', '8000', '--no-stats-footer'])
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

    expect(mockSpawn.mock.calls[0][1]).toEqual(['serve', '--port', '6000', '--no-stats-footer'])
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

// ─── REGRESSION: `mtplx serve` never exits ────────────────────────────────────
//
// Every test in this block uses makePersistentChild(), which never emits 'close'.
// Against the original runCommand()-based implementation each of them fails:
// start() would await an exit that never comes, hang for the 30s timeout guard,
// SIGTERM the server it had just started, and settle in phase 'error'.
//
// Each `it` carries an explicit short timeout so a reintroduced await fails fast
// instead of stalling the suite for vitest's default 5s.

describe('start() — `mtplx serve` is long-running and never exits', () => {
  beforeEach(() => {
    serverDownThenUp()
    mockSpawn.mockImplementation(() => makePersistentChild())
  })

  it('reaches phase "ready" even though the child never closes', async () => {
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mgr.getState().phase).toBe('ready')
    expect(mgr.getState().error).toBeNull()
  }, 2000)

  it('readiness comes from the /health poll, not from process exit', async () => {
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    // Two probes: the pre-flight (refused) and the post-spawn readiness poll.
    expect(mockAxiosGet).toHaveBeenCalledTimes(2)
    expect(mockAxiosGet).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/health',
      expect.anything(),
    )
  }, 2000)

  it('does NOT SIGTERM the server it just spawned', async () => {
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    const child = mockSpawn.mock.results[0].value
    expect(child.kill).not.toHaveBeenCalled()
  }, 2000)

  it('marks the still-running server as ours so shutdown stops it', async () => {
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mgr.didSpawnServer()).toBe(true)
  }, 2000)

  it('still tracks the persistent child so shutdown() can kill it', async () => {
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    const child = mockSpawn.mock.results[0].value
    await mgr.shutdown()

    // killAllChildren() reaches the child that is still in activeChildren…
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    // …and, because we own it, `mtplx stop` runs too.
    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/opt/homebrew/bin/mtplx',
      ['stop'],
      { timeout: 10_000 },
    )
  }, 2000)

  it('passes --no-stats-footer so the live dashboard does not spam piped stdout', async () => {
    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mockSpawn.mock.calls[0][1]).toContain('--no-stats-footer')
  }, 2000)

  it('pipes stdout/stderr — stderr updates state.stderr and emits stateChange', async () => {
    const mgr = new MTPLXDaemonManager()
    const onStateChange = vi.fn()
    mgr.on('stateChange', onStateChange)
    await mgr.start()

    const child = mockSpawn.mock.results[0].value
    onStateChange.mockClear()
    child.stderr.emit('data', Buffer.from('  model load warning  '))

    expect(mgr.getState().stderr).toBe('model load warning')
    expect(onStateChange).toHaveBeenCalled()
  }, 2000)

  it('retry() kills the running server before spawning a replacement', async () => {
    const mgr = new MTPLXDaemonManager()
    await mgr.start()
    const first = mockSpawn.mock.results[0].value

    serverDownThenUp()
    await mgr.retry()

    expect(first.kill).toHaveBeenCalledWith('SIGTERM')
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(mgr.getState().phase).toBe('ready')
  }, 2000)
})

// ─── Health check never succeeds ──────────────────────────────────────────────
//
// waitForServerUp polls 20 × 500ms of REAL time before giving up, which exceeds
// vitest's default per-test timeout. These tests drive fake timers through that
// window instead of waiting it out — start() is left unawaited while the clock
// is advanced, then awaited once the poll budget is exhausted.

describe('start() — server spawned but /health never answers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Pre-flight refused and every readiness poll refused too.
    mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'))
    mockSpawn.mockImplementation(() => makePersistentChild())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Runs start() to completion by advancing past the whole /health poll window. */
  async function startBurningPollWindow(mgr: MTPLXDaemonManager): Promise<void> {
    const pending = mgr.start()
    // 20 attempts × 500ms, plus slack. advanceTimersByTimeAsync flushes the
    // microtask queue between ticks so the awaited axios rejections settle.
    await vi.advanceTimersByTimeAsync(11_000)
    await pending
  }

  it('reports an error instead of hanging on the child that never exits', async () => {
    const mgr = new MTPLXDaemonManager()
    await startBurningPollWindow(mgr)

    expect(mgr.getState().phase).toBe('error')
    expect(mgr.getState().error).toContain('did not become reachable')
  })

  it('leaves spawnedByUs false — no confirmed server means nothing to stop', async () => {
    const mgr = new MTPLXDaemonManager()
    await startBurningPollWindow(mgr)

    expect(mgr.didSpawnServer()).toBe(false)
  })

  it('still kills the orphaned child on shutdown', async () => {
    const mgr = new MTPLXDaemonManager()
    await startBurningPollWindow(mgr)
    const child = mockSpawn.mock.results[0].value
    await mgr.shutdown()

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

// ─── Spawn-time failures surface without awaiting exit ────────────────────────

describe('spawn failures are reported without waiting on process exit', () => {
  it('surfaces an ENOENT-style spawn error rather than a generic timeout', async () => {
    mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'))
    mockSpawn.mockImplementation(() => {
      const child = makePersistentChild()
      // The 'error' event fires asynchronously, after spawn() has returned.
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
      return child
    })

    const mgr = new MTPLXDaemonManager()
    await mgr.start()

    expect(mgr.getState().phase).toBe('error')
    expect(mgr.getState().error).toContain('Failed to spawn')
    expect(mgr.getState().error).toContain('ENOENT')
  }, 2000)

  it('an unhandled child "error" event does not crash the process', async () => {
    // A ChildProcess with no 'error' listener throws. Attaching one is mandatory
    // even though the spawn is fire-and-forget.
    mockAxiosGet.mockRejectedValue(new Error('ECONNREFUSED'))
    mockSpawn.mockImplementation(() => {
      const child = makePersistentChild()
      queueMicrotask(() => child.emit('error', new Error('EACCES')))
      return child
    })

    const mgr = new MTPLXDaemonManager()
    await expect(mgr.start()).resolves.toBeUndefined()
  }, 2000)
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
