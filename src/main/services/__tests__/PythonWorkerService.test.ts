import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import { rmSync } from 'fs'

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

  afterAll(() => {
    worker?.stop()
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
})
