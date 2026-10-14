// Spec B 7c (design 13): the Gantt tab, its popover and footer, the compact strips, and the List | Graph | Gantt toggle.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { GanttView, GanttStrip, recordFileOf } from '../../renderer/src/components/chat/GanttView'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import type { AgentEvent } from '../../shared/types'

const EVENTS = readFileSync(join(__dirname, '../../../resources/python/tests/fixtures/runs/istanbul-3leg/events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentEvent)
const RUN = EVENTS[0].runId
const api = { obsOpenMultiAgentRunFile: vi.fn(async () => '') }
beforeEach(() => { vi.clearAllMocks(); (window as any).api = api })

describe('GanttView on the Istanbul run', () => {
  it('lanes, legend, axis and footer', () => {
    render(<GanttView view={reduceRunEvents(RUN, EVENTS)} chatId="chat-1" />)
    const view = screen.getByTestId('gantt-view')
    expect(within(view).getByText('Where the time went')).toBeTruthy()
    expect(within(view).getByText(/^Timeline · 427 s · \d+ agents peak$/)).toBeTruthy()
    expect(within(screen.getByTestId('gantt-legend')).getAllByText(/./).map((n) => n.textContent)).toEqual(['model', 'tool', 'approval wait', 'judge', 'repair attempt'])
    expect(screen.getAllByTestId(/^gantt-lane-/).map((l) => l.getAttribute('data-testid'))).toEqual(
      ['plan', 'approve', '1.1', '1.2', '1.3', '1.4', '1.5', '2.1', 'synth'].map((id) => `gantt-lane-${id}`))
    const footer = screen.getByTestId('gantt-footer').textContent!
    expect(footer).toContain('Critical path 1.2 → 2.1 → synth')
    expect(footer).toMatch(/Retry time \d+ s/)
    expect(footer).toContain('click any segment to open its call record')
  })

  it('a segment\'s popover: duration, the older run\'s pause-to-resume wait, critical path, and Open call record', () => {
    render(<GanttView view={reduceRunEvents(RUN, EVENTS)} chatId="chat-1" />)
    const lane = screen.getByTestId('gantt-lane-2.1')
    const wait = within(lane).getAllByRole('button').find((b) => b.getAttribute('data-kind') === 'wait')!
    fireEvent.click(wait)
    const pop = screen.getByTestId('gantt-popover')
    expect(pop.textContent).toContain('2.1 · approval wait')
    expect(pop.textContent).toContain('45.7 s')
    expect(pop.textContent).toContain('First tool call, brave_web_search')
    expect(pop.textContent).toContain('Pause to resume: no separate wait was logged (an older run), so this includes the tool')
    expect(pop.textContent).toContain('On the critical path: yes, +46 s')
    fireEvent.click(within(pop).getByRole('button', { name: 'Open call record' }))
    expect(api.obsOpenMultiAgentRunFile).toHaveBeenCalledWith('chat-1', RUN, 'agent-2.1.md')
    expect([recordFileOf('plan'), recordFileOf('synth'), recordFileOf('1.2')]).toEqual(['planner.md', 'synthesis.md', 'agent-1.2.md'])
  })

  it('a run in progress draws open-ended segments to now', () => {
    const cut = EVENTS.findIndex((e) => e.type === 'tool_start' && (e as { agentId?: string }).agentId === '1.3')
    const now = EVENTS[cut].ts + 5_000
    render(<GanttView view={reduceRunEvents(RUN, EVENTS.slice(0, cut + 1))} now={now} />)
    const open = within(screen.getByTestId('gantt-lane-1.3')).getAllByRole('button').filter((b) => b.getAttribute('data-open') === 'true')
    expect(open).toHaveLength(1)
    expect(Number(open[0].style.left.replace('%', '')) + Number(open[0].style.width.replace('%', ''))).toBeCloseTo(100, 0)  // reaches "now"
  })

  it('the compact strip shows the same lanes', () => {
    render(<GanttStrip view={reduceRunEvents(RUN, EVENTS)} />)
    expect(screen.getAllByTestId(/^gantt-strip-/).length).toBe(9)
  })
})

describe('the List view\'s timeline lanes', () => {
  it('draw each agent\'s real segments over its status bar', async () => {
    const { MultiAgentSidebarView } = await import('../../renderer/src/components/chat/MultiAgentSidebarView')
    const { DEFAULT_MULTI_AGENT_CONFIG } = await import('../../shared/types')
    render(<MultiAgentSidebarView view={reduceRunEvents(RUN, EVENTS)} task="t" config={DEFAULT_MULTI_AGENT_CONFIG} readOnly estimate={null} permissionRequests={[]}
      onRespondPermission={vi.fn()} onApprove={vi.fn()} onCancel={vi.fn()} onAbort={vi.fn()} focusAgentId={null} onSelectAgent={vi.fn()} onClose={vi.fn()} />)
    const lane = screen.getByTestId('lane-1.2')
    expect(lane.querySelector('i')!.dataset.s).toBeTruthy()  // the status bar stays
    const kinds = new Set([...lane.querySelectorAll('b[data-kind]')].map((b) => b.getAttribute('data-kind')))
    expect([...kinds].sort()).toEqual(['judge', 'model', 'repair', 'wait'])
  })
})
