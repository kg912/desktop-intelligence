import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DebugSettings } from '../../renderer/src/components/settings/DebugSettings'
import type { SandboxViolationLogEntry } from '../../shared/types'

// Mock Electron IPC bridge on the existing window object without overwriting
// it, matching the convention used in InputBar.test.tsx / McpToolsPanel.test.tsx.
const mockObsGetPrefs               = vi.fn().mockResolvedValue({ observabilityEnabled: true, includeImages: false })
const mockObsSetPrefs               = vi.fn().mockResolvedValue(undefined)
const mockObsListSessions           = vi.fn().mockResolvedValue([])
const mockObsTotalSize              = vi.fn().mockResolvedValue(0)
const mockObsListSandboxViolations  = vi.fn()
const mockObsClearSandboxViolations = vi.fn().mockResolvedValue(undefined)
const mockObsOpenSandboxViolationsFile = vi.fn().mockResolvedValue(undefined)

if (typeof window !== 'undefined') {
  ;(window as any).api = {
    obsGetPrefs:                  (...args: any[]) => mockObsGetPrefs(...args),
    obsSetPrefs:                  (...args: any[]) => mockObsSetPrefs(...args),
    obsListSessions:              (...args: any[]) => mockObsListSessions(...args),
    obsTotalSize:                 (...args: any[]) => mockObsTotalSize(...args),
    obsListSandboxViolations:     (...args: any[]) => mockObsListSandboxViolations(...args),
    obsClearSandboxViolations:    (...args: any[]) => mockObsClearSandboxViolations(...args),
    obsOpenSandboxViolationsFile: (...args: any[]) => mockObsOpenSandboxViolationsFile(...args),
  }
}

function entry(overrides: Partial<SandboxViolationLogEntry> = {}): SandboxViolationLogEntry {
  return {
    source: 'python-worker',
    kind: 'read',
    target: '/tmp/scratch.py',
    timestamp: Date.now(),
    isCredential: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockObsGetPrefs.mockResolvedValue({ observabilityEnabled: true, includeImages: false })
  mockObsListSessions.mockResolvedValue([])
  mockObsTotalSize.mockResolvedValue(0)
  mockObsListSandboxViolations.mockResolvedValue([])
})

describe('DebugSettings — Sandbox Violations section', () => {
  it('shows the empty state when there are no violations', async () => {
    render(<DebugSettings />)
    await waitFor(() => expect(screen.getByText('No violations recorded.')).toBeTruthy())
  })

  it('lists a routine (non-credential) violation without the credential badge', async () => {
    mockObsListSandboxViolations.mockResolvedValue([
      entry({ source: 'mcp:brave-search', kind: 'network', target: 'evil.example.com', isCredential: false }),
    ])

    render(<DebugSettings />)

    await waitFor(() => expect(screen.getByText('evil.example.com')).toBeTruthy())
    expect(screen.getByText('mcp:brave-search')).toBeTruthy()
    expect(screen.getByText('network')).toBeTruthy()
    expect(screen.queryByText('credential')).toBeNull()
  })

  it('lists a credential-path violation with the credential badge', async () => {
    mockObsListSandboxViolations.mockResolvedValue([
      entry({
        source: 'python-worker',
        kind: 'read',
        target: '/Users/karan/.ssh/id_ed25519',
        isCredential: true,
      }),
    ])

    render(<DebugSettings />)

    await waitFor(() => expect(screen.getByText('/Users/karan/.ssh/id_ed25519')).toBeTruthy())
    expect(screen.getByText('credential')).toBeTruthy()
  })

  it('lists both credential and routine violations together, correctly badged', async () => {
    mockObsListSandboxViolations.mockResolvedValue([
      entry({ target: '/Users/karan/.aws/credentials', kind: 'read', isCredential: true }),
      entry({ target: '/tmp/chart.png', kind: 'write', isCredential: false }),
    ])

    render(<DebugSettings />)

    await waitFor(() => expect(screen.getByText('2 entries')).toBeTruthy())
    expect(screen.getByText('/Users/karan/.aws/credentials')).toBeTruthy()
    expect(screen.getByText('/tmp/chart.png')).toBeTruthy()
    // Exactly one credential badge — the routine entry must not get one.
    expect(screen.getAllByText('credential')).toHaveLength(1)
  })

  it('opens the raw jsonl file via the Open button', async () => {
    mockObsListSandboxViolations.mockResolvedValue([entry()])
    render(<DebugSettings />)
    await waitFor(() => expect(screen.getByText('1 entry')).toBeTruthy())

    const openButtons = screen.getAllByText('Open')
    // Two "Open" buttons exist (session logs + sandbox violations) — click the second.
    fireEvent.click(openButtons[openButtons.length - 1])

    await waitFor(() => expect(mockObsOpenSandboxViolationsFile).toHaveBeenCalledTimes(1))
  })

  it('clears violations after confirming', async () => {
    mockObsListSandboxViolations.mockResolvedValue([entry()])
    render(<DebugSettings />)
    await waitFor(() => expect(screen.getByText('1 entry')).toBeTruthy())

    fireEvent.click(screen.getByText('Clear All Violations'))
    fireEvent.click(screen.getByText('Yes, clear all'))

    await waitFor(() => expect(mockObsClearSandboxViolations).toHaveBeenCalledTimes(1))
  })
})
