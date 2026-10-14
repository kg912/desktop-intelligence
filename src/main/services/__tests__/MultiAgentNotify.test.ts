// Spec B 7e: main shows the notification only while the window is unfocused; a click brings the run forward.
import { describe, it, expect, vi } from 'vitest'
import { notifyNeedsYou } from '../multiAgentNotify'
import { IPC_CHANNELS } from '../../../shared/types'

function fakes(focused: boolean, supported = true) {
  const shown: Array<{ title: string; body: string; click?: () => void }> = []
  class FakeNotification {
    static isSupported = () => supported
    private click?: () => void
    constructor(private opts: { title: string; body: string }) {}
    on(event: string, fn: () => void) { if (event === 'click') this.click = fn; return this }
    show() { shown.push({ ...this.opts, click: this.click }) }
  }
  const win = { isFocused: () => focused, isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } }
  return { shown, win, Notification: FakeNotification }
}

describe('notifyNeedsYou', () => {
  it('unfocused: shows it; a click restores and focuses the window and opens the chat\'s run', () => {
    const { shown, win, Notification } = fakes(false)
    expect(notifyNeedsYou({ window: win, Notification }, { title: 'A multi-agent run needs you', body: 'Leg 2 asks to run brave_web_search.', chatId: 'chat-1' })).toBe(true)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ title: 'A multi-agent run needs you', body: 'Leg 2 asks to run brave_web_search.' })
    shown[0].click!()
    expect(win.restore).toHaveBeenCalled()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.MULTI_AGENT_FOCUS_RUN, 'chat-1')
  })

  it('focused, unsupported or no window: nothing', () => {
    const payload = { title: 't', body: 'b', chatId: 'c' }
    const focused = fakes(true)
    expect(notifyNeedsYou({ window: focused.win, Notification: focused.Notification }, payload)).toBe(false)
    const unsupported = fakes(false, false)
    expect(notifyNeedsYou({ window: unsupported.win, Notification: unsupported.Notification }, payload)).toBe(false)
    expect(notifyNeedsYou({ window: null, Notification: focused.Notification }, payload)).toBe(false)
    expect(focused.shown.length + unsupported.shown.length).toBe(0)
  })
})
