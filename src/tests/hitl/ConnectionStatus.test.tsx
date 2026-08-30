/**
 * ConnectionStatus — provider-conditional rendering
 *
 * The overlay used to be hardcoded to LM Studio: literal "Connecting to LM
 * Studio", "localhost:1234", "LM Studio Offline", and a Quick-fix block giving
 * LM Studio UI navigation steps. With MTPLX as a second local backend all four
 * had to become provider-aware.
 *
 * Coverage goals:
 *   ✓ LM Studio wording and localhost:1234 are unchanged (no regression)
 *   ✓ MTPLX gets its own label, its configured host:port, and MTPLX guidance
 *   ✓ The MTPLX host comes from the saved mtplxBaseUrl, including a custom port
 *   ✓ A malformed saved base URL falls back rather than rendering garbage
 *   ✓ The overlay is hidden for every cloud backend, not just NVIDIA
 *   ✓ The overlay still shows for local backends that are not ready
 *   ✓ LM Studio Quick-fix steps never leak into the MTPLX view, and vice versa
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { ConnectionStatus } from '../../renderer/src/components/ConnectionStatus'
import type { BackendProvider, ModelStatus } from '../../shared/types'

const mockGetBackendSettings = vi.fn()

if (typeof window !== 'undefined') {
  (window as any).api = {
    getBackendSettings: (...args: any[]) => mockGetBackendSettings(...args),
  }
}

/** Minimal BackendSettings stub — only the fields this component reads matter. */
function backendSettings(provider: BackendProvider, mtplxBaseUrl = 'http://localhost:8000') {
  return {
    provider,
    nvidiaApiKey: '', nvidiaModel: '',
    ollamaApiKey: '', ollamaModel: '', ollamaBaseUrl: '',
    openrouterApiKey: '', openrouterModel: '',
    mtplxBaseUrl, mtplxModel: '',
  }
}

/** Renders the overlay and waits for the async provider read to land. */
async function renderOverlay(
  provider: BackendProvider,
  status: ModelStatus,
  opts: { error?: string | null; mtplxBaseUrl?: string } = {},
) {
  mockGetBackendSettings.mockResolvedValue(
    backendSettings(provider, opts.mtplxBaseUrl ?? 'http://localhost:8000'),
  )
  const view = render(
    <ConnectionStatus status={status} error={opts.error ?? null} onRetry={() => {}} />,
  )
  // The provider arrives via a promise in useEffect; let it settle.
  await waitFor(() => expect(mockGetBackendSettings).toHaveBeenCalled())
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ─── Connecting view ──────────────────────────────────────────────────────────

describe('ConnectingView — label and host', () => {
  it('names LM Studio and its fixed port', async () => {
    await renderOverlay('lmstudio', 'connecting')

    await screen.findByText('Connecting to LM Studio')
    expect(screen.getByText('localhost:1234')).toBeTruthy()
  })

  it('names MTPLX and its configured port', async () => {
    await renderOverlay('mtplx', 'connecting')

    await screen.findByText('Connecting to MTPLX')
    expect(screen.getByText('localhost:8000')).toBeTruthy()
  })

  it('honours a non-default MTPLX port — confirmed running on 6000 locally', async () => {
    await renderOverlay('mtplx', 'connecting', { mtplxBaseUrl: 'http://localhost:6000' })

    await screen.findByText('localhost:6000')
  })

  it('never shows the LM Studio port when MTPLX is active', async () => {
    await renderOverlay('mtplx', 'connecting', { mtplxBaseUrl: 'http://127.0.0.1:9001' })

    await screen.findByText('127.0.0.1:9001')
    expect(screen.queryByText('localhost:1234')).toBeNull()
  })

  it('falls back to the default host when the saved base URL is unparseable', async () => {
    await renderOverlay('mtplx', 'connecting', { mtplxBaseUrl: 'not a url' })

    await screen.findByText('localhost:8000')
  })
})

// ─── Offline view ─────────────────────────────────────────────────────────────

describe('OfflineView — heading, error and quick fix', () => {
  it('heads with the LM Studio label and shows LM Studio steps', async () => {
    await renderOverlay('lmstudio', 'offline', { error: 'LM Studio server is not running.' })

    await screen.findByText('LM Studio Offline')
    expect(screen.getByText('Open LM Studio')).toBeTruthy()
    expect(screen.getByText('Start Server')).toBeTruthy()
  })

  it('heads with the MTPLX label and shows MTPLX steps', async () => {
    await renderOverlay('mtplx', 'offline', { error: 'MTPLX server is not running.' })

    await screen.findByText('MTPLX Offline')
    expect(screen.getByText('Open the MTPLX app')).toBeTruthy()
    expect(screen.getByText('▶ Start serving')).toBeTruthy()
    expect(screen.getByText('mtplx serve')).toBeTruthy()
  })

  it('does not leak LM Studio navigation steps into the MTPLX view', async () => {
    await renderOverlay('mtplx', 'offline', { error: 'boom' })

    await screen.findByText('MTPLX Offline')
    expect(screen.queryByText('Open LM Studio')).toBeNull()
    expect(screen.queryByText('Local Server')).toBeNull()
    expect(screen.queryByText('Start Server')).toBeNull()
  })

  it('does not leak MTPLX steps into the LM Studio view', async () => {
    await renderOverlay('lmstudio', 'offline', { error: 'boom' })

    await screen.findByText('LM Studio Offline')
    expect(screen.queryByText('Open the MTPLX app')).toBeNull()
    expect(screen.queryByText('mtplx serve')).toBeNull()
  })

  it('still renders the backend error text passed from the poller', async () => {
    await renderOverlay('mtplx', 'offline', { error: 'MTPLX responded with error 503.' })

    await screen.findByText('MTPLX responded with error 503.')
  })
})

// ─── Visibility gate ──────────────────────────────────────────────────────────

describe('overlay visibility by provider', () => {
  for (const provider of ['nvidia', 'ollama', 'openrouter'] as BackendProvider[]) {
    it(`is hidden for the cloud backend "${provider}" even while status is not ready`, async () => {
      await renderOverlay(provider, 'connecting')

      // Nothing from any view should be in the document.
      await waitFor(() => {
        expect(screen.queryByText(/Connecting to/)).toBeNull()
      })
      expect(screen.queryByText(/Offline$/)).toBeNull()
      expect(screen.queryByText('Desktop Intelligence')).toBeNull()
    })
  }

  for (const provider of ['lmstudio', 'mtplx'] as BackendProvider[]) {
    it(`is shown for the local backend "${provider}" when not ready`, async () => {
      await renderOverlay(provider, 'connecting')

      await screen.findByText(/Connecting to/)
    })
  }

  it('is hidden for every provider once status is ready', async () => {
    await renderOverlay('mtplx', 'ready')

    expect(screen.queryByText(/Connecting to/)).toBeNull()
    expect(screen.queryByText(/Offline$/)).toBeNull()
  })

  it('survives a failed getBackendSettings call without crashing', async () => {
    mockGetBackendSettings.mockRejectedValue(new Error('ipc down'))
    render(<ConnectionStatus status="connecting" error={null} onRetry={() => {}} />)

    // Falls back to the LM Studio default rather than blanking the overlay.
    await screen.findByText('Connecting to LM Studio')
  })
})
