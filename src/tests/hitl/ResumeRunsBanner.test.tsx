// Spec B Phase 5: on start, runs a sidecar restart interrupted are offered as Resume / Discard.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ResumeRunsBanner } from '../../renderer/src/components/chat/ResumeRunsBanner'

const RUNS = [{ runId: 'run-1', chatId: 'chat-1', task: 'Verify the Turkey flight legs', wave: 1, finishedSteps: ['1.1', '1.2'], totalSteps: 5 }]
const api = { listResumableMultiAgentRuns: vi.fn(async () => RUNS), discardMultiAgentRun: vi.fn(async () => {}) }

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as any).api = api
})

describe('ResumeRunsBanner', () => {
  it('offers each interrupted run with its progress; Resume hands it over and hides it', async () => {
    const onResume = vi.fn()
    render(<ResumeRunsBanner onResume={onResume} />)
    const banner = await screen.findByTestId('resume-run-run-1')
    expect(banner.textContent).toContain('A multi-agent run was interrupted: Verify the Turkey flight legs')
    expect(banner.textContent).toContain('2 of 5 steps finished; those are kept.')
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onResume).toHaveBeenCalledWith(RUNS[0])
    await waitFor(() => expect(screen.queryByTestId('resume-run-run-1')).toBeNull())
  })

  it('Discard forgets the run in the sidecar', async () => {
    render(<ResumeRunsBanner onResume={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(api.discardMultiAgentRun).toHaveBeenCalledWith('run-1')
    await waitFor(() => expect(screen.queryByTestId('resume-run-run-1')).toBeNull())
  })

  it('renders nothing when there is nothing to resume', async () => {
    api.listResumableMultiAgentRuns.mockResolvedValueOnce([])
    const { container } = render(<ResumeRunsBanner onResume={vi.fn()} />)
    await waitFor(() => expect(api.listResumableMultiAgentRuns).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
