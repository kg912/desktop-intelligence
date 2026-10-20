// Spec B 7c (design 13): the Gantt tab, its tooltip and footer, the compact strips, and the List | Graph | Gantt toggle.
// Rectification R1: the tooltip is hover/focus only, informational, with no buttons.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { GanttView, GanttStrip } from '../../renderer/src/components/chat/GanttView'
import { SEGMENT_LABEL, type SegmentKind } from '../../renderer/src/lib/gantt'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import type { AgentEvent } from '../../shared/types'

const EVENTS = readFileSync(join(__dirname, '../../../resources/python/tests/fixtures/runs/istanbul-3leg/events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentEvent)
const RUN = EVENTS[0].runId
const api = { obsOpenMultiAgentRunFile: vi.fn(async () => '') }
beforeEach(() => { vi.clearAllMocks(); (window as any).api = api })

describe('GanttView on the Istanbul run', () => {
  it('lanes, legend, axis and footer', () => {
    render(<GanttView view={reduceRunEvents(RUN, EVENTS)} />)
    const view = screen.getByTestId('gantt-view')
    expect(within(view).getByText('Where the time went')).toBeTruthy()
    expect(within(view).getByText(/^Timeline · 427 s · \d+ agents peak$/)).toBeTruthy()
    expect(within(screen.getByTestId('gantt-legend')).getAllByText(/./).map((n) => n.textContent)).toEqual(['model', 'tool', 'approval wait', 'judge', 'repair attempt'])
    expect(screen.getAllByTestId(/^gantt-lane-/).map((l) => l.getAttribute('data-testid'))).toEqual(
      ['plan', 'approve', '1.1', '1.2', '1.3', '1.4', '1.5', '2.1', 'synth'].map((id) => `gantt-lane-${id}`))
    const footer = screen.getByTestId('gantt-footer').textContent!
    expect(footer).toContain('Critical path 1.2 → 2.1 → synth')
    expect(footer).toMatch(/Retry time \d+ s/)
    expect(footer).toContain('hover a segment for details')
    expect(footer).not.toContain('call record')
  })

  const segs = (laneId: string) => within(screen.getByTestId(`gantt-lane-${laneId}`)).getAllByRole('button')
  const waitOf21 = () => segs('2.1').find((b) => b.getAttribute('data-kind') === 'wait')!

  it('hover shows the tooltip with its details; leaving hides it', () => {
    render(<GanttView view={reduceRunEvents(RUN, EVENTS)} />)
    expect(screen.queryByTestId('gantt-popover')).toBeNull()
    fireEvent.mouseEnter(waitOf21())
    const pop = screen.getByTestId('gantt-popover')
    expect(pop.getAttribute('role')).toBe('tooltip')
    expect(pop.className).toContain('pointer-events-none')
    expect(pop.textContent).toContain('2.1 · approval wait')
    expect(pop.textContent).toContain('45.7 s')
    expect(pop.textContent).toContain('First tool call, brave_web_search')
    expect(pop.textContent).toContain('Pause to resume: no separate wait was logged (an older run), so this includes the tool')
    expect(pop.textContent).toContain('On the critical path: yes, +46 s')
    expect(within(pop).queryAllByRole('button')).toHaveLength(0)
    expect(pop.querySelector('button')).toBeNull()
    expect(waitOf21().getAttribute('aria-describedby')).toBe(pop.id)
    fireEvent.mouseLeave(waitOf21())
    expect(screen.queryByTestId('gantt-popover')).toBeNull()
    expect(api.obsOpenMultiAgentRunFile).not.toHaveBeenCalled()
  })

  it('keyboard focus shows it; blur and Escape hide it', () => {
    render(<GanttView view={reduceRunEvents(RUN, EVENTS)} />)
    fireEvent.focus(waitOf21())
    expect(screen.getByTestId('gantt-popover').textContent).toContain('2.1 · approval wait')
    fireEvent.blur(waitOf21())
    expect(screen.queryByTestId('gantt-popover')).toBeNull()
    fireEvent.focus(waitOf21())
    fireEvent.keyDown(waitOf21(), { key: 'Escape' })
    expect(screen.queryByTestId('gantt-popover')).toBeNull()
  })

  it('moving straight from one segment to the next shows only the second', () => {
    render(<GanttView view={reduceRunEvents(RUN, EVENTS)} />)
    const [a, b] = segs('1.2')
    fireEvent.mouseEnter(a)
    fireEvent.mouseEnter(b)  // the browser may deliver the next enter before the previous leave
    fireEvent.mouseLeave(a)
    const pops = screen.getAllByTestId('gantt-popover')
    expect(pops).toHaveLength(1)
    expect(pops[0].textContent).toContain(`1.2 · ${SEGMENT_LABEL[b.getAttribute('data-kind') as SegmentKind]}`)
    expect(b.getAttribute('aria-describedby')).toBe(pops[0].id)
    expect(a.getAttribute('aria-describedby')).toBeNull()
    fireEvent.mouseLeave(b)
    expect(screen.queryByTestId('gantt-popover')).toBeNull()
  })

  it('clicking a segment does nothing', () => {
    render(<GanttView view={reduceRunEvents(RUN, EVENTS)} />)
    fireEvent.click(waitOf21())
    expect(screen.queryByTestId('gantt-popover')).toBeNull()
    expect(api.obsOpenMultiAgentRunFile).not.toHaveBeenCalled()
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
