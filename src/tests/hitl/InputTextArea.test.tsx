import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { useRef, useEffect } from 'react'
import { useSignal } from '@preact/signals-react/runtime'
import { InputTextArea } from '../../renderer/src/components/layout/InputTextArea'

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
    }
  }
})

describe('InputTextArea', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders with the initial signal value', () => {
    const TestComponent = () => {
      const signal = useSignal('Initial value')
      const ref = useRef<HTMLTextAreaElement>(null)
      return (
        <InputTextArea
          textareaRef={ref}
          handleKeyDown={vi.fn()}
          textAreaSignal={signal}
        />
      )
    }

    render(<TestComponent />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('Initial value')
  })

  it('typing updates the signal value', () => {
    let capturedValue = ''
    const TestComponent = () => {
      const signal = useSignal('')
      capturedValue = signal.value
      const ref = useRef<HTMLTextAreaElement>(null)
      return (
        <InputTextArea
          textareaRef={ref}
          handleKeyDown={vi.fn()}
          textAreaSignal={signal}
        />
      )
    }

    render(<TestComponent />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    
    act(() => {
      fireEvent.change(textarea, { target: { value: 'New Typed Content' } })
    })

    expect(capturedValue).toBe('New Typed Content')
    expect(textarea.value).toBe('New Typed Content')
  })

  it('triggers handleKeyDown on key down event', () => {
    const handleKeyDown = vi.fn()
    const TestComponent = () => {
      const signal = useSignal('')
      const ref = useRef<HTMLTextAreaElement>(null)
      return (
        <InputTextArea
          textareaRef={ref}
          handleKeyDown={handleKeyDown}
          textAreaSignal={signal}
        />
      )
    }

    render(<TestComponent />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
    })

    expect(handleKeyDown).toHaveBeenCalled()
  })

  it('forwards the textareaRef correctly to the parent component', () => {
    let refCurrentValue: HTMLTextAreaElement | null = null
    const TestComponent = () => {
      const signal = useSignal('')
      const ref = useRef<HTMLTextAreaElement>(null)
      useEffect(() => {
        refCurrentValue = ref.current
      }, [])
      return (
        <InputTextArea
          textareaRef={ref}
          handleKeyDown={vi.fn()}
          textAreaSignal={signal}
        />
      )
    }

    render(<TestComponent />)
    expect(refCurrentValue).not.toBeNull()
    expect(refCurrentValue instanceof HTMLTextAreaElement).toBe(true)
  })

  it('does not read scrollHeight during render', () => {
    const scrollHeightSpy = vi.fn().mockReturnValue(100)
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      get: scrollHeightSpy,
      configurable: true,
    })

    const TestComponent = () => {
      const signal = useSignal('Some text')
      const ref = useRef<HTMLTextAreaElement>(null)
      return (
        <InputTextArea
          textareaRef={ref}
          handleKeyDown={vi.fn()}
          textAreaSignal={signal}
        />
      )
    }

    render(<TestComponent />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    
    // Trigger a change to update the signal and trigger a re-render where ref is populated
    act(() => {
      fireEvent.change(textarea, { target: { value: 'Some more text' } })
    })

    expect(scrollHeightSpy).not.toHaveBeenCalled()
    
    // Clean up definition
    delete (HTMLTextAreaElement.prototype as any).scrollHeight
  })
})

