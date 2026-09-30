import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { McpToolsPanel } from '../../renderer/src/components/settings/McpToolsPanel'
import type { McpServerRuntimeInfo, McpServerSettings } from '../../shared/types'

// Mock Electron IPC bridge on the existing window object without overwriting it,
// matching the convention used in InputBar.test.tsx.
const mockGetServerStatus     = vi.fn()
const mockListCustomServers   = vi.fn()
const mockSaveCustomServers   = vi.fn().mockResolvedValue(undefined)
const mockRestartServer       = vi.fn().mockResolvedValue(undefined)
const mockRemoveServer        = vi.fn().mockResolvedValue(undefined)
const mockSetToolEnabled      = vi.fn().mockResolvedValue(undefined)
const mockSetServerApproval   = vi.fn().mockResolvedValue(undefined)
const mockOnServerStatusChanged = vi.fn(() => () => {})
const mockGetSandboxStatus    = vi.fn()

if (typeof window !== 'undefined') {
  ;(window as any).api = {
    mcpGetServerStatus:       (...args: any[]) => mockGetServerStatus(...args),
    mcpListCustomServers:     (...args: any[]) => mockListCustomServers(...args),
    mcpSaveCustomServers:     (...args: any[]) => mockSaveCustomServers(...args),
    mcpRestartServer:         (...args: any[]) => mockRestartServer(...args),
    mcpRemoveServer:          (...args: any[]) => mockRemoveServer(...args),
    mcpSetToolEnabled:        (...args: any[]) => mockSetToolEnabled(...args),
    setServerApprovalMode:    (...args: any[]) => mockSetServerApproval(...args),
    onMcpServerStatusChanged: (...args: any[]) => mockOnServerStatusChanged(...args),
    getSandboxStatus:         (...args: any[]) => mockGetSandboxStatus(...args),
  }
}

function stdioRuntimeInfo(overrides: Partial<McpServerRuntimeInfo> = {}): McpServerRuntimeInfo {
  return {
    name:             'my-stdio-server',
    status:           'stopped',
    tools:            [],
    disabledTools:    [],
    requiresApproval: true,
    ...overrides,
  }
}

function stdioConfig(overrides: Partial<McpServerSettings[string]> = {}): McpServerSettings {
  return {
    'my-stdio-server': {
      command: 'node',
      args:    ['server.js'],
      enabled: true,
      ...overrides,
    } as McpServerSettings[string],
  }
}

const REVIEWED = { allowedDomains: [] as string[], allowWrite: [] as string[] }

beforeEach(() => {
  vi.clearAllMocks()
  mockSaveCustomServers.mockResolvedValue(undefined)
  mockRestartServer.mockResolvedValue(undefined)
  mockGetSandboxStatus.mockResolvedValue({
    supported: true, ready: true, errors: [], warnings: [],
    baselineDenyRead: ['~/.ssh', '~/.aws'], activePolicies: [],
  })
})

describe('McpToolsPanel — sandbox profile UI', () => {
  it('shows "review required" for an unreviewed stdio server, auto-expanded with an enabled Approve & start', async () => {
    mockGetServerStatus.mockResolvedValue([stdioRuntimeInfo({ status: 'error', needsSandboxReview: true })])
    mockListCustomServers.mockResolvedValue(stdioConfig())

    render(<McpToolsPanel />)

    await waitFor(() => expect(screen.getByText('review required')).toBeTruthy())
    // Card opens itself so the review prompt can't be missed.
    await screen.findByText(/this server stays stopped until you approve/)
    const approve = screen.getByText('Approve & start') as HTMLButtonElement
    expect(approve.disabled).toBe(false)
  })

  it('approving an unchanged (deny-all) profile saves it and starts the server', async () => {
    mockGetServerStatus.mockResolvedValue([stdioRuntimeInfo({ status: 'error', needsSandboxReview: true })])
    mockListCustomServers.mockResolvedValue(stdioConfig())

    render(<McpToolsPanel />)
    fireEvent.click(await screen.findByText('Approve & start'))

    await waitFor(() => expect(mockSaveCustomServers).toHaveBeenCalledTimes(1))
    const saved = mockSaveCustomServers.mock.calls[0][0] as McpServerSettings
    expect(saved['my-stdio-server'].sandboxProfile).toEqual({ allowedDomains: [], allowWrite: [] })
    await waitFor(() => expect(mockRestartServer).toHaveBeenCalledWith('my-stdio-server'))
  })

  it('shows a distinct "bypassed" indicator when bypassSandbox is explicitly true', async () => {
    mockGetServerStatus.mockResolvedValue([stdioRuntimeInfo()])
    mockListCustomServers.mockResolvedValue(
      stdioConfig({ sandboxProfile: { allowedDomains: [], allowWrite: [], bypassSandbox: true } })
    )

    render(<McpToolsPanel />)

    await waitFor(() => expect(screen.getByText('bypassed')).toBeTruthy())
    expect(screen.queryByText('review required')).toBeNull()
  })

  it('shows a "sandboxed" indicator when a real sandboxProfile is declared and not bypassed', async () => {
    mockGetServerStatus.mockResolvedValue([stdioRuntimeInfo()])
    mockListCustomServers.mockResolvedValue(
      stdioConfig({ sandboxProfile: { allowedDomains: ['api.example.com'], allowWrite: [] } })
    )

    render(<McpToolsPanel />)

    await waitFor(() => expect(screen.getByText('sandboxed')).toBeTruthy())
  })

  it('does not render any sandbox indicator for an HTTP server', async () => {
    mockGetServerStatus.mockResolvedValue([
      { name: 'my-http-server', status: 'running', tools: [], disabledTools: [], requiresApproval: true },
    ])
    mockListCustomServers.mockResolvedValue({
      'my-http-server': { url: 'https://api.example.com/mcp', enabled: true },
    })

    render(<McpToolsPanel />)

    await waitFor(() => expect(screen.getByText('my-http-server')).toBeTruthy())
    expect(screen.queryByText('review required')).toBeNull()
    expect(screen.queryByText('sandboxed')).toBeNull()
    expect(screen.queryByText('bypassed')).toBeNull()
  })

  it('round-trips a saved sandboxProfile through mcpSaveCustomServers with parsed allowedDomains/allowWrite', async () => {
    mockGetServerStatus.mockResolvedValue([stdioRuntimeInfo({ status: 'stopped' })])
    mockListCustomServers.mockResolvedValue(stdioConfig({ sandboxProfile: REVIEWED }))

    render(<McpToolsPanel />)
    await waitFor(() => expect(screen.getByText('my-stdio-server')).toBeTruthy())

    // Expand the card to reveal the sandbox profile editor.
    fireEvent.click(screen.getByText('my-stdio-server'))
    await screen.findByText('Sandbox profile')

    // Two textareas in DOM order: allowed domains, then writable paths.
    const [domainsField, writeField] = screen.getAllByRole('textbox') as HTMLTextAreaElement[]
    fireEvent.change(domainsField, { target: { value: 'api.example.com\ncdn.example.com' } })
    fireEvent.change(writeField, { target: { value: '/tmp/scratch' } })

    // The freshly-typed values make the Save button re-fetch the current
    // config before writing, so mcpListCustomServers must resolve again here.
    mockListCustomServers.mockResolvedValue(stdioConfig({ sandboxProfile: REVIEWED }))

    fireEvent.click(screen.getByText('Save sandbox profile'))

    await waitFor(() => expect(mockSaveCustomServers).toHaveBeenCalledTimes(1))
    const saved = mockSaveCustomServers.mock.calls[0][0] as McpServerSettings
    expect(saved['my-stdio-server'].sandboxProfile).toEqual({
      allowedDomains: ['api.example.com', 'cdn.example.com'],
      allowWrite:     ['/tmp/scratch'],
    })
    // Server was stopped, not running — no restart prompt should fire.
    expect(mockRestartServer).not.toHaveBeenCalled()
  })

  it('includes bypassSandbox: true in the saved payload when the toggle is switched on', async () => {
    mockGetServerStatus.mockResolvedValue([stdioRuntimeInfo({ status: 'stopped' })])
    mockListCustomServers.mockResolvedValue(stdioConfig({ sandboxProfile: REVIEWED }))

    render(<McpToolsPanel />)
    await waitFor(() => expect(screen.getByText('my-stdio-server')).toBeTruthy())

    fireEvent.click(screen.getByText('my-stdio-server'))
    await screen.findByText('Bypass sandbox')

    // The bypass toggle is the only <button> inside that row.
    const bypassRow = screen.getByText('Bypass sandbox').closest('div')!.parentElement!
    const toggleBtn = bypassRow.querySelector('button')!
    fireEvent.click(toggleBtn)

    mockListCustomServers.mockResolvedValue(stdioConfig({ sandboxProfile: REVIEWED }))
    fireEvent.click(screen.getByText('Save sandbox profile'))

    await waitFor(() => expect(mockSaveCustomServers).toHaveBeenCalledTimes(1))
    const saved = mockSaveCustomServers.mock.calls[0][0] as McpServerSettings
    expect(saved['my-stdio-server'].sandboxProfile).toMatchObject({ bypassSandbox: true })
  })

  it('prompts to restart a running server after saving a sandboxProfile change, and restarts on confirm', async () => {
    mockGetServerStatus.mockResolvedValue([stdioRuntimeInfo({ status: 'running' })])
    mockListCustomServers.mockResolvedValue(stdioConfig({ sandboxProfile: REVIEWED }))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<McpToolsPanel />)
    await waitFor(() => expect(screen.getByText('my-stdio-server')).toBeTruthy())

    fireEvent.click(screen.getByText('my-stdio-server'))
    await screen.findByText('Sandbox profile')
    const [domainsField] = screen.getAllByRole('textbox') as HTMLTextAreaElement[]
    fireEvent.change(domainsField, { target: { value: 'api.example.com' } })

    mockListCustomServers.mockResolvedValue(stdioConfig({ sandboxProfile: REVIEWED }))
    fireEvent.click(screen.getByText('Save sandbox profile'))

    await waitFor(() => expect(mockSaveCustomServers).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(mockRestartServer).toHaveBeenCalledWith('my-stdio-server')

    confirmSpy.mockRestore()
  })
})

describe('SandboxStatusPanel (in McpToolsPanel)', () => {
  it('shows the sandbox as active with the baseline denylist behind a disclosure', async () => {
    mockGetServerStatus.mockResolvedValue([])
    mockListCustomServers.mockResolvedValue({})

    render(<McpToolsPanel />)

    await screen.findByText('Tool sandbox active')
    expect(screen.queryByText('~/.ssh')).toBeNull()
    fireEvent.click(screen.getByText(/Always-blocked credential paths \(2\)/))
    expect(screen.getByText('~/.ssh')).toBeTruthy()
  })

  it('surfaces a failed dependency check with its errors', async () => {
    mockGetServerStatus.mockResolvedValue([])
    mockListCustomServers.mockResolvedValue({})
    mockGetSandboxStatus.mockResolvedValue({
      supported: true, ready: false, errors: ['Sandbox backend failed to start: boom'], warnings: [],
      baselineDenyRead: [], activePolicies: [],
    })

    render(<McpToolsPanel />)

    await screen.findByText('Tool sandbox unavailable')
    expect(screen.getByText('Sandbox backend failed to start: boom')).toBeTruthy()
  })

  it('lists active network policies with their process counts', async () => {
    mockGetServerStatus.mockResolvedValue([])
    mockListCustomServers.mockResolvedValue({})
    mockGetSandboxStatus.mockResolvedValue({
      supported: true, ready: true, errors: [], warnings: [], baselineDenyRead: [],
      activePolicies: [{ allowedDomains: ['api.example.com'], leases: 2 }, { allowedDomains: [], leases: 1 }],
    })

    render(<McpToolsPanel />)

    await screen.findByText('Active network policies')
    expect(screen.getByText('api.example.com')).toBeTruthy()
    expect(screen.getByText('no network')).toBeTruthy()
  })
})
