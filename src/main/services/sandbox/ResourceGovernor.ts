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

// Rewritten again 2026-09-30: sandboxed commands are spawned through a shell
// (`sh -c "env … sandbox-exec … bash -c '<cmd>'"`), so the pid a caller
// holds may be a thin wrapper whose own RSS never grows — the real worker is
// a descendant. RSS is therefore summed over the watched pid's whole process
// tree, still from ONE `ps` call per tick (every process's pid/ppid/rss).
function tick(): void {
  if (watchers.size === 0) return

  // -o pid=,ppid=,rss= — the trailing `=` suppresses each column header, so
  // stdout is bare "<pid> <ppid> <rss-in-kb>" rows. A watched pid that has
  // exited is simply absent (no special-casing needed); `err` is ignored and
  // only `stdout` is trusted.
  execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], (_err, stdout) => {
    if (!stdout) return
    const rssKb = new Map<number, number>()
    const children = new Map<number, number[]>()
    for (const line of stdout.trim().split('\n')) {
      const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number)
      if (!Number.isFinite(pid) || !Number.isFinite(rss)) continue
      rssKb.set(pid, rss)
      const siblings = children.get(ppid)
      if (siblings) siblings.push(pid)
      else children.set(ppid, [pid])
    }

    for (const [pid, watcher] of [...watchers]) {
      if (!rssKb.has(pid)) continue
      let totalKb = 0
      const stack = [pid]
      const seen = new Set<number>()
      while (stack.length > 0) {
        const p = stack.pop()!
        if (seen.has(p)) continue
        seen.add(p)
        totalKb += rssKb.get(p) ?? 0
        stack.push(...(children.get(p) ?? []))
      }
      if (totalKb / 1024 > watcher.maxRssMb) {
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
 * Wall-clock limit (spec section 09's wallClockKill): calls `onExpired` once
 * after `timeoutMs`. Returns a cancel function. 0 or less = no limit.
 */
export function wallClockWatch(timeoutMs: number, onExpired: () => void): () => void {
  if (!(timeoutMs > 0)) return () => {}
  const handle = setTimeout(onExpired, timeoutMs)
  return () => clearTimeout(handle)
}

/**
 * Start polling the RSS of the given pid's process tree on the shared batched interval.
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
