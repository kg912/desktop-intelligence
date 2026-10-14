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

describe('7f: Follow-up research', () => {
  it('defaults render as 0.15 USD / 2 waves / the judge model, with the helper texts and the fixed note', async () => {
    render(<MultiAgentSettingsPanel />)
    const group = await screen.findByTestId('follow-up-settings')
    expect((screen.getByLabelText('Auto-run follow-ups up to (USD)') as HTMLInputElement).value).toBe('0.15')
    expect(screen.getByTestId('max-waves-value').textContent).toBe('2')
    expect(screen.getByRole('combobox', { name: 'Assess model' }).textContent).toContain('Same as the reflection model')
    expect(group.textContent).toContain('After the first round of research, Claude may propose extra steps to close conflicts or gaps. Follow-ups estimated at or below this amount run automatically; anything above asks you first. Set to 0 to always ask.')
    expect(group.textContent).toContain('1 = the first round only, no follow-ups. 2 = the first round plus one follow-up round.')
    expect(group.textContent).toContain('Decides whether the run is done. Uses a small, cheap call.')
    expect(group.textContent).toContain('Follow-ups never exceed the run\'s budget cap, and never run for gaps no available tool can close.')
  })

  it('changes are saved and come back after a reload', async () => {
    const first = render(<MultiAgentSettingsPanel />)
    await screen.findByTestId('follow-up-settings')
    fireEvent.change(screen.getByLabelText('Auto-run follow-ups up to (USD)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fewer research waves' }))
    expect(screen.getByTestId('max-waves-value').textContent).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Fewer research waves' }))  // already at the minimum
    expect(screen.getByTestId('max-waves-value').textContent).toBe('1')
    fireEvent.click(screen.getByText('Save multi-agent defaults'))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ followUpAutoUsd: 0, maxWaves: 1 })))
    first.unmount()
    render(<MultiAgentSettingsPanel />)  // reload: the stored config comes back
    await screen.findByTestId('follow-up-settings')
    await waitFor(() => expect(screen.getByTestId('max-waves-value').textContent).toBe('1'))
    expect((screen.getByLabelText('Auto-run follow-ups up to (USD)') as HTMLInputElement).value).toBe('0')
  })

  it('invalid input is rejected with an inline message (negative, not a number, above the budget cap)', async () => {
    render(<MultiAgentSettingsPanel />)
    await screen.findByTestId('follow-up-settings')
    const box = screen.getByLabelText('Auto-run follow-ups up to (USD)')
    for (const bad of ['-0.1', 'abc', '0.75']) {
      fireEvent.change(box, { target: { value: bad } })
      expect(screen.getByTestId('follow-up-usd-error').textContent).toBe('Enter an amount from 0 to the 0.50 USD budget cap.')
    }
    fireEvent.click(screen.getByText('Save multi-agent defaults'))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ followUpAutoUsd: 0.15 })))  // the rejected value never reached the config
    fireEvent.change(box, { target: { value: '0.3' } })
    expect(screen.queryByTestId('follow-up-usd-error')).toBeNull()
  })
})

describe('7f: effective values in the pre-flight', () => {
  it('says when follow-ups auto-run and how many waves, or that there are none', async () => {
    const { Preflight } = await import('../../renderer/src/components/chat/MultiAgentSidebarView')
    const { reduceRunEvents } = await import('../../renderer/src/lib/multiAgentRunState')
    const view = reduceRunEvents('r', [{ runId: 'r', seq: 1, ts: 1, type: 'orchestrator_plan', steps: [] } as never])
    const estimate = { minUsd: 0.1, maxUsd: 0.3, unpricedModels: [] }
    const { rerender } = render(<Preflight view={view} config={DEFAULT_MULTI_AGENT_CONFIG} estimate={estimate} onApprove={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('preflight-follow-up').textContent).toBe('Follow-ups auto-run under $0.15 · up to 2 research waves')
    rerender(<Preflight view={view} config={{ ...DEFAULT_MULTI_AGENT_CONFIG, maxWaves: 1 }} estimate={estimate} onApprove={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('preflight-follow-up').textContent).toBe('No follow-up research (1 wave)')
  })
})
