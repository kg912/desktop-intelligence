import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { FsAccessDialog } from '../../renderer/src/components/chat/FsAccessDialog'
import type { FsAccessRequestEvent, FsPickResult } from '../../shared/fsAccess'

const request = (over: Partial<FsAccessRequestEvent> = {}): FsAccessRequestEvent => ({
  requestId: 'r1',
  chatId: 'c1',
  path: '/Users/you/Certifications_and_upskilling/foundation-harness',
  access: 'write',
  reason: "You asked me to fix the typo in this project's README.md.",
  timeoutMs: 120_000,
  ...over,
})

let onRespond: ReturnType<typeof vi.fn>
let nextPick: FsPickResult
beforeEach(() => {
  onRespond = vi.fn()
  nextPick = { ok: false, cancelled: true }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const renderDialog = (over: Partial<FsAccessRequestEvent> = {}) =>
  render(<FsAccessDialog request={request(over)} onRespond={onRespond} pickFolder={async () => nextPick} />)

describe('FsAccessDialog', () => {
  it('shows the request: title for the access, the path, the reason as a quote, the access preset', () => {
    renderDialog()
    expect(screen.getByRole('heading', { name: 'DI wants to read and edit files in' })).toBeTruthy()
    expect(screen.getByTestId('fs-access-path').textContent).toBe('/Users/you/Certifications_and_upskilling/foundation-harness')
    expect(screen.getByText('Reason from the model')).toBeTruthy()
    expect(screen.getByText("You asked me to fix the typo in this project's README.md.").tagName).toBe('BLOCKQUOTE')
    expect((screen.getByRole('radio', { name: 'Read & write' }) as HTMLInputElement).checked).toBe(true)
  })

  it('a read request reads "DI wants to read files in" with Read-only preset', () => {
    renderDialog({ access: 'read' })
    expect(screen.getByRole('heading', { name: 'DI wants to read files in' })).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'Read-only' }) as HTMLInputElement).checked).toBe(true)
  })

  it('each button sends the right response', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this chat' }))
    expect(onRespond).toHaveBeenLastCalledWith({ requestId: 'r1', decision: 'chat', access: 'write', path: request().path })
    cleanup()
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(onRespond).toHaveBeenLastCalledWith({ requestId: 'r1', decision: 'always', access: 'write', path: request().path })
    cleanup()
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onRespond).toHaveBeenLastCalledWith({ requestId: 'r1', decision: 'deny', access: 'write', path: request().path })
  })

  it('downgrade to read-only is sent with the allow', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Read-only' }))
    expect(screen.getByRole('heading', { name: 'DI wants to read files in' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this chat' }))
    expect(onRespond).toHaveBeenCalledWith({ requestId: 'r1', decision: 'chat', access: 'read', path: request().path })
  })

  it('a picked folder replaces the shown path; an invalid pick shows why and keeps the path', async () => {
    nextPick = { ok: false, reason: '/Users/you is your home folder. Choose a specific project folder inside it.' }
    renderDialog()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose a different folder…' })))
    expect(screen.getByRole('alert').textContent).toBe('/Users/you is your home folder. Choose a specific project folder inside it.')
    expect(screen.getByTestId('fs-access-path').textContent).toBe(request().path)
    nextPick = { ok: true, root: { path: '/Users/you/other', access: 'read', askBeforeEdit: true, addedAt: 1 } }
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Choose a different folder…' })))
    expect(screen.getByTestId('fs-access-path').textContent).toBe('/Users/you/other')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this chat' }))
    expect(onRespond).toHaveBeenCalledWith({ requestId: 'r1', decision: 'chat', access: 'write', path: '/Users/you/other' })
  })

  it('Escape denies, and focus starts on Deny', () => {
    renderDialog()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Deny' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRespond).toHaveBeenCalledWith({ requestId: 'r1', decision: 'deny', access: 'write', path: request().path })
  })

  it('counts down to the auto-deny', () => {
    vi.useFakeTimers()
    renderDialog()
    expect(screen.getByText('Auto-denies in 2:00')).toBeTruthy()
    act(() => vi.advanceTimersByTime(6_000))
    expect(screen.getByText('Auto-denies in 1:54')).toBeTruthy()
  })

  it('answers only once', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRespond).toHaveBeenCalledTimes(1)
  })
})
