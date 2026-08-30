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
})
