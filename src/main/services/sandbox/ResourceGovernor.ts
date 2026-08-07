// ResourceGovernor — lightweight resource enforcement for persistent workers.
//
// spec section 09: srt provides no CPU/memory/disk quota mechanism.  This is a
// lightweight RSS-polling governor for persistent worker/server processes
// (the Python worker + every sandboxed MCP stdio server).  It polls watched
// pids' RSS on a single shared interval and calls a callback when a pid's
// cap is exceeded.
//
// Rewritten 2026-07-18 (see progress.md): the original implementation ran
// one independent `pidusage` poll per watched pid on a 1s interval each —
// profiled at ~10 child_process.spawn calls/sec sustained for the app's
// entire session (one per watcher per tick), a continuous background cost
// that didn't exist before the sandbox branch. This version batches every
// watched pid into a single `ps -o pid=,rss=` call per tick on one shared
// interval, and widens the interval to 5s — RSS drift over 5s doesn't
// matter for a local single-user desktop app's OOM-guard use case, and
// this isn't a hard real-time constraint. Net effect: from N pids * 1
// spawn/sec down to 1 spawn per 5s regardless of how many pids are watched.
//
// The existing per-request WORKER_TIMEOUT_MS / queue timeout logic in
// PythonWorkerService already covers wall-clock timeout per render — this
// governor is only for the PERSISTENT worker/server process lifetime, not
// per-request.

import { execFile } from 'child_process'

const POLL_INTERVAL_MS = 5000

interface Watcher {
  maxRssMb: number
  onExceeded: () => void
}

const watchers = new Map<number, Watcher>()
let intervalHandle: ReturnType<typeof setInterval> | null = null

function tick(): void {
  const pids = [...watchers.keys()]
  if (pids.length === 0) return

  // -o pid=,rss= — the trailing `=` on each keyword suppresses that
  // column's header, so stdout is bare "<pid> <rss-in-kb>" rows, one per
  // pid. A pid that exited between the previous tick and now is simply
  // omitted from the output (verified: not an error, exit code 0) — no
  // special-casing needed for that, which is why `err` itself is ignored
  // below and only `stdout` is trusted.
  execFile('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], (_err, stdout) => {
    if (!stdout) return
    for (const line of stdout.trim().split('\n')) {
      const [pidStr, rssKbStr] = line.trim().split(/\s+/)
      const pid = Number(pidStr)
      const rssMb = Number(rssKbStr) / 1024
      const watcher = watchers.get(pid)
      if (!watcher || !Number.isFinite(rssMb)) continue
      if (rssMb > watcher.maxRssMb) {
        watchers.delete(pid)
        stopIntervalIfIdle()
        watcher.onExceeded()
      }
    }
  })
}

function stopIntervalIfIdle(): void {
  if (watchers.size === 0 && intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

/**
 * Start polling the given pid's RSS on the shared batched interval.
 * If RSS exceeds `maxRssMb`, calls `onExceeded` ONCE and stops watching it.
 * Returns a stop function that unregisters this pid early.
 */
export function memoryWatch(
  pid: number,
  maxRssMb: number,
  onExceeded: () => void
): () => void {
  watchers.set(pid, { maxRssMb, onExceeded })
  if (!intervalHandle) {
    intervalHandle = setInterval(tick, POLL_INTERVAL_MS)
  }

  return () => {
    watchers.delete(pid)
    stopIntervalIfIdle()
  }
}
