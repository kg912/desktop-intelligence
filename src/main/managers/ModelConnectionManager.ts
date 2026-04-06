import axios, { AxiosError } from 'axios'
import { EventEmitter } from 'events'
import type {
  ConnectionState,
  ModelInfo,
  ModelStatus,
  LMStudioModelsResponse,
  AIProvider
} from '../../shared/types'
import { readSettings } from '../services/SettingsStore'

/**
 * Returns the /v1/models health-check URL for the active provider.
 * LM Studio uses port 1234; Ollama uses port 11434 with its OpenAI-compat layer.
 * Both return the same { object: "list", data: [...] } shape.
 * readSettings() is synchronous (readFileSync) — safe to call on every poll tick.
 */
function getHealthUrl(): string {
  const { provider } = readSettings()
  return provider === 'ollama'
    ? 'http://localhost:11434/v1/models'
    : 'http://localhost:1234/v1/models'
}

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

export class ModelConnectionManager extends EventEmitter {
  private state: ConnectionState = {
    status:         'loading',
    modelInfo:      null,
    lastChecked:    null,
    error:          null,
    pollIntervalMs: POLL_INTERVAL_OFFLINE_MS,
    provider:       'lmstudio'
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

  constructor() {
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
    // Use the saved provider so the 'connecting' state carries the right label
    const initialProvider: AIProvider = readSettings().provider === 'ollama' ? 'ollama' : 'lmstudio'
    this.transitionTo('connecting', null, null, initialProvider)
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

    // Read current provider so the 'connecting' overlay shows the right label.
    const currentProvider: AIProvider = readSettings().provider === 'ollama' ? 'ollama' : 'lmstudio'
    this.transitionTo('connecting', null, null, currentProvider)
    await this.poll()
    return this.getState()
  }

  // ----------------------------------------------------------------
  // Internal polling logic
  // ----------------------------------------------------------------

  private async poll(): Promise<void> {
    // Read current provider for URL routing and user-facing error messages.
    // readSettings() is synchronous — safe to call on every poll tick.
    const currentProvider: AIProvider = readSettings().provider === 'ollama' ? 'ollama' : 'lmstudio'
    const backendName = currentProvider === 'ollama' ? 'Ollama' : 'LM Studio'

    try {
      const response = await axios.get<LMStudioModelsResponse>(getHealthUrl(), {
        timeout: HEALTH_CHECK_TIMEOUT_MS,
        headers: { Accept: 'application/json' }
      })

      // Any successful response resets the failure streak
      this.consecutiveFailures = 0

      const models = response.data?.data ?? []

      if (models.length === 0) {
        // Backend is up but no model is loaded — genuine offline condition
        // (user action required), show immediately regardless of failure counter.
        const noModelMsg = currentProvider === 'ollama'
          ? 'Ollama is running but no model responded. Ensure a model is available via `ollama pull`.'
          : 'LM Studio is running but no model is loaded. Load a model in LM Studio to continue.'
        this.transitionTo('offline', null, noModelMsg, currentProvider)
      } else {
        // Pick the first available model
        const modelInfo: ModelInfo = models[0]
        this.transitionTo('ready', modelInfo, null, currentProvider)
      }
    } catch (err) {
      const error = err as AxiosError
      let message = `Cannot reach ${backendName}.`

      if (error.code === 'ECONNREFUSED') {
        message = `${backendName} server is not running.`
      } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        message = `Connection to ${backendName} timed out.`
      } else if (error.response) {
        message = `${backendName} responded with error ${error.response.status}.`
      }

      this.consecutiveFailures++
      console.log(
        `[ModelConnection] Poll failed (${this.consecutiveFailures}/${FAILURES_BEFORE_OFFLINE}): ${message}`
      )

      // Only show the offline overlay after N consecutive failures.
      // A single timeout while the backend is busy generating (e.g. PDF analysis)
      // is a false positive — silently absorb it and wait for the next poll.
      if (this.consecutiveFailures >= FAILURES_BEFORE_OFFLINE) {
        this.transitionTo('offline', null, message, currentProvider)
      }
      // else: stay in current state (likely 'ready') until the threshold is hit
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
    provider: AIProvider = 'lmstudio'
  ): void {
    const previousStatus  = this.state.status
    const newModelInfo    = status === 'ready' ? modelInfo : null
    const newError        = status === 'offline' ? error : null

    // Skip the emit entirely when nothing visible has changed — this prevents
    // a steady-stream of no-op IPC messages to the renderer on every 15s poll.
    if (
      status       === previousStatus &&
      newError     === this.state.error &&
      provider     === this.state.provider &&
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
      provider
    }

    this.emit('statusChange', this.getState(), previousStatus)
  }
}

// Singleton — imported by the IPC handler layer
export const modelConnectionManager = new ModelConnectionManager()
