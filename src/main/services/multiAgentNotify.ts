// Spec B 7e: a system notification when a multi-agent run needs the user while the window is in the background.
import { IPC_CHANNELS } from '../../shared/types'

interface NotifyWindow {
  isFocused(): boolean
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  webContents: { send(channel: string, ...args: unknown[]): void }
}

interface NotificationLike {
  on(event: 'click', listener: () => void): unknown
  show(): void
}

export interface NotifyDeps {
  window: NotifyWindow | null
  Notification: { new (options: { title: string; body: string }): NotificationLike; isSupported(): boolean }
}

/** Shown only while the window is unfocused (true when shown). A click restores and focuses the window and opens the
 *  chat's run (MULTI_AGENT_FOCUS_RUN). */
export function notifyNeedsYou(deps: NotifyDeps, payload: { title: string; body: string; chatId: string }): boolean {
  const win = deps.window
  if (!win || win.isDestroyed() || win.isFocused() || !deps.Notification.isSupported()) return false
  const notification = new deps.Notification({ title: payload.title, body: payload.body })
  notification.on('click', () => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send(IPC_CHANNELS.MULTI_AGENT_FOCUS_RUN, payload.chatId)
  })
  notification.show()
  return true
}
