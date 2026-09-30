/**
 * ModelConnectionManager unit tests — parameterisation
 *
 * The class was hardcoded to LM Studio (fixed URL, literal "LM Studio" strings in
 * every error message). It now takes a `getHealthUrl` thunk and a `label` so a
 * second instance can watch MTPLX independently.
 *
 * Coverage goals:
 *   ✓ Both exported singletons carry the right label in every error message
 *   ✓ getHealthUrl is called PER POLL, not captured once — MTPLX's port is
 *     user-configurable at runtime, so a settings change must take effect
 *   ✓ The MTPLX singleton reads mtplxBaseUrl from settings and strips a
 *     trailing slash
 *   ✓ FAILURES_BEFORE_OFFLINE (2) still gates the offline transition
 *   ✓ A successful poll with models → 'ready' with modelInfo from data[0]
 *   ✓ An empty models array → 'offline' with a label-specific message
 *
 * Timers: poll() schedules the next poll in a `finally`. Tests use fake timers so
 * that scheduled follow-up polls never fire, keeping each assertion about exactly
 * one poll.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockAxiosGet     = vi.fn()
const mockReadSettings = vi.fn()

vi.mock('axios', () => ({
  default: { get: (...args: unknown[]) => mockAxiosGet(...args) },
  // AxiosError is imported as a type only, so no runtime export is needed.
}))

vi.mock('../../services/SettingsStore', () => ({
  readSettings: () => mockReadSettings(),
}))

// ModelConnectionManager imports the MTPLX daemon singleton to read its phase.
const mockDaemonPhase = vi.fn(() => 'ready')
vi.mock('../MTPLXDaemonManager', () => ({
  mtplxDaemonManager: {
    getState: () => ({ phase: mockDaemonPhase(), error: null, stderr: null }),
  },
}))

import {
  ModelConnectionManager,
  modelConnectionManager,
  mtplxConnectionManager,
} from '../ModelConnectionManager'

// ── Helpers ───────────────────────────────────────────────────────────────────

const okResponse = (ids: string[]) => ({
  data: {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'owner' })),
  },
})

/** Drives a manager through exactly `n` polls via forcePoll(). */
async function pollTimes(mgr: ModelConnectionManager, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await mgr.forcePoll()
}

/**
 * forcePoll() resets the failure streak by design, so the two-failure path to
 * 'offline' is driven through start() (an immediate poll) plus a timer advance.
 */
async function pollTwiceViaTimer(mgr: ModelConnectionManager): Promise<void> {
  mgr.start()
  await vi.advanceTimersByTimeAsync(0)   // let the immediate poll settle
  await vi.advanceTimersByTimeAsync(3_000) // POLL_INTERVAL_OFFLINE_MS → second poll
  await vi.advanceTimersByTimeAsync(0)
  mgr.stop()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockReadSettings.mockReturnValue({})
  // Default: daemon already up, so the boot gate is inactive and the existing
  // offline-transition assertions behave exactly as before.
  mockDaemonPhase.mockReturnValue('ready')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ─── getHealthUrl is a thunk, re-evaluated per poll ───────────────────────────

describe('getHealthUrl thunk', () => {
  it('is called on every poll, not captured once at construction', async () => {
    const getUrl = vi.fn(() => 'http://localhost:1234/v1/models')
    const mgr = new ModelConnectionManager(getUrl, 'Test')
    mockAxiosGet.mockResolvedValue(okResponse(['m1']))

    await pollTimes(mgr, 3)

    expect(getUrl).toHaveBeenCalledTimes(3)
  })

  it('picks up a URL change between polls — the MTPLX port is runtime-configurable', async () => {
    let port = 8000
    const mgr = new ModelConnectionManager(() => `http://localhost:${port}/v1/models`, 'Test')
    mockAxiosGet.mockResolvedValue(okResponse(['m1']))

    await mgr.forcePoll()
    expect(mockAxiosGet).toHaveBeenLastCalledWith(
      'http://localhost:8000/v1/models',
      expect.anything(),
    )

    port = 6000
    await mgr.forcePoll()
    expect(mockAxiosGet).toHaveBeenLastCalledWith(
      'http://localhost:6000/v1/models',
      expect.anything(),
    )
  })
})

// ─── Label interpolation — error messages name the right backend ──────────────

describe('label in error messages', () => {
  const cases: Array<[string, Record<string, unknown>, (label: string) => string]> = [
    ['connection refused',  { code: 'ECONNREFUSED' }, (l) => `${l} server is not running.`],
    ['timeout (ETIMEDOUT)', { code: 'ETIMEDOUT' },    (l) => `Connection to ${l} timed out.`],
    ['timeout (ECONNABORTED)', { code: 'ECONNABORTED' }, (l) => `Connection to ${l} timed out.`],
    ['HTTP error status',   { response: { status: 503 } }, (l) => `${l} responded with error 503.`],
    ['unknown failure',     {},                       (l) => `Cannot reach ${l}.`],
  ]

  for (const [name, err, expected] of cases) {
    it(`"${name}" reports the LM Studio label`, async () => {
      mockAxiosGet.mockRejectedValue(err)
      const mgr = new ModelConnectionManager(() => 'http://x/v1/models', 'LM Studio')

      await pollTwiceViaTimer(mgr)

      expect(mgr.getState().status).toBe('offline')
      expect(mgr.getState().error).toBe(expected('LM Studio'))
    })

    it(`"${name}" reports the MTPLX label`, async () => {
      mockAxiosGet.mockRejectedValue(err)
      const mgr = new ModelConnectionManager(() => 'http://x/v1/models', 'MTPLX')

      await pollTwiceViaTimer(mgr)

      expect(mgr.getState().status).toBe('offline')
      expect(mgr.getState().error).toBe(expected('MTPLX'))
      // No leaked LM Studio strings on the MTPLX instance.
      expect(mgr.getState().error).not.toContain('LM Studio')
    })
  }

  it('the empty-model-list message names the backend twice', async () => {
    mockAxiosGet.mockResolvedValue(okResponse([]))
    const mgr = new ModelConnectionManager(() => 'http://x/v1/models', 'MTPLX')

    await mgr.forcePoll()

    expect(mgr.getState().status).toBe('offline')
    expect(mgr.getState().error).toBe(
      'MTPLX is running but no model is loaded. Load a model in MTPLX to continue.',
    )
  })
})

// ─── Existing behaviour preserved by the refactor ─────────────────────────────

describe('polling behaviour (unchanged by parameterisation)', () => {
  it('a successful poll with models transitions to ready with data[0]', async () => {
    mockAxiosGet.mockResolvedValue(okResponse(['qwen3-30b', 'other']))
    const mgr = new ModelConnectionManager(() => 'http://x/v1/models', 'MTPLX')

    await mgr.forcePoll()

    expect(mgr.getState().status).toBe('ready')
    expect(mgr.getState().modelInfo?.id).toBe('qwen3-30b')
    expect(mgr.getState().error).toBeNull()
  })

  it('a single failure does not flip to offline — FAILURES_BEFORE_OFFLINE is 2', async () => {
    mockAxiosGet.mockRejectedValue({ code: 'ECONNREFUSED' })
    const mgr = new ModelConnectionManager(() => 'http://x/v1/models', 'MTPLX')

    mgr.start()
    await vi.advanceTimersByTimeAsync(0)
    mgr.stop()

    expect(mgr.getState().status).not.toBe('offline')
  })

  it('a success after failures resets the streak', async () => {
    mockAxiosGet.mockRejectedValueOnce({ code: 'ECONNREFUSED' })
    mockAxiosGet.mockResolvedValue(okResponse(['m1']))
    const mgr = new ModelConnectionManager(() => 'http://x/v1/models', 'MTPLX')

    mgr.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    mgr.stop()

    expect(mgr.getState().status).toBe('ready')
  })
})

// ─── Failure-counter cap ──────────────────────────────────────────────────────
//
// The counter only gates the offline transition, so it must stop at the
// threshold. Unbounded, it produced log lines like "(4/2)" on any sustained
// outage — already wrong for LM Studio, just rarely visible there.

describe('consecutiveFailures is capped at the threshold', () => {
  it('never logs a count above FAILURES_BEFORE_OFFLINE', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockAxiosGet.mockRejectedValue({ code: 'ECONNREFUSED' })
    const mgr = new ModelConnectionManager(() => 'http://x/v1/models', 'MTPLX')

    mgr.start()
    // Six failed polls — well past the threshold of 2.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(3_000)
      await vi.advanceTimersByTimeAsync(0)
    }
    mgr.stop()

    const lines = logSpy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('(1/2)'))).toBe(true)
    expect(lines.some((l) => l.includes('(2/2)'))).toBe(true)
    // The regression: any count beyond the threshold.
    expect(lines.some((l) => /\((?:[3-9]|\d{2,})\/2\)/.test(l))).toBe(false)
    // Subsequent failures still log, just without a nonsense ratio.
    expect(lines.some((l) => l.includes('Still unreachable'))).toBe(true)
  })

  it('still transitions to offline once the threshold is reached', async () => {
    mockAxiosGet.mockRejectedValue({ code: 'ECONNREFUSED' })
    const mgr = new ModelConnectionManager(() => 'http://x/v1/models', 'MTPLX')

    await pollTwiceViaTimer(mgr)

    expect(mgr.getState().status).toBe('offline')
  })
})

// ─── Boot gate: suppress 'offline' while the daemon is starting ───────────────
//
// MTPLX's cold start (spawn → model load → /health) takes several seconds during
// which every poll legitimately fails. Without this gate the overlay flashed a
// false "not running" mid-boot before settling — the reported symptom.

describe('isBackendBooting gate', () => {
  const bootingGate = (phase: () => string) => () => {
    const p = phase()
    return p === 'preflight' || p === 'starting-server'
  }

  for (const phase of ['preflight', 'starting-server']) {
    it(`stays 'connecting' past the failure threshold while the daemon is '${phase}'`, async () => {
      mockAxiosGet.mockRejectedValue({ code: 'ECONNREFUSED' })
      const mgr = new ModelConnectionManager(
        () => 'http://x/v1/models',
        'MTPLX',
        bootingGate(() => phase),
      )

      mgr.start()
      // Five failed polls — far past FAILURES_BEFORE_OFFLINE.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(3_000)
        await vi.advanceTimersByTimeAsync(0)
      }
      mgr.stop()

      expect(mgr.getState().status).toBe('connecting')
      expect(mgr.getState().error).toBeNull()
    })
  }

  for (const phase of ['ready', 'error', 'idle']) {
    it(`allows the real 'offline' state once the daemon is '${phase}'`, async () => {
      mockAxiosGet.mockRejectedValue({ code: 'ECONNREFUSED' })
      const mgr = new ModelConnectionManager(
        () => 'http://x/v1/models',
        'MTPLX',
        bootingGate(() => phase),
      )

      await pollTwiceViaTimer(mgr)

      expect(mgr.getState().status).toBe('offline')
      expect(mgr.getState().error).toBe('MTPLX server is not running.')
    })
  }

  it('reports offline as soon as a boot finishes in error mid-poll-streak', async () => {
    let phase = 'starting-server'
    mockAxiosGet.mockRejectedValue({ code: 'ECONNREFUSED' })
    const mgr = new ModelConnectionManager(
      () => 'http://x/v1/models',
      'MTPLX',
      bootingGate(() => phase),
    )

    mgr.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(mgr.getState().status).toBe('connecting')

    // The daemon gives up — the poller must stop shielding the failure.
    phase = 'error'
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(0)
    mgr.stop()

    expect(mgr.getState().status).toBe('offline')
  })

  it('a successful poll still reaches ready while the gate is active', async () => {
    mockAxiosGet.mockResolvedValue(okResponse(['m1']))
    const mgr = new ModelConnectionManager(
      () => 'http://x/v1/models',
      'MTPLX',
      bootingGate(() => 'starting-server'),
    )

    await mgr.forcePoll()

    // The gate only suppresses failures — it must never block a real success.
    expect(mgr.getState().status).toBe('ready')
  })

  it('LM Studio is unaffected — no gate passed, offline still reported', async () => {
    mockAxiosGet.mockRejectedValue({ code: 'ECONNREFUSED' })
    const mgr = new ModelConnectionManager(() => 'http://x/v1/models', 'LM Studio')

    await pollTwiceViaTimer(mgr)

    expect(mgr.getState().status).toBe('offline')
  })
})

// ─── The two exported singletons ──────────────────────────────────────────────

describe('modelConnectionManager singleton (LM Studio)', () => {
  it('polls LM Studio on the fixed 1234 endpoint', async () => {
    mockAxiosGet.mockResolvedValue(okResponse(['m1']))

    await modelConnectionManager.forcePoll()

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'http://localhost:1234/v1/models',
      expect.anything(),
    )
  })

  it('does not consult SettingsStore for its URL', async () => {
    mockAxiosGet.mockResolvedValue(okResponse(['m1']))

    await modelConnectionManager.forcePoll()

    expect(mockReadSettings).not.toHaveBeenCalled()
  })

  it('reports errors with the "LM Studio" label', async () => {
    mockAxiosGet.mockRejectedValue({ code: 'ECONNREFUSED' })

    await pollTwiceViaTimer(modelConnectionManager)

    expect(modelConnectionManager.getState().error).toBe('LM Studio server is not running.')
  })
})

describe('mtplxConnectionManager singleton (MTPLX)', () => {
  it('defaults to port 8000 when nothing is saved', async () => {
    mockReadSettings.mockReturnValue({})
    mockAxiosGet.mockResolvedValue(okResponse(['m1']))

    await mtplxConnectionManager.forcePoll()

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'http://localhost:8000/v1/models',
      expect.anything(),
    )
  })

  it('reads the saved mtplxBaseUrl — confirmed running on 6000 locally', async () => {
    mockReadSettings.mockReturnValue({ mtplxBaseUrl: 'http://localhost:6000' })
    mockAxiosGet.mockResolvedValue(okResponse(['m1']))

    await mtplxConnectionManager.forcePoll()

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'http://localhost:6000/v1/models',
      expect.anything(),
    )
  })

  it('strips a trailing slash from the saved base URL', async () => {
    mockReadSettings.mockReturnValue({ mtplxBaseUrl: 'http://localhost:6000/' })
    mockAxiosGet.mockResolvedValue(okResponse(['m1']))

    await mtplxConnectionManager.forcePoll()

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'http://localhost:6000/v1/models',
      expect.anything(),
    )
  })

  it('re-reads settings on every poll rather than caching the first value', async () => {
    mockAxiosGet.mockResolvedValue(okResponse(['m1']))

    mockReadSettings.mockReturnValue({ mtplxBaseUrl: 'http://localhost:8000' })
    await mtplxConnectionManager.forcePoll()

    mockReadSettings.mockReturnValue({ mtplxBaseUrl: 'http://localhost:6000' })
    await mtplxConnectionManager.forcePoll()

    expect(mockAxiosGet).toHaveBeenLastCalledWith(
      'http://localhost:6000/v1/models',
      expect.anything(),
    )
  })

  it('reports errors with the "MTPLX" label', async () => {
    mockAxiosGet.mockRejectedValue({ code: 'ECONNREFUSED' })

    await pollTwiceViaTimer(mtplxConnectionManager)

    expect(mtplxConnectionManager.getState().error).toBe('MTPLX server is not running.')
  })

  it('is wired to the real daemon phase — holds connecting during a cold boot', async () => {
    mockDaemonPhase.mockReturnValue('starting-server')
    mockAxiosGet.mockRejectedValue({ code: 'ECONNREFUSED' })

    await pollTwiceViaTimer(mtplxConnectionManager)

    expect(mtplxConnectionManager.getState().status).toBe('connecting')
  })
})
