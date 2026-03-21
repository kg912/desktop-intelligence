import axios, { AxiosError } from 'axios'
import { EventEmitter } from 'events'
import type {
  ConnectionState,
  ModelInfo,
  ModelStatus,
  LMStudioModelsResponse
} from '../../shared/types'

const LM_STUDIO_BASE_URL = 'http://localhost:1234/v1'
const MODELS_ENDPOINT    = `${LM_STUDIO_BASE_URL}/models`

// Poll aggressively when offline, back off when connected
const POLL_INTERVAL_OFFLINE_MS  = 3_000   // 3s — quick reconnect detection
const POLL_INTERVAL_READY_MS    = 15_000  // 15s — heartbeat when stable

export class ModelConnectionManager extends EventEmitter {
  private state: ConnectionState = {
    status:        'loading',
    modelInfo:     null,
    lastChecked:   null,
    error:         null,
    pollIntervalMs: POLL_INTERVAL_OFFLINE_MS
  }

  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private isPolling = false

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
    this.transitionTo('connecting')
    await this.poll()
    return this.getState()
  }

  // ----------------------------------------------------------------
  // Internal polling logic
  // ----------------------------------------------------------------

  private async poll(): Promise<void> {
    try {
      const response = await axios.get<LMStudioModelsResponse>(MODELS_ENDPOINT, {
        timeout: 5_000,
        headers: { Accept: 'application/json' }
      })

      const models = response.data?.data ?? []

      if (models.length === 0) {
        // LM Studio is up but no model is loaded
        this.transitionTo('offline', null, 'LM Studio is running but no model is loaded. Load a model in LM Studio to continue.')
      } else {
        // Pick the first available model (they're already selected in LM Studio)
        const modelInfo: ModelInfo = models[0]
        this.transitionTo('ready', modelInfo)
      }
    } catch (err) {
      const error = err as AxiosError
      let message = 'Cannot reach LM Studio.'

      if (error.code === 'ECONNREFUSED') {
        message = 'LM Studio server is not running. Start LM Studio and enable the local server.'
      } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        message = 'Connection to LM Studio timed out.'
      } else if (error.response) {
        message = `LM Studio responded with error ${error.response.status}.`
      }

      this.transitionTo('offline', null, message)
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
    error: string | null = null
  ): void {
    const previousStatus = this.state.status

    this.state = {
      status,
      modelInfo:     status === 'ready' ? modelInfo : null,
      lastChecked:   Date.now(),
      error:         status === 'offline' ? error : null,
      pollIntervalMs: this.state.pollIntervalMs
    }

    // Always emit — the renderer decides whether to re-render
    this.emit('statusChange', this.getState(), previousStatus)
  }
}

// Singleton — imported by the IPC handler layer
export const modelConnectionManager = new ModelConnectionManager()
