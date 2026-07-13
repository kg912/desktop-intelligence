import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockPidusage } = vi.hoisted(() => ({ mockPidusage: vi.fn() }))

vi.mock('pidusage', () => ({ default: mockPidusage, __esModule: true }))

// Import AFTER mocks are in place
import { memoryWatch } from '../ResourceGovernor'

const MB = 1024 * 1024

describe('memoryWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockPidusage.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls pidusage roughly every 1s while under the cap', () => {
    mockPidusage.mockImplementation((_pid: number, cb: (err: null, stats: { memory: number }) => void) =>
      cb(null, { memory: 100 * MB })
    )
    const onExceeded = vi.fn()
    const stop = memoryWatch(123, 500, onExceeded)

    vi.advanceTimersByTime(3_500)

    expect(mockPidusage).toHaveBeenCalledTimes(3)
    expect(onExceeded).not.toHaveBeenCalled()
    stop()
  })

  it('fires onExceeded exactly once when RSS exceeds the cap, then stops polling', () => {
    mockPidusage.mockImplementation((_pid: number, cb: (err: null, stats: { memory: number }) => void) =>
      cb(null, { memory: 2_000 * MB })
    )
    const onExceeded = vi.fn()
    memoryWatch(123, 1024, onExceeded)

    vi.advanceTimersByTime(1_000)
    expect(onExceeded).toHaveBeenCalledTimes(1)
    expect(mockPidusage).toHaveBeenCalledTimes(1)

    // Further ticks must not re-fire or keep polling — the interval is
    // cleared internally the moment the cap is exceeded.
    vi.advanceTimersByTime(5_000)
    expect(onExceeded).toHaveBeenCalledTimes(1)
    expect(mockPidusage).toHaveBeenCalledTimes(1)
  })

  it('does not fire when RSS stays under the cap across many polls', () => {
    mockPidusage.mockImplementation((_pid: number, cb: (err: null, stats: { memory: number }) => void) =>
      cb(null, { memory: 10 * MB })
    )
    const onExceeded = vi.fn()
    const stop = memoryWatch(123, 1024, onExceeded)

    vi.advanceTimersByTime(10_000)

    expect(onExceeded).not.toHaveBeenCalled()
    expect(mockPidusage).toHaveBeenCalledTimes(10)
    stop()
  })

  it('the returned stop function prevents any further firing', () => {
    mockPidusage.mockImplementation((_pid: number, cb: (err: null, stats: { memory: number }) => void) =>
      cb(null, { memory: 2_000 * MB })
    )
    const onExceeded = vi.fn()
    const stop = memoryWatch(123, 1024, onExceeded)

    // Stop before the first tick ever fires.
    stop()
    vi.advanceTimersByTime(10_000)

    expect(onExceeded).not.toHaveBeenCalled()
    expect(mockPidusage).not.toHaveBeenCalled()
  })

  it('ignores pidusage errors rather than firing onExceeded', () => {
    mockPidusage.mockImplementation((_pid: number, cb: (err: Error, stats?: undefined) => void) =>
      cb(new Error('ESRCH: no such process'))
    )
    const onExceeded = vi.fn()
    const stop = memoryWatch(123, 1024, onExceeded)

    vi.advanceTimersByTime(3_000)

    expect(onExceeded).not.toHaveBeenCalled()
    stop()
  })
})
