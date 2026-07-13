import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SandboxViolationToast } from '../../renderer/src/components/chat/SandboxViolationToast'
import type { SandboxViolationTraceEvent } from '../../shared/types'

function makeViolation(overrides: Partial<SandboxViolationTraceEvent> = {}): SandboxViolationTraceEvent {
  return {
    source: 'python-worker',
    kind: 'read',
    target: '/Users/karan/.ssh/id_ed25519',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('SandboxViolationToast', () => {
  it('renders the headline and the denied target', () => {
    render(<SandboxViolationToast violation={makeViolation()} />)

    expect(screen.getByText('Sandbox blocked a credential access attempt')).toBeTruthy()
    expect(screen.getByText('/Users/karan/.ssh/id_ed25519')).toBeTruthy()
  })

  it('describes a python-worker source in plain language', () => {
    render(<SandboxViolationToast violation={makeViolation({ source: 'python-worker' })} />)
    expect(screen.getByText(/The Python worker was denied access to/)).toBeTruthy()
  })

  it('describes an mcp:<name> source by naming the server', () => {
    render(<SandboxViolationToast violation={makeViolation({ source: 'mcp:brave-search' })} />)
    expect(screen.getByText(/MCP server "brave-search" was denied access to/)).toBeTruthy()
  })

  it('falls back to a generic description for an unknown source', () => {
    render(<SandboxViolationToast violation={makeViolation({ source: 'unknown' })} />)
    expect(screen.getByText(/A sandboxed process was denied access to/)).toBeTruthy()
  })
})
