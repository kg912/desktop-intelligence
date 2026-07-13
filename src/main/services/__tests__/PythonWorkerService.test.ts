import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import { rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

// ── Mock electron — PythonWorkerService/BASELINE_DENY_READ resolve paths via
// app.getPath()/app.getAppPath()/app.isPackaged at both import time and call
// time, so the mock must be fully usable before PythonWorkerService is
// imported (imports are hoisted above other top-level statements).
const TEST_USERDATA_DIR = '/tmp/di-pythonworker-test-userdata'

const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn((name: string) =>
    name === 'userData' ? '/tmp/di-pythonworker-test-userdata' : '/tmp'
  ),
}))

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}))

// ── Mock ResourceGovernor — capture the onExceeded callback so the
// RSS-exceeded test can trigger the kill path directly instead of needing a
// process that genuinely balloons memory (unreliable in a test suite).
const { mockMemoryWatch } = vi.hoisted(() => ({
  mockMemoryWatch: vi.fn((_pid: number, _maxRssMb: number, _onExceeded: () => void) => vi.fn()),
}))

vi.mock('../sandbox/ResourceGovernor', () => ({
  memoryWatch: mockMemoryWatch,
}))

// Import AFTER mocks are in place
import { PythonWorkerService } from '../PythonWorkerService'
import { srtBackend } from '../sandbox/sandboxServiceInstance'
import { observabilityService } from '../ObservabilityService'
import { shouldAlertForViolation } from '../sandbox/isCredentialPath'
import type { SandboxViolationTraceEvent } from '../../../shared/types'

// ── Environment gate ─────────────────────────────────────────────────────
// These are real end-to-end tests against macOS Seatbelt (sandbox-exec) and
// a real python3 + yfinance install. Skip gracefully on machines that can't
// support them (non-macOS, no python3, yfinance not installed) rather than
// failing CI.
function canRunSandboxTests(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execSync('which sandbox-exec', { stdio: 'ignore' })
    execSync('which python3', { stdio: 'ignore' })
    execSync('python3 -c "import yfinance"', { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

const SANDBOX_TESTS_ENABLED = canRunSandboxTests()

describe.skipIf(!SANDBOX_TESTS_ENABLED)('PythonWorkerService — real sandbox integration', () => {
  let worker: PythonWorkerService

  beforeAll(async () => {
    worker = new PythonWorkerService()
    await worker.start()
  }, 30_000)

  afterAll(async () => {
    worker?.stop()
    // srtBackend.initialize() (called lazily by worker.start()) now enables
    // the macOS log monitor, which spawns a real `log stream` child process
    // (see SrtBackend.ts's investigation comment, point 1). shutdown() ->
    // SandboxManager.reset() tears that down explicitly rather than relying
    // on the whole vitest worker process to exit first.
    await srtBackend.shutdown().catch(() => {})
    try {
      rmSync(TEST_USERDATA_DIR, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  })

  it('fails to read a baseline-denied path (~/.gitconfig) from userCode', async () => {
    const code = `
import os
target = os.path.expanduser('~/.gitconfig')
try:
    with open(target) as f:
        f.read()
except (PermissionError, FileNotFoundError, OSError) as e:
    raise RuntimeError('DENIED_AS_EXPECTED: ' + type(e).__name__) from None
raise AssertionError('SANDBOX_LEAK: read of baseline-denied path succeeded')
`
    const result = await worker.render(code)

    expect(result.success).toBe(false)
    expect(result.error ?? '').not.toContain('SANDBOX_LEAK')
    expect(result.error ?? '').toContain('DENIED_AS_EXPECTED')
  }, 20_000)

  it('fails to reach a non-allowlisted host from userCode', async () => {
    const code = `
import urllib.request
try:
    urllib.request.urlopen('https://example.com', timeout=5).read()
except Exception as e:
    raise RuntimeError('DENIED_AS_EXPECTED: ' + type(e).__name__) from None
raise AssertionError('SANDBOX_LEAK: reached non-allowlisted host')
`
    const result = await worker.render(code)

    expect(result.success).toBe(false)
    expect(result.error ?? '').not.toContain('SANDBOX_LEAK')
    expect(result.error ?? '').toContain('DENIED_AS_EXPECTED')
  }, 20_000)

  it('renders a real yfinance chart end-to-end against the allowlisted hosts', async () => {
    const code = `
h = yf.Ticker("AAPL").history(period="5d")
fig, ax = plt.subplots()
ax.plot(h.index, h['Close'])
ax.set_title('AAPL')
`
    const result = await worker.render(code)

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.imageBase64).toBeTruthy()
    expect((result.imageBase64 ?? '').length).toBeGreaterThan(100)
  }, 20_000)

  it('kills the worker when ResourceGovernor reports RSS exceeded', async () => {
    const rssWorker = new PythonWorkerService()
    await rssWorker.start()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (rssWorker as any).proc
    expect(proc).toBeTruthy()
    const killSpy = vi.spyOn(proc, 'kill')

    const lastCall = mockMemoryWatch.mock.calls.at(-1)
    expect(lastCall).toBeTruthy()
    const onExceeded = lastCall![2] as () => void
    expect(typeof onExceeded).toBe('function')

    onExceeded()
    expect(killSpy).toHaveBeenCalledTimes(1)

    // Stop the worker immediately so the auto-restart-on-crash path (which
    // would otherwise fire once the real 'close' event lands) doesn't leave
    // a zombie sandboxed process running after this test completes.
    rssWorker.stop()
    killSpy.mockRestore()
  }, 20_000)

  // ── Sandbox violation observation (Phase 2, spec section 11/16) ──────────
  //
  // Background — see SrtBackend.ts's header comment, investigation point 4:
  // a FRESH one-shot spawn reliably loses the explicit file-read-data
  // denial's log line to a competing process-launch noise event (verified
  // live, 4 diagnostic spikes). But `worker` here is PythonWorkerService's
  // real PERSISTENT worker (spawned once in beforeAll and still running —
  // exactly how it and every MCP stdio server run in production) — a
  // denied read on an already-running process has no competing
  // process-launch noise, and DOES reliably surface the real, explicit,
  // credential-path-classified violation. This is confirmed below, live,
  // with no mocking of the violation store: real OS-level denial -> real
  // SandboxManager log monitor -> real SrtBackend.subscribeToViolations()
  // -> real ObservabilityService.emitSandboxViolation() -> real
  // sandbox-violations.jsonl file, AND a real (not synthetic) call into
  // shouldAlertForViolation() that genuinely returns true for it.
  it('observes a real credential-path sandbox violation end-to-end into ObservabilityService, and correctly triggers the notification decision', async () => {
    const violationsLogPath = join(TEST_USERDATA_DIR, 'observability-logs', 'sandbox-violations.jsonl')
    try { rmSync(violationsLogPath, { force: true }) } catch { /* fine if absent */ }

    const wasEnabled = observabilityService.isEnabled()
    observabilityService.setPrefs({ observabilityEnabled: true })

    const captured: SandboxViolationTraceEvent[] = []
    const unsubscribe = srtBackend.subscribeToViolations((violation) => {
      captured.push(violation)
      observabilityService.emitSandboxViolation(violation)
    })

    try {
      // Reuses the exact same real credential-path denial as the first test
      // in this file — triggers the OS-level deny that the log monitor
      // (reliably or not) observes.
      const code = `
import os
target = os.path.expanduser('~/.gitconfig')
try:
    with open(target) as f:
        f.read()
except (PermissionError, FileNotFoundError, OSError) as e:
    raise RuntimeError('DENIED_AS_EXPECTED: ' + type(e).__name__) from None
raise AssertionError('SANDBOX_LEAK: read of baseline-denied path succeeded')
`
      const result = await worker.render(code)
      expect(result.success).toBe(false)
      expect(result.error ?? '').toContain('DENIED_AS_EXPECTED')

      // `log stream` has real, non-deterministic latency (confirmed in
      // diagnostics — typically 1-3s). Poll rather than a single fixed wait.
      const deadline = Date.now() + 8_000
      while (captured.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500))
      }

      expect(captured.length).toBeGreaterThan(0)
      const violation = captured[0]
      expect(violation.kind).toBe('read')
      expect(violation.target).toContain('.gitconfig')
      // python-worker is the only spec.command tracked in this test file —
      // proves the callerLabel threaded through spawnPersistent() actually
      // attributes the violation, not just 'unknown'.
      expect(violation.source).toBe('python-worker')

      // The real point of this feature: a genuinely OS-observed credential
      // path denial must be flagged for the in-app alert.
      expect(shouldAlertForViolation(violation)).toBe(true)

      // emitSandboxViolation() is fire-and-forget (mkdir + appendFile
      // promise chain, not awaited by subscribeToViolations' synchronous
      // callback) — poll for the file rather than checking immediately.
      const writeDeadline = Date.now() + 3_000
      while (!existsSync(violationsLogPath) && Date.now() < writeDeadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(existsSync(violationsLogPath)).toBe(true)
      const lines = readFileSync(violationsLogPath, 'utf8').trim().split('\n')
      const entries = lines.map((l) => JSON.parse(l))
      expect(entries.length).toBeGreaterThan(0)
      expect(entries[0]).toMatchObject({
        type: 'sandbox_violation',
        source: 'python-worker',
        kind: 'read',
      })
      expect(entries[0].target).toContain('.gitconfig')
    } finally {
      unsubscribe()
      observabilityService.setPrefs({ observabilityEnabled: wasEnabled })
      try { rmSync(violationsLogPath, { force: true }) } catch { /* best-effort */ }
    }
  }, 30_000)

  it('shouldAlertForViolation fires for other credential paths too (fast unit-style backstop, not a substitute for the real E2E test above)', () => {
    const realisticCredentialViolation: SandboxViolationTraceEvent = {
      source: 'python-worker',
      kind: 'read',
      target: `${process.env['HOME']}/.ssh/id_ed25519`,
      timestamp: Date.now(),
    }
    expect(shouldAlertForViolation(realisticCredentialViolation)).toBe(true)
  })
})
