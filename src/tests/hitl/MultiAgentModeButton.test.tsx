import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// Mock Preact signals React runtime to avoid concurrent work tracking errors in jsdom
vi.mock('@preact/signals-react/runtime', () => ({
  useSignals: () => {},
}))

import { MultiAgentModeButton } from '../../renderer/src/components/layout/InputBar'

describe('MultiAgentModeButton', () => {
  it('renders "Multi-Agent" label', () => {
    render(<MultiAgentModeButton active={false} onToggle={vi.fn()} />)
    expect(screen.getByText('Multi-Agent')).toBeTruthy()
  })

  it('is inactive (data-active=false) when active prop is false', () => {
    render(<MultiAgentModeButton active={false} onToggle={vi.fn()} />)
    expect(screen.getByRole('button').getAttribute('data-active')).toBe('false')
  })

  it('is active (data-active=true) when active prop is true', () => {
    render(<MultiAgentModeButton active={true} onToggle={vi.fn()} />)
    expect(screen.getByRole('button').getAttribute('data-active')).toBe('true')
  })

  it('clicking while inactive calls onToggle(true)', () => {
    const onToggle = vi.fn()
    render(<MultiAgentModeButton active={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('clicking while active calls onToggle(false)', () => {
    const onToggle = vi.fn()
    render(<MultiAgentModeButton active={true} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('has correct title when inactive', () => {
    render(<MultiAgentModeButton active={false} onToggle={vi.fn()} />)
    expect(screen.getByRole('button').getAttribute('title')).toBe('Multi-agent mode off — click to enable')
  })

  it('has correct title when active', () => {
    render(<MultiAgentModeButton active={true} onToggle={vi.fn()} />)
    expect(screen.getByRole('button').getAttribute('title')).toBe('Multi-agent mode on — click to disable')
  })

  it('onToggle is not called when button is not clicked', () => {
    const onToggle = vi.fn()
    render(<MultiAgentModeButton active={false} onToggle={onToggle} />)
    expect(onToggle).not.toHaveBeenCalled()
  })
})
