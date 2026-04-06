/**
 * OllamaDaemonManager
 *
 * Manages the `ollama serve` child process.
 * Handles pre-flight checks, process spawning, stderr piping, and cleanup.
 *
 * Architecture:
 *   1. Pre-flight  → GET /api/tags; if 200 the server is already up, skip start
 *   2. Start       → spawn `ollama serve` (long-lived process, NOT a self-daemonizing command)
 *   3. Cleanup     → on quit, SIGTERM the serve process
 *
 * Unlike LMSDaemonManager there is no separate "load model" step —
 * Ollama loads models lazily on the first inference request using
 * the model name supplied in the chat payload.
 */

import { spawn, execFileSync, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import axios from 'axios'
import type { DaemonState, DaemonPhase } from '../../shared/types'

const OLLAMA_CANDIDATES = [
  '/usr/local/bin/ollama',
  '/opt/homebrew/bin/ollama',
  'ollama',  // PATH fallback
]

const OLLAMA_HEALTH_URL    = 'http://localhost:11434/api/tags'
const PREFLIGHT_TIMEOUT_MS = 4_000
// Maximum time we wait for `ollama serve` to become reachable after spawn.
const SERVE_READY_ATTEMPTS = 30
const SERVE_READY_INTERVAL = 500

export class OllamaDaemonManager extends EventEmitter {
  private state: DaemonState = {
    phase:  'idle',
    error:  null,
    stderr: null,
  }

  private serveProcess: ChildProcess | null = null
  private ollamaBin: string | null = null

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
   * Start the Ollama server if it is not already running.
   * Safe to call even if ollama is not installed — logs and returns silently.
   */
  async start(): Promise<void> {
    this.ollamaBin = this.findOllamaBinary()

    if (!this.ollamaBin) {
      console.log('[OllamaDaemon] ollama binary not found — skipping daemon management, relying on HTTP poll.')
      return
    }

    console.log(`[OllamaDaemon] Using ollama binary: ${this.ollamaBin}`)

    try {
      await this.runPreflightAndStart()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.transition('error', msg)
    }
  }

  /**
   * User-triggered retry (e.g. after an error).
   * Kills the stale serve process before re-attempting.
   */
  async retry(): Promise<void> {
    this.killServeProcess()
    this.transition('idle')
    await this.start()
  }

  /**
   * Graceful shutdown — called from app `before-quit`.
   * Kills the `ollama serve` process if we spawned it.
   */
  async shutdown(): Promise<void> {
    this.killServeProcess()
  }

  // ----------------------------------------------------------------
  // Internal lifecycle
  // ----------------------------------------------------------------

  private async runPreflightAndStart(): Promise<void> {
    // 1. Pre-flight: is the server already up?
    this.transition('preflight')
    const alreadyRunning = await this.pingServer()

    if (alreadyRunning) {
      console.log('[OllamaDaemon] Pre-flight: server already running — skipping `ollama serve`.')
      this.transition('ready')
      return
    }

    // 2. Server not running — spawn `ollama serve`
    await this.runServe()

    // 3. Wait until the server accepts connections
    await this.waitForServerUp()

    this.transition('ready')
  }

  private async pingServer(): Promise<boolean> {
    try {
      const res = await axios.get(OLLAMA_HEALTH_URL, { timeout: PREFLIGHT_TIMEOUT_MS })
      return res.status === 200
    } catch {
      return false
    }
  }

  private async waitForServerUp(): Promise<void> {
    for (let i = 0; i < SERVE_READY_ATTEMPTS; i++) {
      if (await this.pingServer()) return
      await sleep(SERVE_READY_INTERVAL)
    }
    throw new Error(
      `Ollama server did not become reachable within ${(SERVE_READY_ATTEMPTS * SERVE_READY_INTERVAL) / 1000}s after \`ollama serve\`. Check Ollama logs.`
    )
  }

  /**
   * Spawns `ollama serve` as a long-lived child process.
   * Resolves immediately — caller should then call waitForServerUp().
   */
  private runServe(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.transition('starting-server')
      const bin = this.ollamaBin!
      console.log(`[OllamaDaemon] Spawning: ${bin} serve`)

      const child = spawn(bin, ['serve'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })

      this.serveProcess = child

      // ── stdout (informational)
      child.stdout?.on('data', (data: Buffer) => {
        console.log(`[OllamaDaemon stdout] ${data.toString().trim()}`)
      })

      // ── stderr: log and relay to renderer for diagnostics
      child.stderr?.on('data', (data: Buffer) => {
        const line = data.toString().trim()
        if (line) {
          console.log(`[OllamaDaemon stderr] ${line}`)
          this.state.stderr = line
          this.emit('stateChange', this.getState())
        }
      })

      // ── spawn error (binary not found, permission denied, etc.)
      child.on('error', (err) => {
        reject(new Error(`Failed to spawn ollama serve: ${err.message}`))
      })

      // ── unexpected exit while still running
      child.on('close', (code) => {
        if (this.serveProcess === child) this.serveProcess = null
        if (code !== null && code !== 0) {
          this.transition('error', `ollama serve exited with code ${code}`)
        }
      })

      // Resolve as soon as spawn succeeds — we don't wait for the process to exit
      // (it never will while the server is running).
      resolve()
    })
  }

  private killServeProcess(): void {
    if (this.serveProcess && !this.serveProcess.killed) {
      console.log('[OllamaDaemon] Sending SIGTERM to ollama serve…')
      this.serveProcess.kill('SIGTERM')
      // Escalate if still alive after 2s
      setTimeout(() => {
        try {
          if (this.serveProcess && !this.serveProcess.killed) {
            this.serveProcess.kill('SIGKILL')
          }
        } catch { /* already dead */ }
      }, 2000)
      this.serveProcess = null
    }
  }

  private transition(phase: DaemonPhase, error: string | null = null): void {
    this.state = {
      phase,
      error:  phase === 'error' ? error  : null,
      stderr: phase === 'error' ? this.state.stderr : null,
    }
    console.log(`[OllamaDaemon] Phase: ${phase}${error ? ` — ${error}` : ''}`)
    this.emit('stateChange', this.getState())
  }

  // ----------------------------------------------------------------
  // Binary discovery
  // ----------------------------------------------------------------

  private findOllamaBinary(): string | null {
    for (const candidate of OLLAMA_CANDIDATES) {
      if (candidate === 'ollama') {
        try {
          const result = execFileSync('which', ['ollama'], { encoding: 'utf8', timeout: 2_000 })
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

export const ollamaDaemonManager = new OllamaDaemonManager()

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
