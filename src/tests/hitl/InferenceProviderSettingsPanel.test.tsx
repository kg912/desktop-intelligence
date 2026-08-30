/**
 * InferenceProviderSettingsPanel — MTPLX gating
 *
 * Two problems this covers:
 *
 *  1. The Model field used to fetch on mount / base-URL change regardless of
 *     whether MTPLX was the CONFIRMED active backend or merely the pending form
 *     selection, and regardless of whether its daemon had started. That produced
 *     a permanent "Could not fetch models: fetch failed" dead-end. Fetching is
 *     now gated on activeProvider === 'mtplx' AND daemon phase === 'ready'.
 *
 *  2. Save & Restart could switch the app into an MTPLX install with no models,
 *     leaving a backend that cannot answer a single request. It is now blocked —
 *     but only on a CONFIRMED-empty list. A failed fetch means "unverified",
 *     which is a different state and must not block.
 *
 * Note the distinction the tests lean on throughout: `settings.provider` is the
 * pending form selection, `activeProvider` is what the main process is actually
 * running. They diverge the moment a provider button is clicked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { InferenceProviderSettingsPanel } from '../../renderer/src/components/settings/InferenceProviderSettingsPanel'
import type { BackendProvider, DaemonPhase } from '../../shared/types'

const mockGetBackendSettings   = vi.fn()
const mockSaveBackendSettings  = vi.fn().mockResolvedValue(undefined)
const mockGetMtplxModels       = vi.fn()
const mockGetOllamaModels      = vi.fn()
const mockGetOpenRouterModels  = vi.fn()
const mockGetOpenRouterStats   = vi.fn()
const mockGetMtplxDaemonState  = vi.fn()
const mockRetryMtplxDaemon     = vi.fn()
const mockRestartApp           = vi.fn().mockResolvedValue(undefined)

/** Captures the subscriber so tests can push daemon phase changes. */
let daemonSubscriber: ((s: unknown) => void) | null = null
const mockOnMtplxDaemonStateChange = vi.fn((cb: (s: unknown) => void) => {
  daemonSubscriber = cb
  return () => { daemonSubscriber = null }
})

if (typeof window !== 'undefined') {
  (window as any).api = {
    getBackendSettings:        (...a: any[]) => mockGetBackendSettings(...a),
    saveBackendSettings:       (...a: any[]) => mockSaveBackendSettings(...a),
    getMtplxModels:            (...a: any[]) => mockGetMtplxModels(...a),
    getOllamaModels:           (...a: any[]) => mockGetOllamaModels(...a),
    getOpenRouterModels:       (...a: any[]) => mockGetOpenRouterModels(...a),
    getOpenRouterStats:        (...a: any[]) => mockGetOpenRouterStats(...a),
    getMtplxDaemonState:       (...a: any[]) => mockGetMtplxDaemonState(...a),
    retryMtplxDaemon:          (...a: any[]) => mockRetryMtplxDaemon(...a),
    onMtplxDaemonStateChange:  (cb: any) => mockOnMtplxDaemonStateChange(cb),
    restartApp:                (...a: any[]) => mockRestartApp(...a),
    openExternal:              vi.fn(),
  }
}

function backendSettings(provider: BackendProvider, mtplxModel = '') {
  return {
    provider,
    nvidiaApiKey: '', nvidiaModel: '',
    ollamaApiKey: '', ollamaModel: '', ollamaBaseUrl: 'https://ollama.com',
    openrouterApiKey: '', openrouterModel: '', openrouterReasoningEffort: 'auto',
    mtplxBaseUrl: 'http://localhost:8000', mtplxModel,
  }
}

const daemon = (phase: DaemonPhase, error: string | null = null) => ({ phase, error, stderr: null })

/**
 * Renders the panel with a given confirmed backend and daemon phase, then
 * (optionally) clicks a provider button to make the form selection diverge.
 */
async function renderPanel(opts: {
  activeProvider: BackendProvider
  phase?: DaemonPhase
  daemonError?: string | null
  selectProvider?: BackendProvider
  mtplxModel?: string
}) {
  mockGetBackendSettings.mockResolvedValue(
    backendSettings(opts.activeProvider, opts.mtplxModel ?? ''),
  )
  mockGetMtplxDaemonState.mockResolvedValue(daemon(opts.phase ?? 'idle', opts.daemonError ?? null))

  render(<InferenceProviderSettingsPanel />)
  await waitFor(() => expect(mockGetBackendSettings).toHaveBeenCalled())
  // Wait for loading to clear.
  await screen.findByText('Inference Backend')

  if (opts.selectProvider) {
    fireEvent.click(screen.getByRole('button', { name: providerButtonName(opts.selectProvider) }))
  }
}

function providerButtonName(p: BackendProvider): string {
  return { lmstudio: 'LM Studio', ollama: 'Ollama', mtplx: 'MTPLX', openrouter: 'OpenRouter', nvidia: 'NVIDIA Build' }[p]
}

beforeEach(() => {
  vi.clearAllMocks()
  daemonSubscriber = null
  mockGetMtplxModels.mockResolvedValue({ models: [], error: null })
  mockGetOllamaModels.mockResolvedValue({ models: [], error: null })
  mockGetOpenRouterModels.mockResolvedValue({ models: [], modalities: {}, pricing: {}, error: null })
  mockGetOpenRouterStats.mockResolvedValue({ credits: null, activity: null, error: null })
  mockGetMtplxDaemonState.mockResolvedValue(daemon('idle'))
})

afterEach(() => {
  cleanup()
})

// ─── Gating: model fetch only when confirmed active AND ready ─────────────────

describe('MTPLX model fetch gating', () => {
  it('does not fetch models when MTPLX is only the pending form selection', async () => {
    await renderPanel({ activeProvider: 'lmstudio', selectProvider: 'mtplx' })

    await screen.findByText('Restart required to activate MTPLX.')
    expect(mockGetMtplxModels).not.toHaveBeenCalled()
  })

  it('does not fetch models while the daemon is still starting', async () => {
    await renderPanel({ activeProvider: 'mtplx', phase: 'starting-server' })

    await screen.findByText('MTPLX is starting up…')
    expect(mockGetMtplxModels).not.toHaveBeenCalled()
  })

  it('does not fetch models while the daemon is in preflight', async () => {
    await renderPanel({ activeProvider: 'mtplx', phase: 'preflight' })

    await screen.findByText('MTPLX is starting up…')
    expect(mockGetMtplxModels).not.toHaveBeenCalled()
  })

  it('does not fetch models when the daemon errored', async () => {
    await renderPanel({ activeProvider: 'mtplx', phase: 'error', daemonError: 'mtplx serve exited with code 1.' })

    await screen.findByText('mtplx serve exited with code 1.')
    expect(mockGetMtplxModels).not.toHaveBeenCalled()
  })

  it('fetches once MTPLX is the active backend and the daemon is ready', async () => {
    mockGetMtplxModels.mockResolvedValue({ models: ['Qwen3-30B-A3B-MLX-4bit'], error: null })
    await renderPanel({ activeProvider: 'mtplx', phase: 'ready' })

    await waitFor(() => expect(mockGetMtplxModels).toHaveBeenCalledWith('http://localhost:8000'))
  })

  it('never shows the old "Could not fetch models" dead-end before the daemon is ready', async () => {
    mockGetMtplxModels.mockResolvedValue({ models: [], error: 'fetch failed' })
    await renderPanel({ activeProvider: 'mtplx', phase: 'starting-server' })

    await screen.findByText('MTPLX is starting up…')
    expect(screen.queryByText(/Could not fetch models/)).toBeNull()
  })
})

// ─── State-aware messages ─────────────────────────────────────────────────────

describe('MTPLX Model field states', () => {
  it('shows the restart prompt when the provider is selected but not yet active', async () => {
    await renderPanel({ activeProvider: 'lmstudio', selectProvider: 'mtplx' })

    await screen.findByText('Restart required to activate MTPLX.')
    // The model input is replaced, not merely disabled.
    expect(screen.queryByPlaceholderText(/Qwen3-30B/)).toBeNull()
  })

  it('shows a starting-up message with no error text during a cold boot', async () => {
    await renderPanel({ activeProvider: 'mtplx', phase: 'preflight' })

    await screen.findByText('MTPLX is starting up…')
    expect(screen.queryByText(/Could not fetch/)).toBeNull()
  })

  it('shows the real daemon error and a Retry button when the daemon failed', async () => {
    await renderPanel({
      activeProvider: 'mtplx',
      phase: 'error',
      daemonError: 'MTPLX server did not become reachable after `mtplx serve`.',
    })

    await screen.findByText('MTPLX server did not become reachable after `mtplx serve`.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('Retry wires to retryMtplxDaemon()', async () => {
    mockRetryMtplxDaemon.mockResolvedValue(daemon('starting-server'))
    await renderPanel({ activeProvider: 'mtplx', phase: 'error', daemonError: 'boom' })

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(mockRetryMtplxDaemon).toHaveBeenCalled())
  })

  it('follows a live daemon transition from starting-server to ready', async () => {
    mockGetMtplxModels.mockResolvedValue({ models: ['Qwen3-30B-A3B-MLX-4bit'], error: null })
    await renderPanel({ activeProvider: 'mtplx', phase: 'starting-server' })

    await screen.findByText('MTPLX is starting up…')
    expect(daemonSubscriber).toBeTruthy()

    // The daemon reaches ready — the panel should switch to the model UI.
    daemonSubscriber!(daemon('ready'))

    await waitFor(() => expect(mockGetMtplxModels).toHaveBeenCalled())
    expect(screen.queryByText('MTPLX is starting up…')).toBeNull()
  })

  it('subscribes to daemon state changes on mount', async () => {
    await renderPanel({ activeProvider: 'mtplx', phase: 'ready' })

    expect(mockOnMtplxDaemonStateChange).toHaveBeenCalled()
  })
})

// ─── Save & Restart blocking ──────────────────────────────────────────────────

describe('Save & Restart blocking on an empty MTPLX install', () => {
  const saveButton = () => screen.getByRole('button', { name: /Save & Restart/ }) as HTMLButtonElement

  it('blocks when a successful fetch returns zero models', async () => {
    mockGetMtplxModels.mockResolvedValue({ models: [], error: null })
    await renderPanel({ activeProvider: 'mtplx', phase: 'ready', selectProvider: 'lmstudio' })

    // Switch the form back to MTPLX so there IS a pending change to save.
    fireEvent.click(screen.getByRole('button', { name: 'MTPLX' }))

    await waitFor(() => expect(mockGetMtplxModels).toHaveBeenCalled())
    await waitFor(() => {
      expect(
        screen.getAllByText(/MTPLX has no models installed/).length,
      ).toBeGreaterThan(0)
    })
  })

  it('does NOT block on a fetch failure — unverified is not the same as empty', async () => {
    mockGetMtplxModels.mockResolvedValue({ models: [], error: 'fetch failed' })
    await renderPanel({ activeProvider: 'mtplx', phase: 'ready', selectProvider: 'lmstudio' })

    fireEvent.click(screen.getByRole('button', { name: 'MTPLX' }))
    await waitFor(() => expect(mockGetMtplxModels).toHaveBeenCalled())

    expect(screen.queryByText(/MTPLX has no models installed/)).toBeNull()
  })

  it('leaves Save enabled for a non-MTPLX provider even if MTPLX is empty', async () => {
    mockGetMtplxModels.mockResolvedValue({ models: [], error: null })
    await renderPanel({ activeProvider: 'mtplx', phase: 'ready', selectProvider: 'openrouter' })

    await waitFor(() => expect(saveButton().disabled).toBe(false))
  })

  it('keeps Save disabled when nothing has changed', async () => {
    // A model must already be saved: with none, auto-select-first-model writes
    // one into form state, which is itself a pending change and legitimately
    // enables Save. That is pre-existing behaviour, not part of this gating.
    mockGetMtplxModels.mockResolvedValue({ models: ['m1'], error: null })
    await renderPanel({ activeProvider: 'mtplx', phase: 'ready', mtplxModel: 'm1' })

    await waitFor(() => expect(mockGetMtplxModels).toHaveBeenCalled())
    expect(saveButton().disabled).toBe(true)
  })

  it('auto-selecting a model does enable Save — no saved model means a pending change', async () => {
    mockGetMtplxModels.mockResolvedValue({ models: ['m1'], error: null })
    await renderPanel({ activeProvider: 'mtplx', phase: 'ready', mtplxModel: '' })

    await waitFor(() => expect(saveButton().disabled).toBe(false))
  })
})

// ─── Auto-select-first-model must still work ──────────────────────────────────

describe('auto-select first model (unchanged by the gating)', () => {
  it('selects the first returned model when none is saved', async () => {
    mockGetMtplxModels.mockResolvedValue({
      models: ['Qwen3-30B-A3B-MLX-4bit', 'Qwen3-8B-MLX-8bit'],
      error: null,
    })
    await renderPanel({ activeProvider: 'mtplx', phase: 'ready', mtplxModel: '' })

    await waitFor(() => expect(mockGetMtplxModels).toHaveBeenCalled())
    const select = await screen.findByRole('combobox')
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('Qwen3-30B-A3B-MLX-4bit'))
  })

  it('does not override an already-saved model', async () => {
    mockGetMtplxModels.mockResolvedValue({
      models: ['Qwen3-30B-A3B-MLX-4bit', 'Qwen3-8B-MLX-8bit'],
      error: null,
    })
    await renderPanel({ activeProvider: 'mtplx', phase: 'ready', mtplxModel: 'Qwen3-8B-MLX-8bit' })

    await waitFor(() => expect(mockGetMtplxModels).toHaveBeenCalled())
    const select = await screen.findByRole('combobox')
    expect((select as HTMLSelectElement).value).toBe('Qwen3-8B-MLX-8bit')
  })
})
