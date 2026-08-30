/**
 * MTPLXDaemonManager
 *
 * Manages the `mtplx` CLI child process that controls MTPLX's local
 * OpenAI-compatible server (https://github.com/youssofal/MTPLX).
 *
 * Structurally mirrors LMSDaemonManager, with three deliberate differences:
 *
 *   1. NO MODEL-LOAD STEP. LM Studio needs a separate `lms load <modelId>` call;
 *      MTPLX's model selection lives entirely in the MTPLX app/CLI's own config
 *      and is not something DI drives. Once the server answers /health we are
 *      'ready'.
 *
 *   2. OWNERSHIP-TRACKED SHUTDOWN. See `spawnedByUs` below.
 *
 *   3. FIRE-AND-FORGET SPAWN. See the warning below — this is the one that bites.
 *
 * ⚠️  `mtplx serve` IS A LONG-RUNNING FOREGROUND PROCESS. ⚠️
 *
 * It does NOT fork-and-exit the way `lms server start` does — it holds the
 * terminal and stays attached for the life of the server (hence its own
 * `--no-stats-footer` flag, which suppresses the live-updating dashboard it
 * otherwise redraws on stdout).
 *
 * Consequently the LMSDaemonManager-style one-shot `runCommand()` helper —
 * spawn, await the child's 'close' event, resolve — is WRONG here and must not
 * be reintroduced. Awaiting 'close' on a process that never closes hangs until
 * the timeout guard fires, which then SIGTERMs the freshly-started server and
 * reports a false failure, turning every cold start into an error. `spawnServer()`
 * below therefore spawns and returns immediately; readiness is established by
 * polling /health, never by waiting on process exit.
 *
 * Architecture:
 *   1. Pre-flight → GET /health; if 200 the server is already up, skip start
 *   2. Start      → spawn `mtplx serve --port <port> --no-stats-footer`
 *                   FIRE-AND-FORGET — the process stays alive; do not await it
 *   3. Ready      → poll GET /health until the server answers
 *   4. Cleanup    → on quit, `mtplx stop` — but ONLY if we started the server
 */

import { spawn, execFileSync, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import axios from 'axios'
import type { DaemonState, DaemonPhase } from '../../shared/types'
import { readSettings } from '../services/SettingsStore'

const MTPLX_CANDIDATES = [
  '/opt/homebrew/bin/mtplx',  // Homebrew, Apple Silicon
  '/usr/local/bin/mtplx',     // Homebrew, Intel
  'mtplx',                    // PATH fallback
]

const MTPLX_DEFAULT_BASE_URL = 'http://localhost:8000'
const MTPLX_DEFAULT_PORT     = 8000
const PREFLIGHT_TIMEOUT_MS   = 4_000

/**
 * Parse the port out of the saved mtplxBaseUrl. Falls back to 8000 when the
 * setting is absent or unparseable — the port is user-configurable in MTPLX,
 * so the saved value is authoritative whenever it exists.
 */
export function resolveMtplxPort(baseUrl?: string): number {
  const raw = baseUrl ?? MTPLX_DEFAULT_BASE_URL
  try {
    const parsed = new URL(raw)
    if (parsed.port) {
      const port = Number(parsed.port)
      if (Number.isInteger(port) && port > 0 && port < 65536) return port
    }
    // No explicit port in the URL — fall back to the protocol default.
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return MTPLX_DEFAULT_PORT
  }
}

export class MTPLXDaemonManager extends EventEmitter {
  private state: DaemonState = {
    phase:  'idle',
    error:  null,
    stderr: null
  }

  // Active child processes — tracked so we can kill them on quit
  private activeChildren: Set<ChildProcess> = new Set()
  private mtplxBin: string | null = null

  /**
   * True only when THIS manager instance spawned the MTPLX server itself.
   *
   * MTPLX ships a GUI app that is a full chat interface in its own right, which
   * the user may be running independently of Desktop Intelligence. `mtplx serve`
   * attaches to an already-listening server rather than double-loading the model,
   * so DI can end up talking to a server it did not start.
   *
   * Unlike LMSDaemonManager.shutdown() — which kills unconditionally whenever a
   * binary was found — shutdown() here runs `mtplx stop` ONLY when this is true.
   * DI must never kill a server it did not start; doing so would tear the model
   * out from under the user's own MTPLX session on quit.
   */
  private spawnedByUs = false

  /**
   * Set by spawnServer()'s async 'error' / early-'close' handlers. Because the
   * spawn is fire-and-forget there is no Promise for those events to reject, so
   * the reason is parked here and reported by waitForServerUp() — which would
   * otherwise fail with a generic "did not become reachable" after the full
   * poll window, hiding an ENOENT or an immediate crash.
   */
  private spawnError: string | null = null

  constructor() {
    super()
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  getState(): DaemonState {
    return { ...this.state }
  }

  /** Exposed for tests and diagnostics — did this instance start the server? */
  didSpawnServer(): boolean {
    return this.spawnedByUs
  }

  /**
   * Main entry point. Call once after the window is shown.
   * There is no modelId parameter — DI does not drive MTPLX's model selection.
   */
  async start(): Promise<void> {
    this.mtplxBin = this.findMtplxBinary()

    if (!this.mtplxBin) {
      // mtplx CLI not installed — that's fine, the MTPLX GUI app may already be
      // running its server. Fall through to pure HTTP polling in
      // mtplxConnectionManager.
      console.log('[MTPLXDaemon] mtplx binary not found — skipping daemon management, relying on HTTP poll.')
      return
    }

    console.log(`[MTPLXDaemon] Using mtplx binary: ${this.mtplxBin}`)

    try {
      await this.runPreflightAndStart()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.transition('error', msg)
    }
  }

  /**
   * User-triggered retry (e.g. after an error).
   * Kills any stale children before re-attempting.
   */
  async retry(): Promise<void> {
    this.killAllChildren()
    this.transition('idle')
    await this.start()
  }

  /**
   * Graceful shutdown — called from app `before-quit`.
   *
   * Safe to call unconditionally: no-ops when start() was never called
   * (mtplxBin stays null) and when the server was externally managed
   * (spawnedByUs === false).
   */
  async shutdown(): Promise<void> {
    this.killAllChildren()

    if (!this.mtplxBin) return

    if (!this.spawnedByUs) {
      // The server was already listening when we did our pre-flight, so it
      // belongs to the MTPLX app (or an earlier CLI invocation) — not to us.
      // Stopping it would kill the user's own MTPLX session.
      console.log('[MTPLXDaemon] Shutdown: MTPLX server was externally managed — skipping `mtplx stop`.')
      return
    }

    console.log('[MTPLXDaemon] Shutdown: running mtplx stop')
    try {
      execFileSync(this.mtplxBin, ['stop'], { timeout: 10_000 })
    } catch (e) {
      console.warn('[MTPLXDaemon] mtplx stop failed (possibly already stopped):', e)
    }
  }

  // ----------------------------------------------------------------
  // Internal lifecycle
  // ----------------------------------------------------------------

  private async runPreflightAndStart(): Promise<void> {
    const port = this.resolvePort()
    // Fresh attempt — discard any failure recorded by a previous start()/retry().
    this.spawnError = null

    // 1. Pre-flight: is the server already up?
    this.transition('preflight')
    const alreadyRunning = await this.pingServer(port)

    if (alreadyRunning) {
      // Someone else owns this server — record that so shutdown() leaves it alone.
      this.spawnedByUs = false
      console.log(`[MTPLXDaemon] Pre-flight: server already running on port ${port} — skipping \`mtplx serve\`.`)
      this.transition('ready')
      return
    }

    // 2. Server not running — start it.
    //    NOT `mtplx start`, which launches the interactive wizard.
    //    NOT awaited: `mtplx serve` is a persistent foreground process and never
    //    exits on its own. See the warning in the class docstring.
    this.spawnServer(port)

    // 3. Readiness comes from polling /health, not from process exit.
    //    Throws if the server never answers, which surfaces as phase 'error'.
    await this.waitForServerUp(port)

    // 4. A server we started is confirmed up — from here shutdown() owns it.
    //    Set only after the health check passes, so a spawn that never produced
    //    a working server does not arm `mtplx stop`. Any spawned child is still
    //    cleaned up unconditionally by killAllChildren().
    this.spawnedByUs = true

    // 5. No model-load step — MTPLX manages its own model selection.
    this.transition('ready')
  }

  private resolvePort(): number {
    try {
      return resolveMtplxPort(readSettings().mtplxBaseUrl)
    } catch {
      return MTPLX_DEFAULT_PORT
    }
  }

  private async pingServer(port: number): Promise<boolean> {
    try {
      const res = await axios.get(`http://127.0.0.1:${port}/health`, { timeout: PREFLIGHT_TIMEOUT_MS })
      return res.status === 200
    } catch {
      return false
    }
  }

  private async waitForServerUp(port: number, maxAttempts = 20, intervalMs = 500): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      if (await this.pingServer(port)) return
      // The spawn failed outright or the server died — no point polling out the
      // rest of the window for a process that is already gone.
      if (this.spawnError) throw new Error(this.spawnError)
      await sleep(intervalMs)
    }
    throw new Error(
      this.spawnError ??
      'MTPLX server did not become reachable after `mtplx serve`. Check MTPLX logs.',
    )
  }

  /**
   * Spawns the long-running `mtplx serve` process and returns IMMEDIATELY.
   *
   * There is deliberately no Promise here and nothing to await. `mtplx serve`
   * holds the foreground for the life of the server, so any helper that resolves
   * on the child's 'close' event would never settle — see the warning in the
   * class docstring. Readiness is established by the caller polling /health.
   *
   * The child is registered in activeChildren so killAllChildren() (and through
   * it retry() and shutdown()) still tears it down.
   */
  private spawnServer(port: number): void {
    this.transition('starting-server')

    const bin = this.mtplxBin!
    // --no-stats-footer suppresses MTPLX's live-updating terminal dashboard,
    // which would otherwise flood the piped stdout with redraw sequences.
    const args = ['serve', '--port', String(port), '--no-stats-footer']

    console.log(`[MTPLXDaemon] Spawning long-running server: ${bin} ${args.join(' ')}`)

    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    })

    this.activeChildren.add(child)

    // ── stdout (informational)
    child.stdout?.on('data', (data: Buffer) => {
      console.log(`[MTPLXDaemon stdout] ${data.toString().trim()}`)
    })

    // ── stderr: log and relay to renderer
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      console.error(`[MTPLXDaemon stderr] ${line}`)
      this.state.stderr = line
      this.emit('stateChange', this.getState())
    })

    // ── spawn error (binary not executable, permission denied, etc.)
    // A ChildProcess with no 'error' listener THROWS on this event, so the
    // handler is mandatory even though nothing awaits it. The message is
    // recorded for waitForServerUp() to report instead of its generic timeout.
    child.on('error', (err) => {
      this.activeChildren.delete(child)
      this.spawnError = `Failed to spawn \`mtplx serve\`: ${err.message}`
      console.error(`[MTPLXDaemon] ${this.spawnError}`)
    })

    // ── early exit: the server died instead of staying up
    child.on('close', (code) => {
      this.activeChildren.delete(child)
      if (code !== 0 && code !== null) {
        this.spawnError = `\`mtplx serve\` exited with code ${code}. Check MTPLX logs.`
        console.error(`[MTPLXDaemon] ${this.spawnError}`)
      } else {
        console.log(`[MTPLXDaemon] mtplx serve exited (code=${code}).`)
      }
    })
  }

  private killAllChildren(): void {
    for (const child of this.activeChildren) {
      try {
        if (!child.killed) {
          child.kill('SIGTERM')
          // Escalate after 2 seconds if still alive
          setTimeout(() => {
            try { if (!child.killed) child.kill('SIGKILL') } catch { /* already dead */ }
          }, 2000)
        }
      } catch { /* process may already be gone */ }
    }
    this.activeChildren.clear()
  }

  private transition(phase: DaemonPhase, error: string | null = null): void {
    this.state = {
      phase,
      error: phase === 'error' ? error : null,
      stderr: phase === 'error' ? this.state.stderr : null
    }
    console.log(`[MTPLXDaemon] Phase: ${phase}${error ? ` — ${error}` : ''}`)
    this.emit('stateChange', this.getState())
  }

  // ----------------------------------------------------------------
  // Binary discovery
  // ----------------------------------------------------------------

  private findMtplxBinary(): string | null {
    for (const candidate of MTPLX_CANDIDATES) {
      if (candidate === 'mtplx') {
        // PATH lookup — try to locate via `which`
        try {
          const result = execFileSync('which', ['mtplx'], { encoding: 'utf8', timeout: 2000 })
          const path = result.trim()
          if (path && existsSync(path)) return path
        } catch { /* not in PATH */ }
      } else if (existsSync(candidate)) {
        return candidate
      }
    }
    return null
  }
}

export const mtplxDaemonManager = new MTPLXDaemonManager()

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
