import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { CopyMessageButton } from '../../renderer/src/components/chat/CopyMessageButton'

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else delete (navigator as { clipboard?: unknown }).clipboard
})

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

describe('CopyMessageButton', () => {
  it('copies the exact text it was given', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    render(<CopyMessageButton text={'Answer **one**\n\nline two'} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy response' })) })
    expect(writeText).toHaveBeenCalledWith('Answer **one**\n\nline two')
  })

  it('shows the check state, then reverts after the timeout', async () => {
    vi.useFakeTimers()
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) })
    render(<CopyMessageButton text="x" />)
    const button = screen.getByRole('button', { name: 'Copy response' })
    expect(button.querySelector('.lucide-copy')).not.toBeNull()
    await act(async () => { fireEvent.click(button) })
    expect(button.querySelector('.lucide-check')).not.toBeNull()
    expect(button.className).toContain('text-accent-500')
    act(() => { vi.advanceTimersByTime(1500) })
    expect(button.querySelector('.lucide-copy')).not.toBeNull()
    expect(button.className).not.toContain('text-accent-500')
  })

  it('falls back to a textarea when navigator.clipboard is undefined', async () => {
    setClipboard(undefined)
    let copiedValue: string | null = null
    const execCommand = vi.fn(() => {
      copiedValue = (document.activeElement as HTMLTextAreaElement | null)?.value
        ?? document.querySelector('textarea')?.value ?? null
      return true
    })
    ;(document as { execCommand: unknown }).execCommand = execCommand
    render(<CopyMessageButton text="fallback text" />)
    const button = screen.getByRole('button', { name: 'Copy response' })
    await act(async () => { fireEvent.click(button) })
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(copiedValue).toBe('fallback text')
    expect(document.querySelector('textarea')).toBeNull()
    expect(button.querySelector('.lucide-check')).not.toBeNull()
  })
})
