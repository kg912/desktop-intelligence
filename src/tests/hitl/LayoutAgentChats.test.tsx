/**
 * Layout-level behaviour of agent chats: the mode lock (toggle follows the
 * active chat), the agents rail button state, and the navigation lock while a
 * run is live. Heavy children (chat list rendering, top bar) are stubbed; the
 * Sidebar, InputBar and multi-agent run hook are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { forwardRef } from 'react'

vi.mock('@preact/signals-react/runtime', () => {
  const { useState, useEffect, useRef } = require('react')
  return {
    useSignals: () => {},
    useSignal: (init: any) => {
      const ref = useRef<any>(null)
      const [, forceUpdate] = useState(0)
      if (!ref.current) {
        ref.current = {
          _val: init,
          get value() { return this._val },
          set value(v) { this._val = v; forceUpdate((x: number) => x + 1) },
          peek() { return this._val },
        }
      }
      return ref.current
    },
    useSignalEffect: (cb: any) => { useEffect(() => { cb() }) },
    useComputed: (cb: any) => ({ get value() { return cb() }, peek() { return cb() } }),
  }
})

const sendMessage = vi.fn()
vi.mock('../../renderer/src/hooks/useChat', () => ({
  useChat: () => ({
    isStreaming: false, sendMessage, abort: vi.fn(), loadMessages: vi.fn(), clearMessages: vi.fn(),
    chatSystemInstructions: '', updateChatSystemInstructions: vi.fn(),
  }),
}))
vi.mock('../../renderer/src/components/layout/ChatArea', () => ({
  ChatArea: forwardRef(function ChatArea(_props: unknown, _ref) { return <div data-testid="chat-area" /> }),
}))
vi.mock('../../renderer/src/components/layout/TopBar', () => ({ TopBar: () => <div data-testid="top-bar" /> }))
vi.mock('../../renderer/src/components/settings/SettingsPage', () => ({ SettingsPage: () => <div data-testid="settings-page" /> }))
vi.mock('../../renderer/src/components/chat/CompactingGate', () => ({ CompactingGate: () => null }))

import { Layout } from '../../renderer/src/components/layout/Layout'
import { ModelStoreProvider } from '../../renderer/src/store/ModelStore'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent, Chat } from '../../shared/types'

const chat = (id: string, mode: Chat['mode']): Chat => ({
  id, title: `${id} title`, createdAt: 1, updatedAt: Date.now(), systemInstructions: null, starred: false, mode,
})

let emit: (e: AgentEvent) => void = () => {}
let chats: Chat[] = []
const overrides = {
  getChats: vi.fn(async () => chats),
  getBackendSettings: vi.fn(async () => ({ provider: 'openrouter' })),
  getChatMessages: vi.fn(async () => []),
  getMultiAgentRun: vi.fn(async () => null),
  onMultiAgentEvent: vi.fn((cb: (e: AgentEvent) => void) => { emit = cb; return () => {} }),
  getMultiAgentConfig: vi.fn(async () => DEFAULT_MULTI_AGENT_CONFIG),
  getMultiAgentCatalogue: vi.fn(async () => ({ models: [], error: null })),
  startMultiAgentRun: vi.fn(async () => ({ ok: true, runId: 'run-1' })),
  abortMultiAgentRun: vi.fn(async () => {}),
  newChat: vi.fn(async (id: string, title: string, mode?: Chat['mode']) => chat(id, mode ?? 'single')),
  saveMessage: vi.fn(async () => {}),
  obsGetPrefs: vi.fn(async () => ({ observabilityEnabled: false })),
}

beforeEach(() => {
  vi.clearAllMocks()
  overrides.getBackendSettings.mockResolvedValue({ provider: 'openrouter' })
  chats = [chat('regular', 'single'), chat('agents', 'multi-agent')]
  ;(window as any).api = new Proxy(overrides, {
    get: (target, key) =>
      key in target ? (target as any)[key]
        : typeof key === 'string' && key.startsWith('on') ? () => () => {}
        : async () => undefined,
  })
})

const toggle = (): HTMLElement => screen.getByText('Multi-Agent').closest('button')!
const send = async (text: string) => {
  const box = document.querySelector('textarea')!
  fireEvent.change(box, { target: { value: text } })
  await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
}
const openChat = async (title: string) => {
  await act(async () => { fireEvent.click(screen.getByText(title)) })
}

async function renderLayout() {
  render(<ModelStoreProvider><Layout /></ModelStoreProvider>)
  await screen.findByText('regular title')
  await screen.findByText('Multi-Agent')
}

describe('Part A — mode lock in the renderer', () => {
  it('a regular chat greys the toggle off; an agent chat forces it on; both are locked with a tooltip', async () => {
    await renderLayout()
    await openChat('regular title')
    expect(toggle().getAttribute('data-active')).toBe('false')
    expect(toggle().getAttribute('aria-disabled')).toBe('true')
    expect(toggle().title).toBe('This chat is a regular chat. Start a new chat to use agents.')
    fireEvent.click(toggle())
    expect(toggle().getAttribute('data-active')).toBe('false')

    await openChat('agents title')
    expect(toggle().getAttribute('data-active')).toBe('true')
    expect(toggle().getAttribute('aria-disabled')).toBe('true')
    expect(toggle().title).toBe('Agent chats stay in agent mode.')
  })

  it('switching chats sets the toggle from the destination chat, and a new chat is free and starts off', async () => {
    await renderLayout()
    // New chat (no id): free to choose.
    fireEvent.click(toggle())
    expect(toggle().getAttribute('data-active')).toBe('true')
    expect(toggle().getAttribute('aria-disabled')).toBe('false')
    await openChat('regular title')
    expect(toggle().getAttribute('data-active')).toBe('false')
    await openChat('agents title')
    expect(toggle().getAttribute('data-active')).toBe('true')
    await act(async () => { fireEvent.click(screen.getByText('New')) })
    expect(toggle().getAttribute('data-active')).toBe('false')
    expect(toggle().getAttribute('aria-disabled')).toBe('false')
  })

  it('every send in an agent chat goes through the multi-agent path', async () => {
    await renderLayout()
    await openChat('agents title')
    await send('Plan a trip')
    await waitFor(() => expect(overrides.startMultiAgentRun).toHaveBeenCalledTimes(1))
    expect(overrides.startMultiAgentRun.mock.calls[0][0]).toMatchObject({ chatId: 'agents', task: 'Plan a trip' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('a new chat sent with the toggle on is created as an agent chat', async () => {
    await renderLayout()
    fireEvent.click(toggle())
    await send('Research hotels')
    await waitFor(() => expect(overrides.newChat).toHaveBeenCalledWith(expect.any(String), 'Research hotels', 'multi-agent'))
    expect(sendMessage).not.toHaveBeenCalled()
  })
})


describe('Part B — agents rail button', () => {
  const rail = (): HTMLElement => document.querySelector('.ma-rail-btn') as HTMLElement

  it('is always rendered on OpenRouter; disabled with a tooltip in a regular chat and a new chat; clicking does nothing', async () => {
    await renderLayout()
    expect(rail().getAttribute('aria-disabled')).toBe('true')
    expect(rail().title).toBe('Only available in agent chats')
    await openChat('regular title')
    expect(rail().getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(rail())
    expect(screen.getByTestId('sidebar-panel').dataset.mode).toBe('chat')
    expect(screen.queryByText('No agent run in this chat yet')).toBeNull()
  })

  it('is enabled in an agent chat and opens the dock; leaving for a regular chat greys it and closes the dock', async () => {
    await renderLayout()
    await openChat('agents title')
    expect(rail().getAttribute('aria-disabled')).toBeNull()
    expect(rail().title).toBe('Agent run')
    await act(async () => { fireEvent.click(rail()) })
    expect(screen.getByTestId('sidebar-panel').dataset.mode).toBe('agents')
    await act(async () => { fireEvent.click(screen.getByTitle('Chats')) })
    await openChat('regular title')
    expect(rail().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('sidebar-panel').dataset.mode).toBe('chat')
  })

  it('is not rendered on other backends', async () => {
    overrides.getBackendSettings.mockResolvedValue({ provider: 'lmstudio' })
    render(<ModelStoreProvider><Layout /></ModelStoreProvider>)
    await screen.findByText('regular title')
    expect(rail()).toBeNull()
  })
})

describe('Part C — navigation lock while a run is live', () => {
  const LOCK = 'Agents are running. Abort the run to leave.'
  const step = { id: '1.1', label: 'Find hotels', stage: 'worker', role: 'Researcher', model: 'w', phase: 1 }
  const push = async (seq: number, body: Record<string, unknown>) => {
    await act(async () => {
      emit({ runId: 'run-1', seq, ts: seq, ...body } as AgentEvent)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
  }
  const panelMode = (): string | undefined => screen.getByTestId('sidebar-panel').dataset.mode
  const chatsRail = (): HTMLElement => screen.getAllByTitle(LOCK).find((el) => el.getAttribute('role') === 'button' && el.querySelector('svg'))!

  function expectLocked(): void {
    const locked = screen.getAllByTitle(LOCK).filter((el) => el.getAttribute('aria-disabled') === 'true')
    expect(locked).toHaveLength(3) // Chats, Starred, Settings
    fireEvent.click(chatsRail())
    expect(panelMode()).toBe('agents')
    expect(screen.queryByTestId('settings-page')).toBeNull()
  }
  function expectUnlocked(): void {
    expect(screen.queryAllByTitle(LOCK)).toHaveLength(0)
    expect(screen.getByTitle('Chats').tagName).toBe('BUTTON')
    expect(screen.getByTitle('Starred chats').tagName).toBe('BUTTON')
    expect(screen.getByTitle('Settings').tagName).toBe('BUTTON')
  }

  async function startRun(): Promise<void> {
    await renderLayout()
    await openChat('agents title')
    await send('Plan a 12-day trip')
    await waitFor(() => expect(panelMode()).toBe('agents'))
  }

  it('engages on run start, holds through the plan and tool approvals, releases on completion', async () => {
    await startRun()
    expectLocked() // planning
    await push(1, { type: 'orchestrator_plan', steps: [step] })
    await push(2, { type: 'hitl_pause', agentId: 'orchestrator', role: 'Orchestrator', toolName: 'approve_plan', serverName: 'multi-agent', args: {} })
    expectLocked() // waiting on plan approval
    await push(3, { type: 'hitl_resume', agentId: 'orchestrator', approved: true })
    await push(4, { type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'w', attempt: 0 })
    await push(5, { type: 'hitl_pause', agentId: '1.1', role: 'Researcher', toolName: 'brave_web_search', serverName: 'builtin', args: { query: 'x' } })
    expectLocked() // waiting on a tool approval
    await push(6, { type: 'hitl_resume', agentId: '1.1', approved: true })
    await push(7, { type: 'task_complete', finalOutput: 'Done', totalCostUsd: 0, totalTokens: 0 })
    expectUnlocked()
    expect(panelMode()).toBe('agents') // the dock stays open
    await act(async () => { fireEvent.click(screen.getByTitle('Chats')) })
    expect(panelMode()).toBe('chat')
  })

  it('releases when the run fails', async () => {
    await startRun()
    await push(1, { type: 'orchestrator_plan', steps: [step] })
    expectLocked()
    await push(2, { type: 'task_failed', reason: 'No agent produced an output' })
    expectUnlocked()
  })

  it('releases when the run is aborted; Abort stays usable while locked', async () => {
    await startRun()
    await push(1, { type: 'orchestrator_plan', steps: [step] })
    await push(2, { type: 'hitl_resume', agentId: 'orchestrator', approved: true })
    await push(3, { type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'w', attempt: 0 })
    expectLocked()
    await act(async () => { fireEvent.click(screen.getByText('Abort')) })
    expect(overrides.abortMultiAgentRun).toHaveBeenCalledWith('run-1')
    await push(4, { type: 'task_failed', reason: 'Run aborted by user' })
    expectUnlocked()
  })

  it('collapsing the dock is allowed while locked; it never switches to the chat list', async () => {
    await startRun()
    await act(async () => { fireEvent.click(document.querySelector('.ma-rail-btn')!) })
    expect(panelMode()).toBe('closed')
    await act(async () => { fireEvent.click(document.querySelector('.ma-rail-btn')!) })
    expect(panelMode()).toBe('agents')
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(panelMode()).toBe('closed')
  })
})
