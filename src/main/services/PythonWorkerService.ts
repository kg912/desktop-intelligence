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
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import * as path from 'path'
import { app } from 'electron'

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

    const workerPath = this.getWorkerPath()
    console.log('[PythonWorker] Starting worker:', workerPath)

    this.proc = spawn('python3', [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MPLBACKEND: 'Agg' },
    })

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

  /** One-shot fallback — minimal preamble, same stdout-based base64 output. */
  private async fallbackRender(userCode: string): Promise<{ success: boolean; imageBase64?: string; error?: string }> {
    const { spawn: spawnFn } = await import('child_process')
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
    return new Promise((resolve) => {
      const proc = spawnFn('python3', ['-c', PREAMBLE + userCode + EPILOGUE], {
        timeout: WORKER_TIMEOUT_MS,
        env: { ...process.env, MPLBACKEND: 'Agg' },
      })
      const chunks: Buffer[] = []
      const errChunks: string[] = []
      proc.stdout.on('data', (d: Buffer) => chunks.push(d))
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d.toString()))
      proc.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          resolve({ success: true, imageBase64: Buffer.concat(chunks).toString('ascii') })
        } else {
          const lines = errChunks.join('').trim().split('\n')
          resolve({ success: false, error: lines.filter(l => l.trim()).at(-1) ?? `exited ${code}` })
        }
      })
      proc.on('error', (err: Error) => {
        resolve({ success: false, error: err.message.includes('ENOENT')
          ? 'python3 not found. Install Python 3 + matplotlib to render charts.'
          : err.message })
      })
    })
  }
}

export const pythonWorker = new PythonWorkerService()
