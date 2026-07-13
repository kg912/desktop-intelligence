// ResourceGovernor — lightweight resource enforcement for persistent workers.
//
// spec section 09: srt provides no CPU/memory/disk quota mechanism.  This is a
// lightweight wall-clock + RSS-polling governor for the persistent Python worker
// process.  It polls the worker's RSS every 1s and calls a callback when the
// cap is exceeded.
//
// The existing per-request WORKER_TIMEOUT_MS / queue timeout logic in
// PythonWorkerService already covers wall-clock timeout per render — this
// governor is only for the PERSISTENT worker process lifetime, not per-request.

import pidusage from 'pidusage'

/**
 * Start polling the given pid's RSS every 1s.
 * If RSS exceeds `maxRssMb`, calls `onExceeded` ONCE and stops.
 * Returns a stop function that clears the interval.
 */
export function memoryWatch(
  pid: number,
  maxRssMb: number,
  onExceeded: () => void
): () => void {
  let fired = false
  const interval = setInterval(() => {
    if (fired) return
    pidusage(pid, (err: Error | null, stats: { memory?: number }) => {
      if (err || fired) return
      const rssMb = (stats.memory ?? 0) / (1024 * 1024)
      if (rssMb > maxRssMb) {
        fired = true
        clearInterval(interval)
        onExceeded()
      }
    })
  }, 1000)

  return () => {
    fired = true
    clearInterval(interval)
  }
}