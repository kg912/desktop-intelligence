import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { McpDeniedError, McpServerManager, SANDBOX_REVIEW_REQUIRED } from '../McpServerManager'
import type { McpServerSettings, McpToolPermissionRequest } from '../../../shared/types'

const { fsMock, sdkMocks, mockStdioTransport, mockWrapStdioCommand, mockMemoryWatch, mockStopMemoryWatch, mockRelease } = vi.hoisted(() => {
  const fsMock = {
    existsSync:    vi.fn<(path: string) => boolean>().mockReturnValue(false),
    readFileSync:  vi.fn<(path: string, options?: any) => string>().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    mkdirSync:     vi.fn(),
  }
  const sdkMocks = {
    connect:   vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool:  vi.fn().mockResolvedValue({ isError: false, content: [{ type: 'text', text: 'ok' }] }),
    close:     vi.fn().mockResolvedValue(undefined),
  }
  // Plain object (no .pid) — matches how the real mocked-out transport
  // behaves; the `if (pid)` guard in McpServerManager skips attaching
  // ResourceGovernor when pid is falsy, so these tests don't need a fake pid.
  const mockStdioTransport = vi.fn(function MockTransport(
    _params: { command: string; args: string[]; env: Record<string, string> }
  ) { return {} })
  const mockRelease = vi.fn()
  const mockWrapStdioCommand = vi.fn(async (_spec: unknown) => ({
    command: '/sandboxed/bin',
    args:    ['--sandboxed-arg'],
    env:     { SANDBOX_ENV: '1' },
    release: mockRelease,
  }))
  const mockStopMemoryWatch = vi.fn()
  const mockMemoryWatch = vi.fn(() => mockStopMemoryWatch)
  return { fsMock, sdkMocks, mockStdioTransport, mockWrapStdioCommand, mockMemoryWatch, mockStopMemoryWatch, mockRelease }
})

vi.mock('electron', () => ({
  app: { getPath: (_: string) => '/mock/userData' },
}))
const { mockRandomUUID } = vi.hoisted(() => ({ mockRandomUUID: vi.fn(() => 'mock-uuid-1234') }))
vi.mock('crypto', () => ({
  randomUUID: mockRandomUUID,
}))
vi.mock('fs', () => fsMock)
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function MockClient() {
    return {
      connect:   sdkMocks.connect,
      listTools: sdkMocks.listTools,
      callTool:  sdkMocks.callTool,
      close:     sdkMocks.close,
    }
  }),
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mockStdioTransport,
}))
vi.mock('../sandbox/sandboxServiceInstance', () => ({
  sandboxService: { wrapStdioCommand: mockWrapStdioCommand },
}))
vi.mock('../sandbox/ResourceGovernor', () => ({
  memoryWatch: mockMemoryWatch,
}))

const newMgr = () => new McpServerManager()
/** A reviewed deny-all sandbox manifest — lets non-sandbox tests start stdio servers. */
const REVIEWED = { allowedDomains: [], allowWrite: [] }
function setConfig(data: McpServerSettings) {
  fsMock.existsSync.mockReturnValue(true)
  fsMock.readFileSync.mockReturnValue(JSON.stringify(data))
}

beforeEach(() => {
  vi.clearAllMocks()
  fsMock.existsSync.mockReturnValue(false)
  fsMock.readFileSync.mockReturnValue('{}')
  sdkMocks.connect.mockResolvedValue(undefined)
  sdkMocks.listTools.mockResolvedValue({ tools: [] })
  sdkMocks.callTool.mockResolvedValue({ isError: false, content: [{ type: 'text', text: 'ok' }] })
  sdkMocks.close.mockResolvedValue(undefined)
  mockWrapStdioCommand.mockResolvedValue({
    command: '/sandboxed/bin',
    args:    ['--sandboxed-arg'],
    env:     { SANDBOX_ENV: '1' },
    release: mockRelease,
  })
  mockMemoryWatch.mockReturnValue(mockStopMemoryWatch)
})

describe('setToolEnabled()', () => {
  it('disabling a tool persists it to disabledTools in config', async () => {
    setConfig({ 'my-server': { command: 'node', enabled: true, sandboxProfile: REVIEWED } })
    const mgr = newMgr()
    await mgr.setToolEnabled('my-server', 'toolA', false)

    expect(fsMock.writeFileSync).toHaveBeenCalled()
    const written = fsMock.writeFileSync.mock.calls[0][1] as string
    expect(JSON.parse(written)).toEqual({
      'my-server': { command: 'node', enabled: true, sandboxProfile: REVIEWED, disabledTools: ['toolA'] }
    })
  })

  it('re-enabling a tool removes it from disabledTools', async () => {
    setConfig({ 'my-server': { command: 'node', enabled: true, sandboxProfile: REVIEWED, disabledTools: ['toolA'] } })
    const mgr = newMgr()
    await mgr.setToolEnabled('my-server', 'toolA', true)

    const written = fsMock.writeFileSync.mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed['my-server'].disabledTools).toEqual([])
  })

  it('getToolSchemas() excludes disabled tools', async () => {
    setConfig({ 'my-server': { command: 'node', enabled: true, sandboxProfile: REVIEWED, disabledTools: ['toolA'] } })
    sdkMocks.listTools.mockResolvedValue({
      tools: [
        { name: 'toolA', description: 'A' },
        { name: 'toolB', description: 'B' },
      ]
    })
    const mgr = newMgr()
    await mgr.startAll()

    const schemas = mgr.getToolSchemas()
    expect(schemas).toHaveLength(1)
    expect(schemas[0].function.name).toBe('my-server__toolB')
  })

  it('getToolSchemas() returns all tools when disabledTools is empty', async () => {
    setConfig({ 'my-server': { command: 'node', enabled: true, sandboxProfile: REVIEWED, disabledTools: [] } })
    sdkMocks.listTools.mockResolvedValue({
      tools: [
        { name: 'toolA', description: 'A' },
        { name: 'toolB', description: 'B' },
      ]
    })
    const mgr = newMgr()
    await mgr.startAll()

    expect(mgr.getToolSchemas()).toHaveLength(2)
  })

  it('getServerStatus() includes disabledTools', async () => {
    setConfig({ 'my-server': { command: 'node', enabled: true, sandboxProfile: REVIEWED, disabledTools: ['toolA'] } })
    const mgr = newMgr()
    await mgr.startAll()

    const status = mgr.getServerStatus()
    expect(status[0].disabledTools).toEqual(['toolA'])
  })

  it('disabling a non-existent server throws', async () => {
    setConfig({})
    const mgr = newMgr()
    await expect(mgr.setToolEnabled('ghost', 'tool', false)).rejects.toThrow('not found in config')
  })
})

describe('McpServerManager Security URL Checks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects HTTP (plain text) remote servers', async () => {
    setConfig({
      'remote-http': {
        url: 'http://my-remote-endpoint.com/mcp',
        enabled: true,
      } as any
    })
    const mgr = newMgr()
    await mgr.startAll()

    const status = mgr.getServerStatus()
    expect(status[0].status).toBe('error')
    expect(status[0].error).toContain('HTTP MCP servers must use HTTPS')
  })

  it('allows HTTP local loopback servers (localhost/127.0.0.1)', async () => {
    setConfig({
      'local-http': {
        url: 'http://localhost:3000/mcp',
        enabled: true,
      } as any
    })
    const mgr = newMgr()
    await mgr.startAll()

    // It will try to connect and fail (or resolve mock connect) but passes URL checks!
    const status = mgr.getServerStatus()
    expect(status[0].status).toBe('running')
  })

  it('rejects remote HTTP URLs with credentials embedded inside', async () => {
    setConfig({
      'cred-http': {
        url: 'https://user:password@remote-endpoint.com/mcp',
        enabled: true,
      } as any
    })
    const mgr = newMgr()
    await mgr.startAll()

    const status = mgr.getServerStatus()
    expect(status[0].status).toBe('error')
    expect(status[0].error).toContain('Credentials must not be embedded')
  })
})

describe('Multi-agent sandbox attribution', () => {
  it('adds the active worker identity to an MCP sandbox violation', () => {
    const mgr = newMgr()
    ;(mgr as any).activeMultiAgentWorkers.set('filesystem', new Map([['1.2', 1]]))
    expect(mgr.attributeMultiAgentViolation({
      source: 'mcp:filesystem', kind: 'read', target: '/Users/test/.ssh/id_ed25519', timestamp: 1,
    })).toMatchObject({ source: 'multi-agent:1.2:mcp:filesystem', kind: 'read' })
  })

  it('leaves unrelated sandbox violations unchanged', () => {
    const violation = { source: 'python-worker', kind: 'read' as const, target: '/tmp/a', timestamp: 1 }
    expect(newMgr().attributeMultiAgentViolation(violation)).toEqual(violation)
  })
})

describe('McpServerManager Lifecycle and meta-MCP', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sdkMocks.connect.mockResolvedValue(undefined)
    sdkMocks.listTools.mockResolvedValue({ tools: [] })
    sdkMocks.callTool.mockResolvedValue({ isError: false, content: [{ type: 'text', text: 'ok' }] })
    sdkMocks.close.mockResolvedValue(undefined)
  })

  it('handles client connection failures and marks status as error', async () => {
    sdkMocks.connect.mockRejectedValue(new Error('Connection refused'))
    setConfig({
      'fail-server': {
        command: 'node',
        sandboxProfile: REVIEWED,
        enabled: true,
      }
    })
    const mgr = newMgr()
    await mgr.startAll()

    const status = mgr.getServerStatus()
    expect(status[0].status).toBe('error')
    expect(status[0].error).toBe('Connection refused')
  })

  it('detects and eagerly expands meta-MCP tool schemas', async () => {
    // Mock listTools to return meta-MCP proxy tool list
    sdkMocks.listTools.mockResolvedValue({
      tools: [
        { name: 'TOOL_LIST', description: 'List meta tools' },
        { name: 'TOOL_CALL', description: 'Invoke meta tool', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, arguments: { type: 'object' } } } },
      ]
    })

    // Mock TOOL_LIST call to return logical tool definitions
    sdkMocks.callTool.mockResolvedValue({
      isError: false,
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            {
              name: 'my_logical_tool',
              description: 'Exposes logical functionality',
              inputSchema: { type: 'object', properties: { param1: { type: 'string' } } },
            }
          ])
        }
      ]
    })

    setConfig({
      'meta-server': {
        command: 'node',
        sandboxProfile: REVIEWED,
        enabled: true,
      }
    })
    const mgr = newMgr()
    await mgr.startAll()

    const status = mgr.getServerStatus()
    expect(status[0].status).toBe('running')
    expect(status[0].tools).toContain('my_logical_tool')

    const schemas = mgr.getToolSchemas()
    expect(schemas).toHaveLength(1)
    expect(schemas[0].function.name).toBe('meta-server__my_logical_tool')
  })

  it('falls back to TOOL_GET when a meta-MCP logical tool has no inputSchema', async () => {
    sdkMocks.listTools.mockResolvedValue({
      tools: [
        { name: 'TOOL_LIST', description: 'List meta tools' },
        { name: 'TOOL_CALL', description: 'Invoke meta tool', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, arguments: { type: 'object' } } } },
      ]
    })

    sdkMocks.callTool.mockImplementation(async ({ name, arguments: args }: { name: string; arguments?: any }) => {
      if (name === 'TOOL_LIST') {
        return {
          isError: false,
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                {
                  name: 'logical_no_schema',
                  description: 'Logical tool with no schema initially',
                }
              ])
            }
          ]
        }
      }
      if (name === 'TOOL_GET' && args?.tool_name === 'logical_no_schema') {
        return {
          isError: false,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                type: 'object',
                properties: { fallbackParam: { type: 'string' } },
                required: ['fallbackParam']
              })
            }
          ]
        }
      }
      return { isError: false, content: [] }
    })

    setConfig({
      'meta-server': {
        command: 'node',
        sandboxProfile: REVIEWED,
        enabled: true,
      }
    })
    const mgr = newMgr()
    await mgr.startAll()

    const schemas = mgr.getToolSchemas()
    expect(schemas).toHaveLength(1)
    expect(schemas[0].function.name).toBe('meta-server__logical_no_schema')
    expect(schemas[0].function.parameters.properties.fallbackParam).toBeDefined()
  })

  it('handles TOOL_GET failures gracefully during meta-MCP expansion', async () => {
    sdkMocks.listTools.mockResolvedValue({
      tools: [
        { name: 'TOOL_LIST', description: 'List meta tools' },
        { name: 'TOOL_CALL', description: 'Invoke meta tool', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, arguments: { type: 'object' } } } },
      ]
    })

    sdkMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'TOOL_LIST') {
        return {
          isError: false,
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                {
                  name: 'logical_fail_schema',
                  description: 'Logical tool with fail schema',
                }
              ])
            }
          ]
        }
      }
      if (name === 'TOOL_GET') {
        throw new Error('Simulated TOOL_GET failure')
      }
      return { isError: false, content: [] }
    })

    setConfig({
      'meta-server': {
        command: 'node',
        sandboxProfile: REVIEWED,
        enabled: true,
      }
    })
    const mgr = newMgr()
    await mgr.startAll()

    const schemas = mgr.getToolSchemas()
    expect(schemas).toHaveLength(1)
    expect(schemas[0].function.name).toBe('meta-server__logical_fail_schema')
    expect(schemas[0].function.parameters.properties).toEqual({})
  })

  it('resolves inputSchema when provided as valid and invalid JSON strings', async () => {
    sdkMocks.listTools.mockResolvedValue({
      tools: [
        { name: 'TOOL_LIST', description: 'List meta tools' },
        { name: 'TOOL_CALL', description: 'Invoke meta tool', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, arguments: { type: 'object' } } } },
      ]
    })

    sdkMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'TOOL_LIST') {
        return {
          isError: false,
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                {
                  name: 'logical_valid_json',
                  description: 'Logical tool with valid JSON string schema',
                  inputSchema: JSON.stringify({
                    type: 'object',
                    properties: { p1: { type: 'string' } }
                  })
                },
                {
                  name: 'logical_invalid_json',
                  description: 'Logical tool with invalid JSON string schema',
                  inputSchema: '{ invalid-json-string'
                }
              ])
            }
          ]
        }
      }
      return { isError: false, content: [] }
    })

    setConfig({
      'meta-server': {
        command: 'node',
        sandboxProfile: REVIEWED,
        enabled: true,
      }
    })
    const mgr = newMgr()
    await mgr.startAll()

    const schemas = mgr.getToolSchemas()
    expect(schemas).toHaveLength(2)
    
    const validSchema = schemas.find(s => s.function.name === 'meta-server__logical_valid_json')
    expect(validSchema).toBeDefined()
    expect(validSchema!.function.parameters.properties.p1).toBeDefined()

    const invalidSchema = schemas.find(s => s.function.name === 'meta-server__logical_invalid_json')
    expect(invalidSchema).toBeDefined()
    expect(invalidSchema!.function.parameters.properties).toEqual({})
  })

  it('handles writeConfig failures gracefully inside setServerApprovalMode', async () => {
    setConfig({ 'my-server': { command: 'node', enabled: true, sandboxProfile: REVIEWED } })
    const mgr = newMgr();
    
    // Seed the running server in memory
    (mgr as any).servers.set('my-server', {
      name: 'my-server',
      config: { command: 'node', enabled: true, sandboxProfile: REVIEWED, requiresApproval: true },
      client: null,
      status: 'running',
      tools: [],
      schemas: [],
      error: undefined,
      requiresApproval: true,
    })
    
    // Make writeConfig writeFileSync throw an error
    fsMock.writeFileSync.mockImplementationOnce(() => {
      throw new Error('Disk full')
    })
    
    // Spy on console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    
    try {
      mgr.setServerApprovalMode('my-server', false)
      
      // Wait a tiny bit since _persistServerApprovalMode uses promises (.then/.catch)
      await new Promise(resolve => setTimeout(resolve, 10))
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[McpServerManager] Failed to persist approval mode:'),
        expect.any(Error)
      )
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('falls back to raw tools if TOOL_LIST call throws an error', async () => {
    sdkMocks.listTools.mockResolvedValue({
      tools: [
        { name: 'TOOL_LIST', description: 'List meta tools' },
        { name: 'TOOL_CALL', description: 'Invoke meta tool' },
      ]
    })

    sdkMocks.callTool.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'TOOL_LIST') {
        throw new Error('TOOL_LIST failed completely')
      }
      return { isError: false, content: [] }
    })

    setConfig({
      'meta-server': {
        command: 'node',
        sandboxProfile: REVIEWED,
        enabled: true,
      }
    })
    const mgr = newMgr()
    await mgr.startAll()

    // It should fall back to exposing the raw tools (TOOL_LIST and TOOL_CALL)
    const schemas = mgr.getToolSchemas()
    expect(schemas).toHaveLength(2)
    expect(schemas.map(s => s.function.name)).toContain('meta-server__TOOL_LIST')
    expect(schemas.map(s => s.function.name)).toContain('meta-server__TOOL_CALL')
  })

  it('standard _awaitPermissionDialog registers request, emits event, and handles timeout', async () => {
    const mgr = newMgr()
    
    // Spy on resolve/timer mechanics
    vi.useFakeTimers()
    
    const permissionPromise = (mgr as any)._awaitPermissionDialog(
      'my-server',
      'my-tool',
      { arg1: 'val1' },
      'my-chat-id'
    )
    
    // Verify it added to pendingPermissions
    const pendingCount = (mgr as any).pendingPermissions.size
    expect(pendingCount).toBe(1)
    
    // Fast-forward timer to trigger 60s timeout
    vi.advanceTimersByTime(60000)
    
    const result = await permissionPromise
    expect(result).toEqual({ approved: false, userNote: '' })
    expect((mgr as any).pendingPermissions.size).toBe(0)
    
    vi.useRealTimers()
  })

  it('resolvePermission resolves standard pending permission request and clears timer', async () => {
    const mgr = newMgr();
    
    const permissionPromise = (mgr as any)._awaitPermissionDialog(
      'my-server',
      'my-tool',
      { arg1: 'val1' },
      'my-chat-id'
    )
    
    const requestId = [...(mgr as any).pendingPermissions.keys()][0]
    expect(requestId).toBeDefined()
    
    // Resolve permission manually
    mgr.resolvePermission({
      requestId,
      approved: true,
      userNote: 'Looks safe',
      alwaysAllow: 'session'
    })
    
    const result = await permissionPromise
    expect(result).toEqual({ approved: true, userNote: 'Looks safe' })
    expect((mgr as any).pendingPermissions.size).toBe(0)
    expect((mgr as any).sessionAllowList.has('my-chat-id__my-server__my-tool')).toBe(true)
  })

  it('stopAll closes all active server client connections', async () => {
    setConfig({
      'active-server': {
        command: 'node',
        sandboxProfile: REVIEWED,
        enabled: true,
      }
    })
    const mgr = newMgr()
    await mgr.startAll()
    await mgr.stopAll()

    expect(sdkMocks.close).toHaveBeenCalled()
    const status = mgr.getServerStatus()
    expect(status[0].status).toBe('stopped')
  })
})

describe('McpServerManager sandbox retrofit (Phase 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMock.existsSync.mockReturnValue(false)
    fsMock.readFileSync.mockReturnValue('{}')
    sdkMocks.connect.mockResolvedValue(undefined)
    sdkMocks.listTools.mockResolvedValue({ tools: [] })
    sdkMocks.callTool.mockResolvedValue({ isError: false, content: [{ type: 'text', text: 'ok' }] })
    sdkMocks.close.mockResolvedValue(undefined)
    mockWrapStdioCommand.mockResolvedValue({
      command: '/sandboxed/bin',
      args:    ['--sandboxed-arg'],
      env:     { SANDBOX_ENV: '1' },
      release: mockRelease,
    })
    mockMemoryWatch.mockReturnValue(mockStopMemoryWatch)
  })

  it('refuses to start (fails closed) a stdio server whose sandbox manifest has not been reviewed', async () => {
    setConfig({
      'plain-server': { command: 'node', args: ['server.js'], enabled: true },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mgr = newMgr()
    await mgr.startAll()

    expect(mockWrapStdioCommand).not.toHaveBeenCalled()
    expect(mockStdioTransport).not.toHaveBeenCalled()
    const [status] = mgr.getServerStatus()
    expect(status.status).toBe('error')
    expect(status.error).toBe(SANDBOX_REVIEW_REQUIRED)
    expect(status.needsSandboxReview).toBe(true)
  })

  it('reports needsSandboxReview=false once a profile exists, and never for HTTP servers', async () => {
    setConfig({
      'reviewed': { command: 'node', enabled: true, sandboxProfile: { allowedDomains: [], allowWrite: [] } },
      'remote':   { url: 'https://mcp.example.com/mcp', enabled: false },
    })
    const mgr = newMgr()
    await mgr.startAll()
    const byName = Object.fromEntries(mgr.getServerStatus().map((s) => [s.name, s]))
    expect(byName['reviewed'].needsSandboxReview).toBe(false)
    expect(byName['remote'].needsSandboxReview).toBe(false)
  })

  it('releases the sandbox lease when a sandboxed server is stopped', async () => {
    setConfig({
      'sandboxed': { command: 'node', enabled: true, sandboxProfile: { allowedDomains: [], allowWrite: [] } },
    })
    const mgr = newMgr()
    await mgr.startAll()
    expect(mockRelease).not.toHaveBeenCalled()

    await mgr.stopAll()
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('releases the sandbox lease when a sandboxed server fails to connect', async () => {
    setConfig({
      'broken': { command: 'node', enabled: true, sandboxProfile: { allowedDomains: [], allowWrite: [] } },
    })
    sdkMocks.connect.mockRejectedValueOnce(new Error('spawn failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mgr = newMgr()
    await mgr.startAll()

    expect(mgr.getServerStatus()[0].status).toBe('error')
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })

  it('starts unsandboxed and logs a warning when bypassSandbox is explicitly true', async () => {
    setConfig({
      'bypass-server': {
        command: 'node',
        args: ['server.js'],
        enabled: true,
        sandboxProfile: { allowedDomains: ['example.com'], allowWrite: [], bypassSandbox: true },
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mgr = newMgr()
    await mgr.startAll()

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"bypass-server" running WITHOUT sandbox — bypassSandbox: true')
    )
    expect(mockWrapStdioCommand).not.toHaveBeenCalled()
    expect(mockStdioTransport).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'node', args: ['server.js'] })
    )

    warnSpy.mockRestore()
  })

  it('calls sandboxService.wrapStdioCommand() with the declared policy before constructing the transport, and merges env correctly', async () => {
    setConfig({
      'sandboxed-server': {
        command: 'node',
        args: ['server.js', '--flag'],
        env: { API_KEY: 'user-provided-key' },
        enabled: true,
        sandboxProfile: {
          allowedDomains: ['api.example.com'],
          allowWrite: ['/tmp/scratch'],
        },
      },
    })
    const mgr = newMgr()
    await mgr.startAll()

    expect(mockWrapStdioCommand).toHaveBeenCalledTimes(1)
    const spec = mockWrapStdioCommand.mock.calls[0][0] as {
      command: string
      executionProfile: string
      allowedDomains: string[]
      allowWrite: string[]
    }
    expect(spec.executionProfile).toBe('lightweight')
    expect(spec.allowedDomains).toEqual(['api.example.com'])
    expect(spec.allowWrite).toEqual(['/tmp/scratch'])
    // command + args must be joined into one shell-safe string via shell-quote.
    expect(spec.command).toContain('node')
    expect(spec.command).toContain('server.js')
    expect(spec.command).toContain('--flag')

    // wrapStdioCommand() must run before the transport is constructed.
    const wrapOrder = mockWrapStdioCommand.mock.invocationCallOrder[0]
    const transportOrder = mockStdioTransport.mock.invocationCallOrder[0]
    expect(wrapOrder).toBeLessThan(transportOrder)

    // Transport is constructed from the WRAPPED command/args, not the raw config.
    expect(mockStdioTransport).toHaveBeenCalledWith(
      expect.objectContaining({ command: '/sandboxed/bin', args: ['--sandboxed-arg'] })
    )
    // The wrapped env AND the user's configured env must both reach the process;
    // npm's cache is redirected into the writable scratch dir, which is the cwd.
    const transportArgs = mockStdioTransport.mock.calls[0][0] as unknown as { env: Record<string, string>; cwd: string }
    expect(transportArgs.env).toMatchObject({
      SANDBOX_ENV: '1',
      API_KEY: 'user-provided-key',
      npm_config_cache: '/mock/userData/sandboxes/mcp/sandboxed-server/.npm-cache',
    })
    expect(transportArgs.cwd).toBe('/mock/userData/sandboxes/mcp/sandboxed-server')

    const status = mgr.getServerStatus()
    expect(status[0].status).toBe('running')
  })
})

describe('McpServerManager multi-agent tool proxy (spec §07 HITL expansion)', () => {
  // Concurrent dialogs need distinct request ids (the file-level mock is constant).
  beforeEach(() => {
    let n = 0
    mockRandomUUID.mockImplementation(() => `req-${++n}`)
  })
  afterEach(() => {
    mockRandomUUID.mockImplementation(() => 'mock-uuid-1234')
  })
  const ctx = (over: Partial<Parameters<McpServerManager['callToolForMultiAgent']>[3]> = {}) => ({
    chatId: 'chat-1', runId: 'run-1', agentId: '1.2', role: 'Analyzer', model: 'w/model',
    requirePermissions: true, hitlTimeoutMs: 300_000, ...over,
  })

  async function running(extra: Partial<McpServerSettings[string]> = {}) {
    setConfig({ fs: { command: 'node', enabled: true, sandboxProfile: REVIEWED, ...extra } as McpServerSettings[string] })
    const mgr = newMgr()
    await mgr.startAll()
    return mgr
  }

  it('asks with the agent identity and the run timeout, and executes on approval', async () => {
    const mgr = await running()
    const requests: McpToolPermissionRequest[] = []
    mgr.on('permissionRequest', (r: McpToolPermissionRequest) => {
      requests.push(r)
      mgr.resolvePermission({ requestId: r.requestId, approved: true, alwaysAllow: false, userNote: '' })
    })
    const result = await mgr.callToolForMultiAgent('fs', 'read', { path: '/x' }, ctx())
    expect(result.text).toBe('ok')
    expect(requests[0]).toMatchObject({
      serverName: 'fs', toolName: 'read', chatId: 'chat-1', timeoutMs: 300_000,
      agent: { runId: 'run-1', agentId: '1.2', role: 'Analyzer', model: 'w/model' },
    })
  })

  it('"Allow all from this agent" trusts only that agent, only in that run', async () => {
    const mgr = await running()
    const asked: string[] = []
    mgr.on('permissionRequest', (r: McpToolPermissionRequest) => {
      asked.push(`${r.agent?.runId}/${r.agent?.agentId}`)
      mgr.resolvePermission({ requestId: r.requestId, approved: true, alwaysAllow: false, userNote: '', agentTrust: 'trust' })
    })
    await mgr.callToolForMultiAgent('fs', 'read', {}, ctx())
    await mgr.callToolForMultiAgent('fs', 'read', {}, ctx())                       // trusted: no prompt
    await mgr.callToolForMultiAgent('fs', 'read', {}, ctx({ agentId: '1.3' }))     // other agent: prompted
    await mgr.callToolForMultiAgent('fs', 'read', {}, ctx({ runId: 'run-2' }))     // other run: prompted
    expect(asked).toEqual(['run-1/1.2', 'run-1/1.3', 'run-2/1.2'])
  })

  it('"Block this agent" denies now and every later call from it without asking', async () => {
    const mgr = await running()
    const onRequest = vi.fn((r: McpToolPermissionRequest) =>
      mgr.resolvePermission({ requestId: r.requestId, approved: true, alwaysAllow: false, userNote: 'no', agentTrust: 'block' }))
    mgr.on('permissionRequest', onRequest)
    await expect(mgr.callToolForMultiAgent('fs', 'read', {}, ctx())).rejects.toBeInstanceOf(McpDeniedError)
    await expect(mgr.callToolForMultiAgent('fs', 'read', {}, ctx())).rejects.toThrow()
    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(sdkMocks.callTool).not.toHaveBeenCalled()
    mgr.clearRunTrust('run-1')
    await expect(mgr.callToolForMultiAgent('fs', 'read', {}, ctx())).rejects.toBeInstanceOf(McpDeniedError)
    expect(onRequest).toHaveBeenCalledTimes(2) // trust decisions are run-scoped and cleared at run end
  })

  it('without the multi-agent HITL default, follows the server setting (auto-approve servers run unprompted)', async () => {
    const mgr = await running({ requiresApproval: false })
    const onRequest = vi.fn()
    mgr.on('permissionRequest', onRequest)
    await mgr.callToolForMultiAgent('fs', 'read', {}, ctx({ requirePermissions: false }))
    expect(onRequest).not.toHaveBeenCalled()
    // …but the multi-agent default prompts even for such a server.
    mgr.on('permissionRequest', (r: McpToolPermissionRequest) =>
      mgr.resolvePermission({ requestId: r.requestId, approved: true, alwaysAllow: false, userNote: '' }))
    await mgr.callToolForMultiAgent('fs', 'read', {}, ctx({ requirePermissions: true }))
    expect(onRequest).toHaveBeenCalledTimes(1)
  })

  it('built-in tools (builtin__brave_web_search) go through the same layers: prompt, trust, block, no MCP server needed', async () => {
    const mgr = newMgr() // no MCP server is configured or running
    const search = vi.fn(async () => 'results')
    const requests: McpToolPermissionRequest[] = []
    let answer: Partial<{ approved: boolean; agentTrust: 'trust' | 'block'; userNote: string }> = { approved: true }
    mgr.on('permissionRequest', (r: McpToolPermissionRequest) => {
      requests.push(r)
      mgr.resolvePermission({ requestId: r.requestId, approved: true, alwaysAllow: false, userNote: '', ...answer })
    })
    // requirePermissions on: prompted with the agent identity, then executed.
    expect(await mgr.callBuiltinForMultiAgent('brave_web_search', { query: 'q' }, ctx(), search)).toEqual({ text: 'results', images: [], userNote: '' })
    expect(requests[0]).toMatchObject({ serverName: 'builtin', toolName: 'brave_web_search', args: { query: 'q' }, agent: { agentId: '1.2', role: 'Analyzer' } })
    // requirePermissions off: built-ins have no per-server approval, so no prompt.
    await mgr.callBuiltinForMultiAgent('brave_web_search', { query: 'q' }, ctx({ requirePermissions: false }), search)
    expect(requests).toHaveLength(1)
    // Denied: the search never runs.
    answer = { approved: false, userNote: 'not now' }
    await expect(mgr.callBuiltinForMultiAgent('brave_web_search', {}, ctx(), search)).rejects.toMatchObject({ userNote: 'not now' })
    expect(search).toHaveBeenCalledTimes(2)
    // Trust this agent: later calls run unprompted; block another: denied unprompted next time.
    answer = { approved: true, agentTrust: 'trust' }
    await mgr.callBuiltinForMultiAgent('brave_web_search', {}, ctx(), search)
    await mgr.callBuiltinForMultiAgent('brave_web_search', {}, ctx(), search)
    expect(requests).toHaveLength(3)
    answer = { approved: false, agentTrust: 'block' }
    await expect(mgr.callBuiltinForMultiAgent('brave_web_search', {}, ctx({ agentId: '1.3' }), search)).rejects.toBeInstanceOf(McpDeniedError)
    await expect(mgr.callBuiltinForMultiAgent('brave_web_search', {}, ctx({ agentId: '1.3' }), search)).rejects.toMatchObject({ userNote: 'Analyzer is blocked for this run' })
    expect(requests).toHaveLength(4)
    expect(search).toHaveBeenCalledTimes(4)
  })

  it('auto-denies after the run timeout and tells the renderer to drop the dialog', async () => {
    vi.useFakeTimers()
    try {
      const mgr = await running()
      const expired = vi.fn()
      mgr.on('permissionExpired', expired)
      // Capture the rejection before advancing time so it is never unhandled.
      const pending = mgr.callToolForMultiAgent('fs', 'read', {}, ctx({ hitlTimeoutMs: 5_000 })).catch((err: unknown) => err)
      await vi.advanceTimersByTimeAsync(5_000)
      const denied = await pending
      expect(denied).toBeInstanceOf(McpDeniedError)
      expect((denied as McpDeniedError).userNote).toBe('Approval timed out')
      expect(expired).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelRunPermissions denies only the ended run\'s dialogs', async () => {
    const mgr = await running()
    const expired: string[] = []
    const requests: McpToolPermissionRequest[] = []
    mgr.on('permissionRequest', (r: McpToolPermissionRequest) => requests.push(r))
    mgr.on('permissionExpired', (id: string) => expired.push(id))
    const a = mgr.callToolForMultiAgent('fs', 'read', {}, ctx())
    const b = mgr.callToolForMultiAgent('fs', 'read', {}, ctx({ runId: 'run-2' }))
    await Promise.resolve()
    mgr.cancelRunPermissions('run-1')
    await expect(a).rejects.toBeInstanceOf(McpDeniedError)
    expect(expired).toEqual([requests[0].requestId])
    mgr.resolvePermission({ requestId: requests[1].requestId, approved: true, alwaysAllow: false, userNote: '' })
    await expect(b).resolves.toMatchObject({ text: 'ok' })
  })

  it('refuses unsandboxed (bypassed) local servers for agents', async () => {
    setConfig({ raw: { command: 'node', enabled: true, sandboxProfile: { ...REVIEWED, bypassSandbox: true } } })
    const mgr = newMgr()
    await mgr.startAll()
    await expect(mgr.callToolForMultiAgent('raw', 'x', {}, ctx())).rejects.toThrow(/no active SandboxService profile/)
  })

  it('attributes a sandbox violation to every agent with a call in flight on that server', async () => {
    const mgr = await running({ requiresApproval: false })
    const releases: Array<() => void> = []
    sdkMocks.callTool.mockImplementation(() => new Promise((r) => { releases.push(() => r({ isError: false, content: [] })) }))
    const one = mgr.callToolForMultiAgent('fs', 'read', {}, ctx({ agentId: '1.1', requirePermissions: false }))
    const two = mgr.callToolForMultiAgent('fs', 'read', {}, ctx({ agentId: '1.2', requirePermissions: false }))
    await new Promise((r) => setTimeout(r, 0))
    const v = { source: 'mcp:fs', kind: 'read' as const, target: '/etc', timestamp: 1 }
    expect(mgr.attributeMultiAgentViolation(v).source).toBe('multi-agent:1.1|1.2:mcp:fs')
    releases.forEach((release) => release())
    await Promise.allSettled([one, two])
    expect(mgr.attributeMultiAgentViolation(v).source).toBe('mcp:fs') // nothing in flight any more
    sdkMocks.callTool.mockResolvedValue({ isError: false, content: [{ type: 'text', text: 'ok' }] })
  })
})

// Reflection hardening Phase 0 (specs/multi-agent-reflection-hardening.md, diagnosis 5):
// tools a worker can never call are still offered.
describe('multi-agent callable servers', () => {
  const ctx = { chatId: 'c', runId: 'r', agentId: '1.1', role: 'Scout', model: 'm', requirePermissions: false, hitlTimeoutMs: 1_000 }
  const schema = (name: string) => ({ type: 'function' as const, function: { name, description: '', parameters: { type: 'object' as const, properties: {}, required: [] } } })
  /** A running server as McpServerManager holds it (a no-profile stdio server cannot start, so it is seeded). */
  function seed(mgr: McpServerManager, name: string, config: McpServerSettings[string]): void {
    ;(mgr as any).servers.set(name, {
      name, config, client: { callTool: sdkMocks.callTool }, status: 'running', tools: ['x'], schemas: [schema(`${name}__x`)], error: undefined, requiresApproval: false,
    })
  }

  // flips in Phase 1
  it('a bypassed and an unreviewed stdio server are offered in getToolSchemas(), and the multi-agent guard rejects both', async () => {
    const mgr = newMgr()
    seed(mgr, 'raw', { command: 'node', enabled: true, sandboxProfile: { ...REVIEWED, bypassSandbox: true } })
    seed(mgr, 'unreviewed', { command: 'node', enabled: true })
    expect(mgr.getToolSchemas().map((s) => s.function.name)).toEqual(['raw__x', 'unreviewed__x'])
    await expect(mgr.callToolForMultiAgent('raw', 'x', {}, ctx)).rejects.toThrow(/no active SandboxService profile/)
    await expect(mgr.callToolForMultiAgent('unreviewed', 'x', {}, ctx)).rejects.toThrow(/no active SandboxService profile/)
    expect(sdkMocks.callTool).not.toHaveBeenCalled()
  })
})
