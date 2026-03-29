/**
 * LMSDaemonManager
 *
 * Manages the `lms` CLI child processes that control LM Studio's local server.
 * Handles pre-flight checks, process spawning, stderr piping, and zombie cleanup.
 *
 * Architecture:
 *   1. Pre-flight  → GET /v1/models; if 200 the server is already up, skip start
 *   2. Start       → spawn `lms server start` (fast command, exits after signalling daemon)
 *   3. Load        → spawn `lms load <modelId>` (may take 10–120s)
 *   4. Cleanup     → on quit, kill any live child, then `lms unload --all` + `lms server stop`
 */

import { spawn, execFileSync, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import axios from 'axios'
import type { DaemonState, DaemonPhase } from '../../shared/types'

const LMS_CANDIDATES = [
  join(homedir(), '.lmstudio', 'bin', 'lms'),  // default install location
  '/usr/local/bin/lms',
  '/opt/homebrew/bin/lms',
  'lms',                                         // PATH fallback
]

const LMS_SERVER_URL = 'http://localhost:1234/v1/models'
const PREFLIGHT_TIMEOUT_MS = 4_000
const LOAD_TIMEOUT_MS      = 180_000  // model load can take a while on first run

export class LMSDaemonManager extends EventEmitter {
  private state: DaemonState = {
    phase:  'idle',
    error:  null,
    stderr: null
  }

  // Active child processes — tracked so we can kill them on quit
  private activeChildren: Set<ChildProcess> = new Set()
  private lmsBin: string | null = null

  constructor() {
    super()
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  getState(): DaemonState {
    return { ...this.state }
  }

  /**
   * Main entry point. Call once after the window is shown.
   * modelId is optional — if not provided, we skip `lms load` and
   * rely on ModelConnectionManager to detect whatever is already loaded.
   */
  async start(modelId?: string): Promise<void> {
    this.lmsBin = this.findLmsBinary()

    if (!this.lmsBin) {
      // lms CLI not installed — that's fine, LM Studio may already be running
      // as a GUI app. Fall through to pure HTTP polling in ModelConnectionManager.
      console.log('[LMSDaemon] lms binary not found — skipping daemon management, relying on HTTP poll.')
      return
    }

    console.log(`[LMSDaemon] Using lms binary: ${this.lmsBin}`)

    try {
      await this.runPreflightAndStart(modelId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.transition('error', msg)
    }
  }

  /**
   * User-triggered retry (e.g. after an error).
   * Kills any stale children before re-attempting.
   */
  async retry(modelId?: string): Promise<void> {
    this.killAllChildren()
    this.transition('idle')
    await this.start(modelId)
  }

  /**
   * Graceful shutdown — called from app `before-quit`.
   * Kills all child processes, then runs cleanup commands synchronously.
   */
  async shutdown(): Promise<void> {
    this.killAllChildren()

    if (!this.lmsBin) return

    console.log('[LMSDaemon] Shutdown: running lms unload --all && lms server stop')
    try {
      execFileSync(this.lmsBin, ['unload', '--all'], { timeout: 10_000 })
    } catch (e) {
      console.warn('[LMSDaemon] lms unload --all failed (possibly no model loaded):', e)
    }
    try {
      execFileSync(this.lmsBin, ['server', 'stop'], { timeout: 10_000 })
    } catch (e) {
      console.warn('[LMSDaemon] lms server stop failed (possibly already stopped):', e)
    }
  }

  // ----------------------------------------------------------------
  // Internal lifecycle
  // ----------------------------------------------------------------

  private async runPreflightAndStart(modelId?: string): Promise<void> {
    // 1. Pre-flight: is the server already up?
    this.transition('preflight')
    const alreadyRunning = await this.pingServer()

    if (alreadyRunning) {
      console.log('[LMSDaemon] Pre-flight: server already running — skipping `lms server start`.')
      // If modelId provided and server is up, still try to load the model
      if (modelId) {
        await this.runLoadModel(modelId)
      } else {
        this.transition('ready')
      }
      return
    }

    // 2. Server not running — start it
    await this.runServerStart()

    // 3. Wait briefly for the server to accept connections
    await this.waitForServerUp()

    // 4. Load model if specified
    if (modelId) {
      await this.runLoadModel(modelId)
    } else {
      this.transition('ready')
    }
  }

  private async pingServer(): Promise<boolean> {
    try {
      const res = await axios.get(LMS_SERVER_URL, { timeout: PREFLIGHT_TIMEOUT_MS })
      return res.status === 200
    } catch {
      return false
    }
  }

  private async waitForServerUp(maxAttempts = 20, intervalMs = 500): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      if (await this.pingServer()) return
      await sleep(intervalMs)
    }
    throw new Error('LM Studio server did not become reachable after `lms server start`. Check LM Studio logs.')
  }

  private runServerStart(): Promise<void> {
    return this.runCommand('starting-server', 'server', ['start'])
  }

  private async runLoadModel(modelId: string): Promise<void> {
    // Read the user's persisted context-length preference and apply it.
    // Falls back to lms / LM Studio default when no preference is saved.
    let contextArgs: string[] = []
    try {
      const { readSettings } = await import('../services/SettingsStore')
      const { contextLength } = readSettings()
      if (contextLength && contextLength > 0) {
        contextArgs = ['--context-length', String(contextLength)]
        console.log(`[LMSDaemon] Applying saved context length: ${contextLength}`)
      }
    } catch { /* non-fatal — proceed with lms default */ }

    return this.runCommand('loading-model', 'load', [modelId, ...contextArgs], LOAD_TIMEOUT_MS)
  }

  /**
   * Spawns `lms <subcommand> [args]` and wires up full error handling.
   * Resolves when the process exits with code 0.
   * Rejects on non-zero exit, timeout, or spawn error.
   */
  private runCommand(
    phase: DaemonPhase,
    subcommand: string,
    args: string[],
    timeoutMs = 30_000
  ): Promise<void> {
    this.transition(phase)

    return new Promise((resolve, reject) => {
      const bin = this.lmsBin!
      const fullArgs = [subcommand, ...args]

      console.log(`[LMSDaemon] Spawning: ${bin} ${fullArgs.join(' ')}`)

      const child = spawn(bin, fullArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
      })

      this.activeChildren.add(child)

      // ── stdout (informational)
      child.stdout?.on('data', (data: Buffer) => {
        console.log(`[LMSDaemon stdout] ${data.toString().trim()}`)
      })

      // ── stderr: log and relay to renderer
      child.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim()
        console.error(`[LMSDaemon stderr] ${line}`)
        this.state.stderr = line
        this.emit('stateChange', this.getState())
      })

      // ── spawn error (binary not found, permission denied, etc.)
      child.on('error', (err) => {
        this.activeChildren.delete(child)
        reject(new Error(`Failed to spawn lms ${subcommand}: ${err.message}`))
      })

      // ── timeout guard
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        this.activeChildren.delete(child)
        reject(new Error(`lms ${subcommand} timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)

      // ── exit
      child.on('close', (code) => {
        clearTimeout(timer)
        this.activeChildren.delete(child)

        if (code === 0 || code === null) {
          // null = killed, which we treat as OK for server start (daemonizes)
          resolve()
        } else {
          reject(new Error(`lms ${subcommand} exited with code ${code}. Check LM Studio logs.`))
        }
      })
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
    console.log(`[LMSDaemon] Phase: ${phase}${error ? ` — ${error}` : ''}`)
    this.emit('stateChange', this.getState())
  }

  // ----------------------------------------------------------------
  // Binary discovery
  // ----------------------------------------------------------------

  private findLmsBinary(): string | null {
    for (const candidate of LMS_CANDIDATES) {
      if (candidate === 'lms') {
        // PATH lookup — try to locate via `which`
        try {
          const result = execFileSync('which', ['lms'], { encoding: 'utf8', timeout: 2000 })
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

export const lmsDaemonManager = new LMSDaemonManager()

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
