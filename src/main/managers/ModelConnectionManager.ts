import axios, { AxiosError } from 'axios'
import { EventEmitter } from 'events'
import type {
  ConnectionState,
  ModelInfo,
  ModelStatus,
  LMStudioModelsResponse,
} from '../../shared/types'
// Static top-level import (not require()) — the require() form silently failed to
// resolve in the packaged build, see progress.md row 89. SettingsStore imports only
// electron/path/fs, so there is no import cycle back into this module.
import { readSettings } from '../services/SettingsStore'
// Safe direction: MTPLXDaemonManager imports SettingsStore/axios/child_process
// only — it never imports this module, so there is no cycle.
import { mtplxDaemonManager } from './MTPLXDaemonManager'

/** LM Studio health-check endpoint. */
const LMS_HEALTH_URL = 'http://localhost:1234/v1/models'

/** MTPLX default base URL — overridden by the user-configurable mtplxBaseUrl setting. */
const MTPLX_DEFAULT_BASE_URL = 'http://localhost:8000'

// Poll aggressively when offline, back off when connected
const POLL_INTERVAL_OFFLINE_MS  = 3_000   // 3s — quick reconnect detection
const POLL_INTERVAL_READY_MS    = 15_000  // 15s — heartbeat when stable

// How many consecutive failures are required before showing the offline overlay.
// A value of 2 means a single blip (e.g. LM Studio busy during PDF streaming)
// will not interrupt the user with a full-screen error.
const FAILURES_BEFORE_OFFLINE = 2

// Health-check timeout — generous enough that a busy-but-running LM Studio
// instance (e.g. mid-generation) still has time to respond.
const HEALTH_CHECK_TIMEOUT_MS = 8_000

/**
 * Polls an OpenAI-compatible /v1/models endpoint and reports connection state.
 *
 * Parameterised rather than hardcoded to LM Studio so a second instance can watch
 * a second local backend (MTPLX) independently:
 *
 *  - `getHealthUrl` is a FUNCTION, not a captured string, because MTPLX's base URL
 *    is user-configurable at runtime — it must be re-read from settings on every
 *    poll, not resolved once at construction.
 *  - `label` is interpolated into every user-facing error message so the UI names
 *    the backend that is actually down.
 *  - `isBackendBooting` (optional) lets a local backend that DI starts itself
 *    suppress the 'offline' transition while its daemon is legitimately mid-boot.
 */
export class ModelConnectionManager extends EventEmitter {
  private state: ConnectionState = {
    status:         'loading',
    modelInfo:      null,
    lastChecked:    null,
    error:          null,
    pollIntervalMs: POLL_INTERVAL_OFFLINE_MS,
  }

  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private isPolling = false

  /**
   * Counts consecutive poll failures while already in 'ready' state.
   * Reset to 0 on any success.  We only transition to 'offline' once this
   * reaches FAILURES_BEFORE_OFFLINE, preventing single-blip false positives
   * (e.g. LM Studio briefly unresponsive while the GPU is pegged generating).
   */
  private consecutiveFailures = 0

  /**
   * @param getHealthUrl Called on every poll — returns the /v1/models URL to probe.
   * @param label        Backend name used in error messages e.g. 'LM Studio', 'MTPLX'.
   * @param isBackendBooting
   *   Optional. Called on every failed poll. While it returns true the poller
   *   stays in 'connecting' no matter how many polls fail — the backend's own
   *   daemon is still starting up, so a refused connection is expected rather
   *   than a fault. Omitted for LM Studio, whose daemon DI does not gate on.
   */
  constructor(
    private readonly getHealthUrl: () => string,
    private readonly label: string,
    private readonly isBackendBooting?: () => boolean,
  ) {
    super()
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  getState(): ConnectionState {
    return { ...this.state }
  }

  start(): void {
    if (this.isPolling) return
    this.isPolling = true
    this.transitionTo('connecting')
    // Immediate first poll, then schedule recurring
    this.poll()
  }

  stop(): void {
    this.isPolling = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** Trigger an out-of-band poll (e.g. user clicked "Retry") */
  async forcePoll(): Promise<ConnectionState> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    // Reset failure streak — the user explicitly asked to recheck,
    // so treat this as the first attempt from a clean slate.
    this.consecutiveFailures = 0

    this.transitionTo('connecting')
    await this.poll()
    return this.getState()
  }

  // ----------------------------------------------------------------
  // Internal polling logic
  // ----------------------------------------------------------------

  private async poll(): Promise<void> {
    try {
      const response = await axios.get<LMStudioModelsResponse>(this.getHealthUrl(), {
        timeout: HEALTH_CHECK_TIMEOUT_MS,
        headers: { Accept: 'application/json' }
      })

      // Any successful response resets the failure streak
      this.consecutiveFailures = 0

      const models = response.data?.data ?? []

      if (models.length === 0) {
        this.transitionTo('offline', null,
          `${this.label} is running but no model is loaded. Load a model in ${this.label} to continue.`)
      } else {
        const modelInfo: ModelInfo = models[0]
        this.transitionTo('ready', modelInfo)
      }
    } catch (err) {
      const error = err as AxiosError
      let message = `Cannot reach ${this.label}.`

      if (error.code === 'ECONNREFUSED') {
        message = `${this.label} server is not running.`
      } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        message = `Connection to ${this.label} timed out.`
      } else if (error.response) {
        message = `${this.label} responded with error ${error.response.status}.`
      }

      // The counter exists only to gate the offline transition, so it is capped
      // at the threshold. Letting it run unbounded produced nonsense log lines
      // like "(4/2)" on any sustained outage.
      if (this.consecutiveFailures < FAILURES_BEFORE_OFFLINE) {
        this.consecutiveFailures++
        console.log(
          `[ModelConnection][${this.label}] Poll failed (${this.consecutiveFailures}/${FAILURES_BEFORE_OFFLINE}): ${message}`
        )
      } else {
        console.log(`[ModelConnection][${this.label}] Still unreachable: ${message}`)
      }

      // A backend whose daemon DI started is allowed to be unreachable while it
      // boots — MTPLX's cold start (spawn → model load → /health) takes several
      // seconds, during which every poll legitimately fails. Reporting 'offline'
      // there produces a false "not running" flash mid-boot, so we hold at
      // 'connecting' until the daemon reaches 'ready' or 'error'.
      if (this.isBackendBooting?.()) {
        if (this.state.status !== 'connecting') this.transitionTo('connecting')
        return
      }

      if (this.consecutiveFailures >= FAILURES_BEFORE_OFFLINE) {
        this.transitionTo('offline', null, message)
      }
    } finally {
      this.scheduleNextPoll()
    }
  }

  private scheduleNextPoll(): void {
    if (!this.isPolling) return

    const interval =
      this.state.status === 'ready'
        ? POLL_INTERVAL_READY_MS
        : POLL_INTERVAL_OFFLINE_MS

    this.state.pollIntervalMs = interval
    this.pollTimer = setTimeout(() => this.poll(), interval)
  }

  private transitionTo(
    status: ModelStatus,
    modelInfo: ModelInfo | null = null,
    error: string | null = null,
  ): void {
    const previousStatus  = this.state.status
    const newModelInfo    = status === 'ready' ? modelInfo : null
    const newError        = status === 'offline' ? error : null

    // Skip the emit entirely when nothing visible has changed — this prevents
    // a steady-stream of no-op IPC messages to the renderer on every 15s poll.
    if (
      status       === previousStatus &&
      newError     === this.state.error &&
      (newModelInfo?.id ?? null) === (this.state.modelInfo?.id ?? null)
    ) {
      // Still update lastChecked so getState() is fresh
      this.state = { ...this.state, lastChecked: Date.now() }
      return
    }

    this.state = {
      status,
      modelInfo:      newModelInfo,
      lastChecked:    Date.now(),
      error:          newError,
      pollIntervalMs: this.state.pollIntervalMs,
    }

    this.emit('statusChange', this.getState(), previousStatus)
  }
}

// Singletons — imported by the IPC handler layer.
// The two backends are independent: whichever provider is active at boot gets its
// poller started in src/main/index.ts; the other one is never started.
export const modelConnectionManager = new ModelConnectionManager(
  () => LMS_HEALTH_URL,
  'LM Studio',
)

export const mtplxConnectionManager = new ModelConnectionManager(
  () => {
    // Re-read on every poll — the user can change the MTPLX port at runtime.
    const base = readSettings().mtplxBaseUrl ?? MTPLX_DEFAULT_BASE_URL
    return `${base.replace(/\/$/, '')}/v1/models`
  },
  'MTPLX',
  // Read the daemon's phase on demand rather than subscribing to 'stateChange':
  // getState() is always current, so a listener would only add bookkeeping.
  // 'preflight' and 'starting-server' mean a cold boot we triggered is in
  // progress; 'ready' and 'error' are both terminal enough for the poller to
  // report the truth. 'idle' means start() was never called (or the mtplx binary
  // was not found), so the poller should behave normally too.
  () => {
    const phase = mtplxDaemonManager.getState().phase
    return phase === 'preflight' || phase === 'starting-server'
  },
)
