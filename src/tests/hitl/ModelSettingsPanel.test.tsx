/**
 * ModelSettingsPanel — LM-Studio-only sections hidden for other backends
 *
 * The tab rendered the full LM-Studio-oriented layout for every provider, so
 * MTPLX users saw "Active Model: —", a GPU Offload toggle that drives
 * `lms load --gpu max`, and a Reload Model button whose IPC call skipsLmsCli()
 * already no-ops. Those three are now LM Studio only.
 *
 * The generation parameters — Context Length, Temperature, Top P, Max Output
 * Tokens, Repeat Penalty, System Prompt — are provider-agnostic and must stay
 * visible everywhere, since they are sent with every request regardless of
 * backend. That invariant is asserted for all five providers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { ModelSettingsPanel } from '../../renderer/src/components/settings/ModelSettingsPanel'
import { ModelStoreProvider } from '../../renderer/src/store/ModelStore'
import type { BackendProvider } from '../../shared/types'

const mockGetModelConfig     = vi.fn()
const mockGetAvailableModels = vi.fn()
const mockGetBackendSettings = vi.fn()
const mockReloadModel        = vi.fn().mockResolvedValue({ success: true })
const mockSaveBackendSettings = vi.fn().mockResolvedValue(undefined)

if (typeof window !== 'undefined') {
  (window as any).api = {
    getModelConfig:      (...a: any[]) => mockGetModelConfig(...a),
    getAvailableModels:  (...a: any[]) => mockGetAvailableModels(...a),
    getBackendSettings:  (...a: any[]) => mockGetBackendSettings(...a),
    reloadModel:         (...a: any[]) => mockReloadModel(...a),
    saveBackendSettings: (...a: any[]) => mockSaveBackendSettings(...a),
  }
}

function backendSettings(provider: BackendProvider) {
  return {
    provider,
    nvidiaApiKey: '', nvidiaModel: 'nv-model',
    ollamaApiKey: '', ollamaModel: 'ollama-model', ollamaBaseUrl: '',
    openrouterApiKey: '', openrouterModel: 'or-model',
    mtplxBaseUrl: 'http://localhost:8000', mtplxModel: 'Qwen3-30B-A3B-MLX-4bit',
  }
}

async function renderPanel(provider: BackendProvider) {
  mockGetBackendSettings.mockResolvedValue(backendSettings(provider))
  mockGetModelConfig.mockResolvedValue({
    modelId: 'lms-model',
    contextLength: 32768,
    temperature: 0.7,
    topP: 0.95,
    maxOutputTokens: 16384,
    repeatPenalty: 1.1,
    systemPrompt: '',
    gpuOffload: false,
    unlimitedOutputTokens: false,
  })
  mockGetAvailableModels.mockResolvedValue([])

  render(
    <ModelStoreProvider>
      <ModelSettingsPanel />
    </ModelStoreProvider>,
  )
  // The mount effect resolves three IPC calls before the layout settles.
  await waitFor(() => expect(mockGetBackendSettings).toHaveBeenCalled())
  await screen.findByText('Context Length')
}

const ALL_PROVIDERS: BackendProvider[] = ['lmstudio', 'ollama', 'mtplx', 'openrouter', 'nvidia']
const NON_LMSTUDIO: BackendProvider[]  = ['ollama', 'mtplx', 'openrouter', 'nvidia']

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ─── LM Studio keeps its full layout ──────────────────────────────────────────

describe('LM Studio layout is unchanged', () => {
  it('shows Active Model, GPU Offload and Reload Model', async () => {
    await renderPanel('lmstudio')

    expect(screen.getByText('Active Model')).toBeTruthy()
    expect(screen.getByText('GPU Offload')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Reload Model/ })).toBeTruthy()
  })

  it('shows the 30–60 second reload warning', async () => {
    await renderPanel('lmstudio')

    expect(screen.getByText(/30–60 seconds/)).toBeTruthy()
  })

  it('does not show the MTPLX pointer note', async () => {
    await renderPanel('lmstudio')

    expect(screen.queryByText(/Model selection for MTPLX/)).toBeNull()
  })
})

// ─── Non-LM-Studio backends hide the daemon-specific controls ────────────────

describe('LM-Studio-specific sections are hidden for other backends', () => {
  for (const provider of NON_LMSTUDIO) {
    it(`hides the Active Model section for "${provider}"`, async () => {
      await renderPanel(provider)

      expect(screen.queryByText('Active Model')).toBeNull()
      // …and with it the "—" empty state that made this look broken.
      expect(screen.queryByText('—')).toBeNull()
    })

    it(`hides the GPU Offload toggle for "${provider}"`, async () => {
      await renderPanel(provider)

      expect(screen.queryByText('GPU Offload')).toBeNull()
    })

    it(`hides the Reload Model button and its warning for "${provider}"`, async () => {
      await renderPanel(provider)

      expect(screen.queryByRole('button', { name: /Reload Model/ })).toBeNull()
      expect(screen.queryByText(/30–60 seconds/)).toBeNull()
    })

    it(`offers Save Settings instead of Reload Model for "${provider}"`, async () => {
      await renderPanel(provider)

      expect(screen.getByRole('button', { name: /Save Settings/ })).toBeTruthy()
    })
  }
})

// ─── Generation parameters stay everywhere ────────────────────────────────────

describe('provider-agnostic generation parameters remain visible', () => {
  for (const provider of ALL_PROVIDERS) {
    it(`keeps all six parameter controls for "${provider}"`, async () => {
      await renderPanel(provider)

      // These are sent with every request regardless of backend.
      expect(screen.getByText('Context Length')).toBeTruthy()
      expect(screen.getByText('Temperature')).toBeTruthy()
      expect(screen.getByText('Top P')).toBeTruthy()
      expect(screen.getByText('Max Output Tokens')).toBeTruthy()
      expect(screen.getByText('Repeat Penalty')).toBeTruthy()
      expect(screen.getByText('System Prompt')).toBeTruthy()
    })
  }
})

// ─── MTPLX pointer note ───────────────────────────────────────────────────────

describe('MTPLX pointer to Backend Settings', () => {
  it('explains where model selection lives, so the missing section is not read as a bug', async () => {
    await renderPanel('mtplx')

    expect(screen.getByText(/Model selection for MTPLX/)).toBeTruthy()
    expect(screen.getByText('Backend Settings')).toBeTruthy()
  })

  it('is not shown for any other provider', async () => {
    for (const provider of ['lmstudio', 'ollama', 'openrouter', 'nvidia'] as BackendProvider[]) {
      await renderPanel(provider)
      expect(screen.queryByText(/Model selection for MTPLX/)).toBeNull()
      cleanup()
    }
  })
})
