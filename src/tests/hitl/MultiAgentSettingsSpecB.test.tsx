// Spec B 7e / 7f: the multi-agent settings this spec adds — the "needs you" notification toggle and the
// "Follow-up research" group — their defaults, validation, persistence and what reaches the sidecar.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MultiAgentSettingsPanel } from '../../renderer/src/components/settings/MultiAgentSettingsPanel'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { MultiAgentConfig } from '../../shared/types'

let stored: MultiAgentConfig & { sidecarPort: number }
const save = vi.fn(async (c: MultiAgentConfig & { sidecarPort: number }) => { stored = c })
beforeEach(() => {
  vi.clearAllMocks()
  stored = { ...DEFAULT_MULTI_AGENT_CONFIG, sidecarPort: 7823 }
  ;(window as any).api = {
    getMultiAgentConfig: vi.fn(async () => stored),
    saveMultiAgentConfig: save,
    getMultiAgentSidecarStatus: vi.fn(async () => 'running'),
    getMultiAgentCatalogue: vi.fn(async () => ({ error: null, models: [] })),
    getBackendSettings: vi.fn(async () => ({ openrouterModel: 'm/active' })),
  }
})

const notifyBox = (): HTMLInputElement => screen.getByLabelText(/Notify me when a run needs me/) as HTMLInputElement

describe('7e: notification setting', () => {
  it('is on by default, and turning it off is saved', async () => {
    render(<MultiAgentSettingsPanel />)
    await waitFor(() => expect(notifyBox().checked).toBe(true))
    fireEvent.click(notifyBox())
    fireEvent.click(screen.getByText('Save multi-agent defaults'))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ notifyNeedsYou: false })))
  })
})
