import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BypassPermissionsButton } from '../../renderer/src/components/layout/InputBar'

describe('BypassPermissionsButton', () => {
  it('renders in off state by default', () => {
    render(<BypassPermissionsButton active={false} onToggle={vi.fn()} />)
    expect(screen.getByText('Require Permissions')).toBeTruthy()
  })
  it('shows Bypassed label when active=true', () => {
    render(<BypassPermissionsButton active={true} onToggle={vi.fn()} />)
    expect(screen.getByText('Bypass Permissions')).toBeTruthy()
  })
  it('calls onToggle with true when clicked in off state', () => {
    const onToggle = vi.fn()
    render(<BypassPermissionsButton active={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledWith(true)
  })
  it('calls onToggle with false when clicked in active state', () => {
    const onToggle = vi.fn()
    render(<BypassPermissionsButton active={true} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledWith(false)
  })
})
