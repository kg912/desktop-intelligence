import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }))

vi.mock('child_process', () => ({ execFile: mockExecFile }))

// Import AFTER mocks are in place
import { memoryWatch, wallClockWatch } from '../ResourceGovernor'

const POLL_INTERVAL_MS = 5000

/**
 * Mock `ps -A -o pid=,ppid=,rss=` stdout: one "<pid> <ppid> <rssKb>" row per
 * process. Entries without a parent are children of pid 1.
 */
function psStdout(entries: Array<[pid: number, rssMb: number, ppid?: number]>): string {
  return entries.map(([pid, rssMb, ppid = 1]) => `${pid} ${ppid} ${rssMb * 1024}`).join('\n')
}

describe('memoryWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockExecFile.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls on the shared interval (5s) while under the cap', () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: null, stdout: string) => void) =>
      cb(null, psStdout([[123, 100]]))
    )
    const onExceeded = vi.fn()
    const stop = memoryWatch(123, 500, onExceeded)

    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3 + 500)

    expect(mockExecFile).toHaveBeenCalledTimes(3)
    expect(onExceeded).not.toHaveBeenCalled()
    stop()
  })

  it('batches multiple watched pids into a single ps call per tick', () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: null, stdout: string) => void) =>
      cb(null, psStdout([[123, 100], [456, 200]]))
    )
    const onExceeded1 = vi.fn()
    const onExceeded2 = vi.fn()
    const stop1 = memoryWatch(123, 1024, onExceeded1)
    const stop2 = memoryWatch(456, 1024, onExceeded2)

    vi.advanceTimersByTime(POLL_INTERVAL_MS)

    // One shared interval, one execFile call per tick — not one per watcher.
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const [, args] = mockExecFile.mock.calls[0]
    expect(args).toEqual(['-A', '-o', 'pid=,ppid=,rss='])
    expect(onExceeded1).not.toHaveBeenCalled()
    expect(onExceeded2).not.toHaveBeenCalled()
    stop1()
    stop2()
  })

  it('fires onExceeded exactly once when RSS exceeds the cap, then stops watching that pid', () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: null, stdout: string) => void) =>
      cb(null, psStdout([[123, 2000]]))
    )
    const onExceeded = vi.fn()
    memoryWatch(123, 1024, onExceeded)

    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(onExceeded).toHaveBeenCalledTimes(1)
    expect(mockExecFile).toHaveBeenCalledTimes(1)

    // No other watchers remain, so the shared interval is cleared — further
    // time advancement must not re-fire or keep polling.
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 5)
    expect(onExceeded).toHaveBeenCalledTimes(1)
    expect(mockExecFile).toHaveBeenCalledTimes(1)
  })

  it('does not fire when RSS stays under the cap across many polls', () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: null, stdout: string) => void) =>
      cb(null, psStdout([[123, 10]]))
    )
    const onExceeded = vi.fn()
    const stop = memoryWatch(123, 1024, onExceeded)

    vi.advanceTimersByTime(POLL_INTERVAL_MS * 10)

    expect(onExceeded).not.toHaveBeenCalled()
    expect(mockExecFile).toHaveBeenCalledTimes(10)
    stop()
  })

  it('the returned stop function prevents any further firing', () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: null, stdout: string) => void) =>
      cb(null, psStdout([[123, 2000]]))
    )
    const onExceeded = vi.fn()
    const stop = memoryWatch(123, 1024, onExceeded)

    // Stop before the first tick ever fires.
    stop()
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 10)

    expect(onExceeded).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('ignores ps errors/empty output rather than firing onExceeded', () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: Error, stdout?: string) => void) =>
      cb(new Error('ps: process id too large'), '')
    )
    const onExceeded = vi.fn()
    const stop = memoryWatch(123, 1024, onExceeded)

    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3)

    expect(onExceeded).not.toHaveBeenCalled()
    stop()
  })

  it('silently drops a pid missing from ps output (process already exited) without firing', () => {
    // Two watchers, but ps only reports one — matches real `ps` behavior
    // when a watched pid has already exited (omitted, not an error).
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: null, stdout: string) => void) =>
      cb(null, psStdout([[123, 100]]))
    )
    const onExceeded123 = vi.fn()
    const onExceeded456 = vi.fn()
    const stop1 = memoryWatch(123, 1024, onExceeded123)
    const stop2 = memoryWatch(456, 1024, onExceeded456)

    vi.advanceTimersByTime(POLL_INTERVAL_MS)

    expect(onExceeded123).not.toHaveBeenCalled()
    expect(onExceeded456).not.toHaveBeenCalled()
    stop1()
    stop2()
  })

  it('sums RSS over the watched pid descendants (sandbox-exec/shell wrappers)', () => {
    // 123 is a thin shell; its grandchild 789 holds the memory.
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: null, stdout: string) => void) =>
      cb(null, psStdout([[123, 2], [456, 3, 123], [789, 700, 456], [999, 5000]]))
    )
    const onExceeded = vi.fn()
    memoryWatch(123, 512, onExceeded)

    vi.advanceTimersByTime(POLL_INTERVAL_MS)

    // 2 + 3 + 700 MB > 512; unrelated pid 999 is not counted toward it.
    expect(onExceeded).toHaveBeenCalledTimes(1)
  })

  it('does not count unrelated processes toward a watched tree', () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: null, stdout: string) => void) =>
      cb(null, psStdout([[123, 100], [456, 100, 123], [999, 5000]]))
    )
    const onExceeded = vi.fn()
    const stop = memoryWatch(123, 512, onExceeded)

    vi.advanceTimersByTime(POLL_INTERVAL_MS * 2)

    expect(onExceeded).not.toHaveBeenCalled()
    stop()
  })
})

describe('wallClockWatch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires once after the timeout', () => {
    const onExpired = vi.fn()
    wallClockWatch(1000, onExpired)
    vi.advanceTimersByTime(999)
    expect(onExpired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('cancel prevents firing, and 0 means no limit', () => {
    const cancelled = vi.fn()
    const unlimited = vi.fn()
    wallClockWatch(1000, cancelled)()
    wallClockWatch(0, unlimited)
    vi.advanceTimersByTime(60_000)
    expect(cancelled).not.toHaveBeenCalled()
    expect(unlimited).not.toHaveBeenCalled()
  })
})
