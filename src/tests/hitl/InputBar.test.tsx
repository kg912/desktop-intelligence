import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'

// Mock Preact signals React runtime to avoid concurrent work tracking errors in jsdom
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
          set value(v) {
            this._val = v
            forceUpdate((x: number) => x + 1)
          },
          peek() { return this._val }
        }
      }
      return ref.current
    },
    useSignalEffect: (cb: any) => {
      useEffect(() => {
        cb()
      })
    },
    useComputed: (cb: any) => {
      return {
        get value() { return cb() },
        peek() { return cb() }
      }
    }
  }
})

import { InputBar } from '../../renderer/src/components/layout/InputBar'
import { ModelStoreProvider } from '../../renderer/src/store/ModelStore'
import { isStreamingSignal } from '../../renderer/src/signals/chatSignals'

// Mock Electron IPC bridge on existing window object without overwriting it!
const mockSetBypassPermissions = vi.fn().mockResolvedValue(undefined)
const mockGetFilePath = vi.fn().mockImplementation((file: any) => file.path || `/mock/${file.name}`)

if (typeof window !== 'undefined') {
  (window as any).api = {
    setBypassPermissions: (...args: any[]) => mockSetBypassPermissions(...args),
    getFilePath: (...args: any[]) => mockGetFilePath(...args),
  }
}

describe('InputBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      isStreamingSignal.value = false
    })
  })

  afterEach(() => {
    act(() => {
      cleanup()
    })
  })

  const renderInputBar = (props = {}) => {
    let result: any
    act(() => {
      result = render(
        <ModelStoreProvider>
          <InputBar onSend={vi.fn()} onAbort={vi.fn()} {...props} />
        </ModelStoreProvider>
      )
    })
    return result
  }

  const getSendButton = () => {
    // Find the button containing the ArrowUp or Square icon
    const buttons = screen.getAllByRole('button')
    const sendBtn = buttons.find((btn) => 
      btn.querySelector('svg.lucide-arrow-up, svg.lucide-square, .lucide-arrow-up, .lucide-square')
    )
    if (!sendBtn) {
      throw new Error('Send/Stop button not found in DOM')
    }
    return sendBtn
  }

  it('renders typing textarea, paperclip button, and send button', () => {
    renderInputBar()
    expect(screen.getByPlaceholderText('Message… (Shift+Enter for newline)')).toBeTruthy()
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('typing updates the textarea value', () => {
    renderInputBar()
    const textarea = screen.getByPlaceholderText('Message… (Shift+Enter for newline)') as HTMLTextAreaElement
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Hello Qwen' } })
    })
    expect(textarea.value).toBe('Hello Qwen')
  })

  it('clicking send button calls onSend and resets textarea', () => {
    const onSend = vi.fn()
    renderInputBar({ onSend })
    const textarea = screen.getByPlaceholderText('Message… (Shift+Enter for newline)') as HTMLTextAreaElement
    
    // Type text
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Hello Qwen' } })
    })
    
    // Click send
    const sendBtn = getSendButton()
    act(() => {
      fireEvent.click(sendBtn)
    })

    expect(onSend).toHaveBeenCalledWith('Hello Qwen', [])
    expect(textarea.value).toBe('')
  })

  it('pressing Enter (without Shift) triggers onSend and clears textarea', () => {
    const onSend = vi.fn()
    renderInputBar({ onSend })
    const textarea = screen.getByPlaceholderText('Message… (Shift+Enter for newline)') as HTMLTextAreaElement
    
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Message on Enter' } })
    })
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: false })
    })

    expect(onSend).toHaveBeenCalledWith('Message on Enter', [])
    expect(textarea.value).toBe('')
  })

  it('pressing Shift+Enter does NOT trigger onSend and preserves textarea content', () => {
    const onSend = vi.fn()
    renderInputBar({ onSend })
    const textarea = screen.getByPlaceholderText('Message… (Shift+Enter for newline)') as HTMLTextAreaElement
    
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Multi-line message' } })
    })
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true })
    })

    expect(onSend).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Multi-line message')
  })

  it('attaching a file via file input renders the badge and passes to onSend', () => {
    const onSend = vi.fn()
    renderInputBar({ onSend })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['hello'], 'doc.pdf', { type: 'application/pdf' })

    // Simulate file attachment
    act(() => {
      fireEvent.change(input, { target: { files: [file] } })
    })

    // Verify badge renders
    expect(screen.getByText('doc.pdf')).toBeTruthy()

    // Send
    const sendBtn = getSendButton()
    act(() => {
      fireEvent.click(sendBtn)
    })

    expect(onSend).toHaveBeenCalledWith('', [
      expect.objectContaining({
        name: 'doc.pdf',
        type: 'document',
        filePath: '/mock/doc.pdf',
      })
    ])
  })

  it('skips duplicate attachments with identical name and size', () => {
    renderInputBar()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file1 = new File(['hello'], 'doc.pdf', { type: 'application/pdf' })
    const file2 = new File(['hello'], 'doc.pdf', { type: 'application/pdf' })

    act(() => {
      fireEvent.change(input, { target: { files: [file1] } })
    })
    act(() => {
      fireEvent.change(input, { target: { files: [file2] } })
    })

    // Only one badge should render
    const badges = screen.getAllByText('doc.pdf')
    expect(badges).toHaveLength(1)
  })

  it('displays size warning for images larger than 5MB', () => {
    renderInputBar()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    
    // Create mock file with size > 5MB
    const largeImage = new File([''], 'large.png', { type: 'image/png' })
    Object.defineProperty(largeImage, 'size', { value: 6 * 1024 * 1024 })

    act(() => {
      fireEvent.change(input, { target: { files: [largeImage] } })
    })

    // Verify size error renders
    expect(screen.getByText(/"large.png" is 6.0 MB — images must be ≤ 5 MB./)).toBeTruthy()
  })

  it('clicking bypass permissions button toggles status and calls window api bridge', () => {
    renderInputBar()
    const btn = screen.getByText('Require Permissions')
    
    act(() => {
      fireEvent.click(btn)
    })
    expect(mockSetBypassPermissions).toHaveBeenCalledWith(true)
    expect(screen.getByText('Bypass Permissions')).toBeTruthy()
  })

  it('clicking Brain/Zap button toggles thinking mode', () => {
    renderInputBar()
    const btn = screen.getByText('Thinking')
    
    act(() => {
      fireEvent.click(btn)
    })
    expect(screen.getByText('Fast')).toBeTruthy()

    act(() => {
      fireEvent.click(screen.getByText('Fast'))
    })
    expect(screen.getByText('Thinking')).toBeTruthy()
  })

  it('switches send button to abort/stop mode when streaming and calls onAbort', () => {
    const onAbort = vi.fn()
    const { rerender } = renderInputBar({ onAbort })

    // Simulate streaming in-progress
    act(() => {
      isStreamingSignal.value = true
    })

    // Manually trigger re-render to update component with new signal state
    act(() => {
      rerender(
        <ModelStoreProvider>
          <InputBar onSend={vi.fn()} onAbort={onAbort} />
        </ModelStoreProvider>
      )
    })

    // Button should now trigger abort
    const sendBtn = getSendButton()
    act(() => {
      fireEvent.click(sendBtn)
    })

    expect(onAbort).toHaveBeenCalled()
  })

  it('supports drag and drop file upload', () => {
    renderInputBar()
    const dropzone = document.querySelector('div[class*="flex-shrink-0"]') as HTMLElement
    const file = new File(['hello'], 'dropped.pdf', { type: 'application/pdf' })
    
    // Simulate dragenter/dragover
    act(() => {
      fireEvent.dragOver(dropzone, {
        dataTransfer: { files: [file] }
      })
    })
    
    // Simulate drop
    act(() => {
      fireEvent.drop(dropzone, {
        dataTransfer: { files: [file] }
      })
    })

    expect(screen.getByText('dropped.pdf')).toBeTruthy()
  })

  it('clears size warning when clicking close button', () => {
    renderInputBar()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const largeImage = new File([''], 'large.png', { type: 'image/png' })
    Object.defineProperty(largeImage, 'size', { value: 6 * 1024 * 1024 })

    act(() => {
      fireEvent.change(input, { target: { files: [largeImage] } })
    })

    // Verify error exists
    expect(screen.getByText(/"large.png" is 6.0 MB — images must be ≤ 5 MB./)).toBeTruthy()

    // Find the close button inside the error banner
    const errorContainer = screen.getByText(/"large.png" is 6.0 MB — images must be ≤ 5 MB./).parentElement
    const closeBtn = errorContainer?.querySelector('button')
    expect(closeBtn).toBeTruthy()
    
    act(() => {
      fireEvent.click(closeBtn!)
    })

    // Verify error is gone
    expect(screen.queryByText(/"large.png" is 6.0 MB — images must be ≤ 5 MB./)).toBeNull()
  })

  it('allows removing an attached file by clicking X on its badge', () => {
    renderInputBar()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['hello'], 'remove-me.pdf', { type: 'application/pdf' })

    act(() => {
      fireEvent.change(input, { target: { files: [file] } })
    })

    expect(screen.getByText('remove-me.pdf')).toBeTruthy()

    // Click the X button on the badge
    const badge = screen.getByText('remove-me.pdf').parentElement
    const removeBtn = badge?.querySelector('button')
    expect(removeBtn).toBeTruthy()

    act(() => {
      fireEvent.click(removeBtn!)
    })

    expect(screen.queryByText('remove-me.pdf')).toBeNull()
  })

  it('handles drag leave correctly', () => {
    renderInputBar()
    const dropzone = document.querySelector('div[class*="flex-shrink-0"]') as HTMLElement
    
    // Drag over first
    act(() => {
      fireEvent.dragOver(dropzone)
    })
    
    // Drag leave outside
    act(() => {
      fireEvent.dragLeave(dropzone, {
        relatedTarget: document.body
      })
    })
    
    // It should set dragging state to false
    expect(dropzone.firstElementChild?.className).not.toContain('shadow-red-glow')
  })

  it('clicking paperclip button triggers file input click', () => {
    renderInputBar()
    const paperclipBtn = screen.getByTitle('Attach file or image')
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {})
    
    act(() => {
      fireEvent.click(paperclipBtn)
    })
    
    expect(clickSpy).toHaveBeenCalled()
    clickSpy.mockRestore()
  })

  it('resizes the textarea based on scrollHeight and handles overflow on content change', async () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight')
    let mockScrollHeight = 24
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      get: () => mockScrollHeight,
      configurable: true,
    })

    const originalRaf = window.requestAnimationFrame
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    }

    renderInputBar()
    const textarea = screen.getByPlaceholderText('Message… (Shift+Enter for newline)') as HTMLTextAreaElement

    // Initially default height (24px)
    expect(textarea.style.height).toBe('24px')

    // Change height
    mockScrollHeight = 50
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Line 1\nLine 2' } })
    })

    expect(textarea.style.height).toBe('50px')

    // Grow beyond max height (200px)
    mockScrollHeight = 250
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8' } })
    })

    expect(textarea.style.height).toBe('200px')
    expect(textarea.style.overflowY).toBe('auto')

    window.requestAnimationFrame = originalRaf
    if (originalScrollHeight) {
      Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', originalScrollHeight)
    } else {
      delete (HTMLTextAreaElement.prototype as any).scrollHeight
    }
  })

  it('implements a fast path that skips resizing when already at max height and text is growing', () => {
    const originalRaf = window.requestAnimationFrame
    const rafSpy = vi.fn().mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    window.requestAnimationFrame = rafSpy

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight')
    let mockScrollHeight = 24
    let scrollHeightReadCount = 0
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      get: () => {
        scrollHeightReadCount++
        return mockScrollHeight
      },
      configurable: true,
    })

    renderInputBar()
    const textarea = screen.getByPlaceholderText('Message… (Shift+Enter for newline)') as HTMLTextAreaElement

    // Clear initial render calls
    rafSpy.mockClear()
    scrollHeightReadCount = 0

    // Set mock to max height value before typing
    mockScrollHeight = 250

    // 1. Initial typing that pushes height to max
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8' } })
    })

    expect(textarea.style.height).toBe('200px')
    expect(rafSpy).toHaveBeenCalledTimes(1)
    expect(scrollHeightReadCount).toBeGreaterThan(0)

    rafSpy.mockClear()
    const readsBeforeGrowing = scrollHeightReadCount

    // 2. Type more (growing, already at max height)
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8 extra words' } })
    })

    // The fast path should prevent calling requestAnimationFrame and reading scrollHeight
    expect(rafSpy).not.toHaveBeenCalled()
    expect(scrollHeightReadCount).toBe(readsBeforeGrowing)

    // 3. Shrink text (must trigger resize/measure again)
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Fewer lines' } })
    })
    expect(rafSpy).toHaveBeenCalledTimes(1)

    window.requestAnimationFrame = originalRaf
    if (originalScrollHeight) {
      Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', originalScrollHeight)
    } else {
      delete (HTMLTextAreaElement.prototype as any).scrollHeight
    }
  })
})

