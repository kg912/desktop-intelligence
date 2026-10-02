/** Observability spec Phase 4: Settings → Debug → Multi-agent runs. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MultiAgentRunsPanel, EVENTS_PAGE, planColumns } from '../../renderer/src/components/settings/MultiAgentRunsPanel'
import { observabilityMock } from '../../renderer/src/mocks/observabilityDemo'

const api = {
  ...observabilityMock,
  obsOpenMultiAgentRunFile: vi.fn(async () => ''),
  obsRevealMultiAgentRun: vi.fn(async () => {}),
  obsDeleteMultiAgentRun: vi.fn(observabilityMock.obsDeleteMultiAgentRun),
  obsListMultiAgentRunEvents: vi.fn(observabilityMock.obsListMultiAgentRunEvents),
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: typeof api }).api = api
})

const rowFor = async (title: string): Promise<HTMLElement> => (await screen.findByText(title)).closest('[class*="grid"]') as HTMLElement

describe('MultiAgentRunsPanel', () => {
  it('lists runs newest first with status, cost, duration and anomaly count; a run started while off is "not recorded"', async () => {
    render(<MultiAgentRunsPanel enabled onEnable={() => {}} />)
    const done = await rowFor('Compare castle hotels near Füssen')
    expect(within(done).getByText('completed')).toBeTruthy()
    expect(within(done).getByText('$0.0412')).toBeTruthy()
    expect(within(done).getByText('48.2s')).toBeTruthy()
    expect(within(done).getByText('2 ⚠')).toBeTruthy()
    const off = await rowFor('Which castle tickets sell out first?')
    expect(within(off).getByText('not recorded')).toBeTruthy()
    expect(within(off).getByText(/observability was off when this run started/)).toBeTruthy()
    expect(off.getAttribute('role')).toBeNull() // not selectable
    expect(screen.getByText('3 recorded · 1 not recorded')).toBeTruthy()
  })

  it('with observability off it says so in plain words and offers the toggle; past runs still show', async () => {
    const onEnable = vi.fn()
    render(<MultiAgentRunsPanel enabled={false} onEnable={onEnable} />)
    expect(screen.getByText('Observability is off, so multi-agent runs are not being recorded.')).toBeTruthy()
    fireEvent.click(screen.getByText('Turn on observability'))
    expect(onEnable).toHaveBeenCalled()
    expect(await screen.findByText('Which castle tickets sell out first?')).toBeTruthy()
  })

  it('selecting a run shows the plan, the timeline and the anomalies; a bar opens the file holding that call', async () => {
    render(<MultiAgentRunsPanel enabled onEnable={() => {}} />)
    fireEvent.click(await rowFor('Compare castle hotels near Füssen'))
    const detail = await screen.findByTestId('ma-run-detail')
    expect(within(detail).getByText('2.1 Editor')).toBeTruthy()
    expect(within(detail).getByText('3 calls')).toBeTruthy() // peak parallel
    expect(within(screen.getByTestId('ma-anomalies')).getByText('length')).toBeTruthy()
    fireEvent.click(within(detail).getByLabelText('Call 6: open agent-1.3.md'))
    expect(api.obsOpenMultiAgentRunFile).toHaveBeenCalledWith('chat-hotels', expect.any(String), 'agent-1.3.md')
  })

  it('row actions: open run.md, reveal, copy run id, delete (two clicks)', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<MultiAgentRunsPanel enabled onEnable={() => {}} />)
    const row = await rowFor('Summarise the Q3 board pack')
    fireEvent.click(within(row).getByLabelText('Open run.md'))
    expect(api.obsOpenMultiAgentRunFile).toHaveBeenCalledWith('chat-board', '2b9d0f44-1c3a-4e8b-9f21-77aa01c3d5e0')
    fireEvent.click(within(row).getByLabelText('Reveal folder'))
    expect(api.obsRevealMultiAgentRun).toHaveBeenCalledWith('chat-board', '2b9d0f44-1c3a-4e8b-9f21-77aa01c3d5e0')
    fireEvent.click(within(row).getByLabelText('Copy run id'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('2b9d0f44-1c3a-4e8b-9f21-77aa01c3d5e0'))
    fireEvent.click(within(row).getByLabelText('Delete'))
    expect(api.obsDeleteMultiAgentRun).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByLabelText('Click again to delete'))
    await waitFor(() => expect(screen.queryByText('Summarise the Q3 board pack')).toBeNull())
  })

  it('raw UI events for the selected run page newest first', async () => {
    render(<MultiAgentRunsPanel enabled onEnable={() => {}} />)
    fireEvent.click(await rowFor('Compare castle hotels near Füssen'))
    const events = await screen.findByTestId('ma-raw-events')
    await waitFor(() => expect(within(events).getByText('#212')).toBeTruthy()) // the newest
    expect(within(events).getByText(`Events 1–${EVENTS_PAGE} of 60`)).toBeTruthy()
    expect((within(events).getByText('Newer') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(events).getByText('Older'))
    await waitFor(() => expect(api.obsListMultiAgentRunEvents).toHaveBeenLastCalledWith('chat-hotels', expect.any(String), EVENTS_PAGE, EVENTS_PAGE))
    await waitFor(() => expect(within(events).queryByText('#212')).toBeNull())
  })

  it('plan columns follow dependency depth', () => {
    const cols = planColumns([
      { id: '1.1', role: 'a', label: '', dependsOn: [] },
      { id: '1.2', role: 'b', label: '', dependsOn: [] },
      { id: '2.1', role: 'c', label: '', dependsOn: ['1.1'] },
      { id: '3.1', role: 'd', label: '', dependsOn: ['2.1', '1.2'] },
    ])
    expect(cols.map((c) => c.map((s) => s.id))).toEqual([['1.1', '1.2'], ['2.1'], ['3.1']])
  })
})
