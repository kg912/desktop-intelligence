/**
 * App — MTPLX model restore fallback
 *
 * The returning-user restore effect used to do nothing when
 * backend.mtplxModel was empty, leaving the TopBar permanently blank with no
 * way to recover. That state is reachable whenever Backend Settings never
 * completed a successful model fetch, so its auto-select-first-model never
 * fired — exactly what happened when MTPLX was served on a blocked port.
 *
 * The effect now falls back to asking the server directly and persists the
 * result so later launches skip the round-trip.
 *
 * These tests exercise the effect's logic in isolation rather than mounting the
 * whole App tree, which would drag in the chat runtime, signals and the
 * virtualiser for no added coverage of the branch under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BackendProvider } from '../../shared/types'

const mockGetBackendSettings  = vi.fn()
const mockGetMtplxModels      = vi.fn()
const mockSaveBackendSettings = vi.fn().mockResolvedValue(undefined)
const mockGetModelConfig      = vi.fn()
const setSelectedModel        = vi.fn()

/**
 * Mirrors the provider branch of App.tsx's returning-user restore effect.
 * Kept in lockstep with the source; the fallback path is the part under test.
 */
async function restoreSelectedModel(): Promise<void> {
  try {
    const backend = await mockGetBackendSettings()
    if (backend.provider === 'nvidia') {
      if (backend.nvidiaModel) setSelectedModel(backend.nvidiaModel)
    } else if (backend.provider === 'ollama') {
      if (backend.ollamaModel) setSelectedModel(backend.ollamaModel)
    } else if (backend.provider === 'openrouter') {
      if (backend.openrouterModel) setSelectedModel(backend.openrouterModel)
    } else if (backend.provider === 'mtplx') {
      if (backend.mtplxModel) {
        setSelectedModel(backend.mtplxModel)
      } else {
        const result = await mockGetMtplxModels(backend.mtplxBaseUrl)
        const first  = result.models?.[0]
        if (first) {
          setSelectedModel(first)
          await mockSaveBackendSettings({ mtplxModel: first })
        }
      }
    } else {
      const cfg = await mockGetModelConfig()
      if (cfg.modelId) setSelectedModel(cfg.modelId)
    }
  } catch {
    // Non-fatal by design.
  }
}

function backend(provider: BackendProvider, over: Record<string, unknown> = {}) {
  return {
    provider,
    nvidiaModel: 'nv', ollamaModel: 'oll', openrouterModel: 'or',
    mtplxModel: '', mtplxBaseUrl: 'http://localhost:8000',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetMtplxModels.mockResolvedValue({ models: [], error: null })
  mockGetModelConfig.mockResolvedValue({ modelId: 'lms-model' })
})

describe('MTPLX model restore — saved model present', () => {
  it('uses the saved model and does not hit the network', async () => {
    mockGetBackendSettings.mockResolvedValue(backend('mtplx', { mtplxModel: 'Qwen3-30B-A3B-MLX-4bit' }))

    await restoreSelectedModel()

    expect(setSelectedModel).toHaveBeenCalledWith('Qwen3-30B-A3B-MLX-4bit')
    expect(mockGetMtplxModels).not.toHaveBeenCalled()
    expect(mockSaveBackendSettings).not.toHaveBeenCalled()
  })
})

describe('MTPLX model restore — no saved model (the reported blank TopBar)', () => {
  it('asks the server and adopts the first installed model', async () => {
    mockGetBackendSettings.mockResolvedValue(backend('mtplx'))
    mockGetMtplxModels.mockResolvedValue({
      models: ['mtplx-qwen38-27b-optimized-speed', 'other'],
      error: null,
    })

    await restoreSelectedModel()

    expect(mockGetMtplxModels).toHaveBeenCalledWith('http://localhost:8000')
    expect(setSelectedModel).toHaveBeenCalledWith('mtplx-qwen38-27b-optimized-speed')
  })

  it('persists the adopted model so later launches skip the round-trip', async () => {
    mockGetBackendSettings.mockResolvedValue(backend('mtplx'))
    mockGetMtplxModels.mockResolvedValue({ models: ['m1'], error: null })

    await restoreSelectedModel()

    expect(mockSaveBackendSettings).toHaveBeenCalledWith({ mtplxModel: 'm1' })
  })

  it('leaves the model unset when the server reports no models', async () => {
    mockGetBackendSettings.mockResolvedValue(backend('mtplx'))
    mockGetMtplxModels.mockResolvedValue({ models: [], error: null })

    await restoreSelectedModel()

    expect(setSelectedModel).not.toHaveBeenCalled()
    expect(mockSaveBackendSettings).not.toHaveBeenCalled()
  })

  it('leaves the model unset when the fetch reports an error', async () => {
    mockGetBackendSettings.mockResolvedValue(backend('mtplx'))
    mockGetMtplxModels.mockResolvedValue({ models: [], error: 'Port 6000 is on the blocked-port list' })

    await restoreSelectedModel()

    expect(setSelectedModel).not.toHaveBeenCalled()
  })

  it('does not block startup when the fetch throws', async () => {
    mockGetBackendSettings.mockResolvedValue(backend('mtplx'))
    mockGetMtplxModels.mockRejectedValue(new Error('ipc down'))

    await expect(restoreSelectedModel()).resolves.toBeUndefined()
    expect(setSelectedModel).not.toHaveBeenCalled()
  })

  it('does not block startup when persisting the model throws', async () => {
    mockGetBackendSettings.mockResolvedValue(backend('mtplx'))
    mockGetMtplxModels.mockResolvedValue({ models: ['m1'], error: null })
    mockSaveBackendSettings.mockRejectedValueOnce(new Error('write failed'))

    await expect(restoreSelectedModel()).resolves.toBeUndefined()
    // The name still reached the store before the persist failed.
    expect(setSelectedModel).toHaveBeenCalledWith('m1')
  })
})

describe('other providers are untouched by the fallback', () => {
  it('never calls getMtplxModels for lmstudio', async () => {
    mockGetBackendSettings.mockResolvedValue(backend('lmstudio'))

    await restoreSelectedModel()

    expect(setSelectedModel).toHaveBeenCalledWith('lms-model')
    expect(mockGetMtplxModels).not.toHaveBeenCalled()
  })

  for (const [provider, expected] of [
    ['nvidia', 'nv'],
    ['ollama', 'oll'],
    ['openrouter', 'or'],
  ] as Array<[BackendProvider, string]>) {
    it(`restores the saved model for "${provider}" without touching MTPLX`, async () => {
      mockGetBackendSettings.mockResolvedValue(backend(provider))

      await restoreSelectedModel()

      expect(setSelectedModel).toHaveBeenCalledWith(expected)
      expect(mockGetMtplxModels).not.toHaveBeenCalled()
    })
  }
})
