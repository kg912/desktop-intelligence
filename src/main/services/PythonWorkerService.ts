/**
 * PythonWorkerService
 *
 * Manages a single persistent python3 worker process for the app lifetime.
 * The worker pre-imports matplotlib/numpy/scipy at startup, eliminating
 * the 2–4s cold-start cost on every chart render.
 *
 * Protocol: newline-delimited JSON over stdin/stdout.
 *   Request:  { code: string }
 *   Response: { success: boolean, imageBase64?: string, error?: string }
 *
 * Multiple concurrent render() calls are queued (FIFO) rather than falling
 * back to slow one-shot spawns. The Python worker is single-threaded so
 * requests are processed one at a time, but they don't pay cold-start cost.
 *
 * The worker is now spawned inside the srt sandbox (Phase 0/1). The regex
 * blocklist validatePythonCode() has been deleted — the sandbox is the
 * enforcement mechanism.  yfinance network access is allowlisted to the
 * empirically discovered minimum hostnames (query1.finance.yahoo.com,
 * query2.finance.yahoo.com, fc.yahoo.com — determined 2026-07-13 via
 * scripts/spike-sandbox-yf-hosts.ts).
 */

import { execSync, ChildProcessWithoutNullStreams } from 'child_process'
import * as path from 'path'
import { app } from 'electron'
import { mkdirSync } from 'fs'
import { sandboxService } from './sandbox/sandboxServiceInstance'
import { memoryWatch } from './sandbox/ResourceGovernor'

// ── yfinance hostnames — empirically determined 2026-07-13 ──────────────────
// spike-sandbox-yf-hosts.ts tested deny-all → query1-only → query1+query2 →
// query1+fc → query1+query2+fc.  ALL THREE are required for yfinance to
// function.  These are NOT copied from documentation — they were verified by
// running yf.Ticker("AAPL").history(period="1d") inside the srt sandbox with
// progressively narrower allowlists until the minimum set was found.
const YFINANCE_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'fc.yahoo.com',
]

const WORKER_TIMEOUT_MS = 30_000
const READY_TIMEOUT_MS  = 15_000

interface QueueItem {
  code: string
  resolve: (result: { success: boolean; imageBase64?: string; error?: string }) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

export class PythonWorkerService {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready    = false
  private stopping = false
  private buffer   = ''

  // FIFO queue — requests wait here while the worker is busy
  private queue: QueueItem[] = []
  private processing = false

  // The resolve/timeout for the request currently being processed
  private _activeResolve: ((result: { success: boolean; imageBase64?: string; error?: string }) => void) | null = null
  private _activeTimeout: ReturnType<typeof setTimeout> | null = null

  private readyResolve: (() => void)          | null = null
  private readyReject:  ((err: Error) => void) | null = null

  // ResourceGovernor stop handle — cleared when the worker exits
  private _stopMemoryWatch: (() => void) | null = null

  // Scratch directory for the worker's sandbox workspace — created once
  // at startup and reused for the worker lifetime.
  private _scratchDir: string = ''

  /** Path to worker_harness.py — works in both dev and packaged app. */
  private getWorkerPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'python', 'worker_harness.py')
    }
    return path.join(app.getAppPath(), 'resources', 'python', 'worker_harness.py')
  }

  /** Start the worker. Resolves when the worker signals ready. */
  async start(): Promise<void> {
    if (this.proc) return  // already running

    // ── yfinance pre-install: UNSANDBOXED ───────────────────────────────
    // The package name "yfinance" is a hardcoded app constant, not
    // LLM-controlled input.  It is outside the threat model (spec
    // section 02) — this is a deliberate scope boundary, not an oversight.
    try {
      execSync('python3 -c "import yfinance"', { timeout: 5_000, stdio: 'ignore' })
      console.log('[PythonWorker] yfinance already installed')
    } catch {
      console.log('[PythonWorker] Installing yfinance...')
      try {
        execSync('pip3 install yfinance --break-system-packages --quiet', {
          timeout: 60_000,
          stdio: 'ignore',
        })
        console.log('[PythonWorker] yfinance installed successfully')
      } catch (installErr) {
        console.warn('[PythonWorker] yfinance install failed — finance charts unavailable:', installErr)
        // Non-fatal: worker still starts; yfinance-dependent charts will error gracefully
      }
    }

    // ── Scratch directory for sandbox workspace ──────────────────────────
    this._scratchDir = path.join(app.getPath('userData'), 'sandboxes', 'python-worker')
    mkdirSync(this._scratchDir, { recursive: true })

    const workerPath = this.getWorkerPath()
    // workerPath is a fixed app-resource path (getWorkerPath()) — it never
    // contains anything derived from user/LLM input, so building the
    // command string this way is safe (spec section 08).
    const command = `python3 ${workerPath}`

    console.log('[PythonWorker] Starting sandboxed worker:', workerPath)

    try {
      this.proc = await sandboxService.spawnPersistent({
        workspaceDir:     this._scratchDir,
        command,
        executionProfile: 'lightweight',
        allowedDomains:   YFINANCE_HOSTS,
        allowWrite:       [this._scratchDir],
        denyRead:         [],
        env: {
          MPLBACKEND: 'Agg',
          // Point matplotlib's font cache at the scratch dir so it doesn't
          // try to write to ~/.matplotlib (which is deny-write-by-default
          // under srt).
          MPLCONFIGDIR: this._scratchDir,
        },
        timeoutMs: 0,       // no wall-clock timeout — persistent process
        maxRssMb:  1024,    // 1 GB RSS cap
      })
    } catch (err) {
      console.error('[PythonWorker] Sandbox spawn failed:', err)
      throw err
    }

    // ── ResourceGovernor: memory watchdog for the persistent worker ──────
    if (this.proc.pid) {
      this._stopMemoryWatch = memoryWatch(
        this.proc.pid,
        1024, // 1 GB RSS cap
        () => {
          console.warn('[PythonWorker] RSS exceeded 1 GB — killing worker')
          this.proc?.kill()
        }
      )
    }

    this.proc.stderr.on('data', (d: Buffer) => {
      console.log('[PythonWorker stderr]', d.toString().trimEnd())
    })

    this.proc.stdout.on('data', (d: Buffer) => {
      this.buffer += d.toString()
      // Process all complete lines — a single data event may contain multiple.
      let newlineIdx: number
      while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim()
        this.buffer = this.buffer.slice(newlineIdx + 1)
        if (!line) continue

        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(line)
        } catch {
          console.error('[PythonWorker] Invalid JSON from worker:', line)
          continue
        }

        // Ready signal
        if (parsed['ready'] && this.readyResolve) {
          console.log('[PythonWorker] Worker ready ✅')
          this.ready = true
          this.readyResolve()
          this.readyResolve = null
          this.readyReject  = null
          continue
        }

        // Chart render response — resolve the active request and process next
        if (this._activeResolve) {
          if (this._activeTimeout) { clearTimeout(this._activeTimeout); this._activeTimeout = null }
          const resolve = this._activeResolve
          this._activeResolve = null
          this.processing = false
          resolve(parsed as { success: boolean; imageBase64?: string; error?: string })
          // Immediately pick up the next queued request
          this.processNext()
        }
      }
    })

    this.proc.on('close', (code) => {
      console.warn('[PythonWorker] Worker exited with code', code)

      // Stop the memory watchdog
      if (this._stopMemoryWatch) {
        this._stopMemoryWatch()
        this._stopMemoryWatch = null
      }

      this.proc  = null
      this.ready = false

      if (this.readyReject) {
        this.readyReject(new Error(`Worker exited during startup with code ${code}`))
        this.readyResolve = null
        this.readyReject  = null
      }

      // Reject the active in-flight request
      if (this._activeResolve) {
        if (this._activeTimeout) { clearTimeout(this._activeTimeout); this._activeTimeout = null }
        this._activeResolve({ success: false, error: 'Python worker exited unexpectedly' })
        this._activeResolve = null
      }

      // Drain the queue — every waiting request gets an error response
      const draining = [...this.queue]
      this.queue = []
      this.processing = false
      for (const item of draining) {
        clearTimeout(item.timeoutHandle)
        item.resolve({ success: false, error: 'Python worker exited unexpectedly' })
      }

      // Auto-restart on unexpected crash (not triggered by our own stop() call).
      if (!this.stopping && code !== 0) {
        console.warn('[PythonWorker] Unexpected crash — restarting in 1s')
        setTimeout(() => this.start().catch(console.error), 1000)
      }
    })

    this.proc.on('error', (err) => {
      console.error('[PythonWorker] Spawn error:', err.message)
      if (this._stopMemoryWatch) {
        this._stopMemoryWatch()
        this._stopMemoryWatch = null
      }
      this.proc  = null
      this.ready = false
      if (this.readyReject) {
        this.readyReject(err)
        this.readyResolve = null
        this.readyReject  = null
      }
    })

    return new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject  = reject
      setTimeout(() => {
        if (!this.ready) {
          reject(new Error('Python worker did not become ready within 15s'))
          this.readyResolve = null
          this.readyReject  = null
        }
      }, READY_TIMEOUT_MS)
    })
  }

  /** Stop the worker gracefully. */
  stop(): void {
    if (!this.proc) return
    this.stopping = true
    if (this._stopMemoryWatch) {
      this._stopMemoryWatch()
      this._stopMemoryWatch = null
    }
    try {
      this.proc.stdin.write(JSON.stringify({ cmd: 'exit' }) + '\n')
    } catch { /* ignore if stdin already closed */ }
    const proc = this.proc
    setTimeout(() => { proc.kill(); this.stopping = false }, 1000)
    this.proc  = null
    this.ready = false
  }

  /** Restart the worker (e.g. after a timeout or unexpected crash). */
  async restart(): Promise<void> {
    this.stop()
    await new Promise(r => setTimeout(r, 500))
    await this.start()
  }

  /**
   * Render a matplotlib code block.
   * Requests are queued (FIFO) so multiple charts in one response all use
   * the warm persistent worker rather than falling back to cold spawns.
   * Falls back to one-shot spawn only if the worker is not yet ready.
   */
  async render(userCode: string): Promise<{ success: boolean; imageBase64?: string; error?: string }> {
    if (!this.ready || !this.proc) {
      console.warn('[PythonWorker] Worker not ready — falling back to one-shot spawn')
      return this.fallbackRender(userCode)
    }

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        // Remove from queue if still waiting (hasn't been picked up yet)
        const idx = this.queue.findIndex(q => q.resolve === resolve)
        if (idx !== -1) {
          this.queue.splice(idx, 1)
          console.error('[PythonWorker] Queued request timed out before execution')
          resolve({ success: false, error: 'Chart render timed out after 30s' })
          return
        }
        // It was the active request — resolve it and restart the worker
        console.error('[PythonWorker] Active request timed out — restarting worker')
        if (this._activeTimeout) { clearTimeout(this._activeTimeout); this._activeTimeout = null }
        this._activeResolve = null
        this.processing = false
        resolve({ success: false, error: 'Chart render timed out after 30s' })
        this.restart().catch(console.error)
      }, WORKER_TIMEOUT_MS)

      this.queue.push({ code: userCode, resolve, timeoutHandle })
      console.log(`[PythonWorker] Queued render request (queue depth: ${this.queue.length})`)
      this.processNext()
    })
  }

  /** Pull the next item from the queue and send it to the worker. */
  private processNext(): void {
    if (this.processing || this.queue.length === 0 || !this.proc || !this.ready) return

    const next = this.queue.shift()!
    this.processing = true
    this._activeResolve = next.resolve
    this._activeTimeout = next.timeoutHandle

    console.log(`[PythonWorker] Processing render (${this.queue.length} remaining in queue)`)
    try {
      this.proc.stdin.write(JSON.stringify({ code: next.code }) + '\n')
    } catch (err) {
      clearTimeout(next.timeoutHandle)
      this._activeResolve = null
      this._activeTimeout = null
      this.processing = false
      next.resolve({ success: false, error: `Failed to send to worker: ${err}` })
      this.processNext()
    }
  }

  /**
   * One-shot fallback — writes code to a file, never shell-interpolated,
   * and runs it inside the srt sandbox via sandboxService.run().
   * The scratch file is deleted after the run completes (success or failure).
   */
  private async fallbackRender(userCode: string): Promise<{ success: boolean; imageBase64?: string; error?: string }> {
    const { writeFileSync, unlinkSync } = await import('fs')

    const PREAMBLE = `import sys, io, base64, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
try:
    import scipy
    from scipy import stats as scipy_stats
except ImportError:
    pass
plt.rcParams.update({'figure.facecolor':'#0f0f0f','axes.facecolor':'#141414',
    'text.color':'#f5f5f5','axes.labelcolor':'#a3a3a3',
    'axes.prop_cycle':plt.cycler(color=['#f87171','#60a5fa','#86efac','#fb923c']),
    'figure.figsize':(10,6)})
_real_savefig=plt.savefig; _real_close=plt.close
plt.show=lambda*a,**kw:None; plt.savefig=lambda*a,**kw:None; plt.close=lambda*a,**kw:None
`
    const EPILOGUE = `
try:
    plt.gcf().tight_layout()
except Exception:
    pass
_buf=io.BytesIO()
_real_savefig(_buf,format='png',dpi=150,bbox_inches='tight',facecolor='#0f0f0f')
_buf.seek(0)
sys.stdout.buffer.write(base64.b64encode(_buf.read()))
_real_close('all')
`

    // Write code to a fixed-name file — NEVER interpolate LLM output into the
    // shell command string (spec section 08).
    const fallbackDir = this._scratchDir || path.join(app.getPath('userData'), 'sandboxes', 'python-worker')
    const scratchFile = path.join(fallbackDir, `_fallback_${Date.now()}.py`)
    writeFileSync(scratchFile, PREAMBLE + userCode + EPILOGUE, 'utf8')

    let result: { success: boolean; imageBase64?: string; error?: string }
    try {
      const runResult = await sandboxService.run({
        workspaceDir:     fallbackDir,
        command:          `python3 ${scratchFile}`,
        executionProfile: 'lightweight',
        allowedDomains:   YFINANCE_HOSTS,
        allowWrite:       [fallbackDir],
        denyRead:         [],
        env:              { MPLBACKEND: 'Agg' },
        timeoutMs:        WORKER_TIMEOUT_MS,
        maxRssMb:         512,
      })

      if (runResult.exitCode === 0 && runResult.stdout.length > 0) {
        result = { success: true, imageBase64: runResult.stdout.trim() }
      } else {
        const lines = runResult.stderr.trim().split('\n')
        result = {
          success: false,
          error: lines.filter(l => l.trim()).at(-1) ?? `exited ${runResult.exitCode}`
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result = {
        success: false,
        error: msg.includes('python3')
          ? 'python3 not found. Install Python 3 + matplotlib to render charts.'
          : msg
      }
    }

    // Clean up — don't leave generated code sitting on disk.
    try { unlinkSync(scratchFile) } catch {}

    return result
  }
}

export const pythonWorker = new PythonWorkerService()