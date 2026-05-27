import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServerManager } from '../McpServerManager'
import type { McpServerSettings } from '../../../shared/types'

const { fsMock, sdkMocks } = vi.hoisted(() => {
  const fsMock = {
    existsSync:    vi.fn<(path: string) => boolean>().mockReturnValue(false),
    readFileSync:  vi.fn<(path: string, options?: any) => string>().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
  }
  const sdkMocks = {
    connect:   vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool:  vi.fn().mockResolvedValue({ isError: false, content: [{ type: 'text', text: 'ok' }] }),
    close:     vi.fn().mockResolvedValue(undefined),
  }
  return { fsMock, sdkMocks }
})

vi.mock('electron', () => ({
  app: { getPath: (_: string) => '/mock/userData' },
}))
vi.mock('crypto', () => ({
  randomUUID: () => 'mock-uuid-1234',
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
  StdioClientTransport: vi.fn(function MockTransport() { return {} }),
}))

const newMgr = () => new McpServerManager()
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
})

describe('setToolEnabled()', () => {
  it('disabling a tool persists it to disabledTools in config', async () => {
    setConfig({ 'my-server': { command: 'node', enabled: true } })
    const mgr = newMgr()
    await mgr.setToolEnabled('my-server', 'toolA', false)

    expect(fsMock.writeFileSync).toHaveBeenCalled()
    const written = fsMock.writeFileSync.mock.calls[0][1] as string
    expect(JSON.parse(written)).toEqual({
      'my-server': { command: 'node', enabled: true, disabledTools: ['toolA'] }
    })
  })

  it('re-enabling a tool removes it from disabledTools', async () => {
    setConfig({ 'my-server': { command: 'node', enabled: true, disabledTools: ['toolA'] } })
    const mgr = newMgr()
    await mgr.setToolEnabled('my-server', 'toolA', true)

    const written = fsMock.writeFileSync.mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed['my-server'].disabledTools).toEqual([])
  })

  it('getToolSchemas() excludes disabled tools', async () => {
    setConfig({ 'my-server': { command: 'node', enabled: true, disabledTools: ['toolA'] } })
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
    setConfig({ 'my-server': { command: 'node', enabled: true, disabledTools: [] } })
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
    setConfig({ 'my-server': { command: 'node', enabled: true, disabledTools: ['toolA'] } })
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
    setConfig({ 'my-server': { command: 'node', enabled: true } })
    const mgr = newMgr();
    
    // Seed the running server in memory
    (mgr as any).servers.set('my-server', {
      name: 'my-server',
      config: { command: 'node', enabled: true, requiresApproval: true },
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
