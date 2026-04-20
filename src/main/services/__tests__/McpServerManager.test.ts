/**
 * McpServerManager unit tests
 *
 * Tests cover: config I/O, status accessors, schema mapping, error states,
 * and callTool guards. @modelcontextprotocol/sdk and fs/electron are mocked.
 *
 * Each test creates a fresh McpServerManager instance so state does not leak.
 *
 * Note: vi.mock() factories are hoisted above variable declarations.
 * Use vi.hoisted() to declare shared mock objects referenced inside factories.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mock objects (accessible inside vi.mock factories) ────
const { fsMock, sdkMocks } = vi.hoisted(() => {
  const fsMock = {
    existsSync:    vi.fn<[string], boolean>().mockReturnValue(false),
    readFileSync:  vi.fn<[string, string], string>().mockReturnValue('{}'),
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

// ── Module mocks ──────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: (_: string) => '/mock/userData' },
}))

vi.mock('crypto', () => ({
  randomUUID: () => 'mock-uuid-1234',
}))

vi.mock('fs', () => fsMock)

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  // Must be a regular function (not arrow) to support `new Client()`
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
  // Regular function so `new StdioClientTransport()` works
  StdioClientTransport: vi.fn(function MockTransport() { return {} }),
}))

// ── Import AFTER mocks ────────────────────────────────────────────
import { McpServerManager } from '../McpServerManager'
import type { McpServerSettings } from '../../../shared/types'

// ── Helpers ───────────────────────────────────────────────────────
const newMgr = () => new McpServerManager()

function setConfig(data: McpServerSettings) {
  fsMock.existsSync.mockReturnValue(true)
  fsMock.readFileSync.mockReturnValue(JSON.stringify(data))
}

// ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  fsMock.existsSync.mockReturnValue(false)
  fsMock.readFileSync.mockReturnValue('{}')
  sdkMocks.connect.mockResolvedValue(undefined)
  sdkMocks.listTools.mockResolvedValue({ tools: [] })
  sdkMocks.callTool.mockResolvedValue({ isError: false, content: [{ type: 'text', text: 'ok' }] })
  sdkMocks.close.mockResolvedValue(undefined)
})

// ── readConfig ────────────────────────────────────────────────────

describe('readConfig()', () => {
  it('returns {} when mcp.json does not exist', async () => {
    fsMock.existsSync.mockReturnValue(false)
    expect(await newMgr().readConfig()).toEqual({})
  })

  it('parses a valid mcp.json correctly', async () => {
    const data: McpServerSettings = {
      'fs-server': { command: 'npx', args: ['@mcp/fs', '/tmp'], enabled: true },
    }
    setConfig(data)
    expect(await newMgr().readConfig()).toEqual(data)
  })

  it('returns {} when mcp.json contains invalid JSON', async () => {
    fsMock.existsSync.mockReturnValue(true)
    fsMock.readFileSync.mockReturnValue('{ not valid JSON }}}')
    expect(await newMgr().readConfig()).toEqual({})
  })
})

// ── writeConfig ───────────────────────────────────────────────────

describe('writeConfig()', () => {
  it('writes formatted JSON with 2-space indent', async () => {
    const settings: McpServerSettings = {
      'my-server': { command: 'node', args: ['index.js'], enabled: true },
    }
    await newMgr().writeConfig(settings)

    expect(fsMock.writeFileSync).toHaveBeenCalledOnce()
    const written = fsMock.writeFileSync.mock.calls[0][1] as string
    expect(JSON.parse(written)).toEqual(settings)
    expect(written).toContain('  "my-server"')   // 2-space indent
  })
})

// ── getServerStatus ───────────────────────────────────────────────

describe('getServerStatus()', () => {
  it('returns [] before startAll() is called', () => {
    expect(newMgr().getServerStatus()).toEqual([])
  })
})

// ── getToolSchemas ────────────────────────────────────────────────

describe('getToolSchemas()', () => {
  it('returns [] when no servers are running', () => {
    expect(newMgr().getToolSchemas()).toEqual([])
  })

  it('maps MCP tool inputSchema to LM Studio function.parameters shape', async () => {
    const toolDef = {
      name:        'read_file',
      description: 'Read a file',
      inputSchema: {
        type:       'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required:   ['path'],
      },
    }
    setConfig({ 'fs': { command: 'npx', enabled: true } })
    sdkMocks.listTools.mockResolvedValue({ tools: [toolDef] })

    const mgr = newMgr()
    await mgr.startAll()

    const schemas = mgr.getToolSchemas()
    expect(schemas).toHaveLength(1)
    expect(schemas[0].function.name).toBe('fs__read_file')
    expect(schemas[0].function.parameters).toEqual({
      type:       'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required:   ['path'],
    })
  })

  it('namespaces tool names as serverName__toolName', async () => {
    setConfig({ 'fs': { command: 'npx', enabled: true } })
    sdkMocks.listTools.mockResolvedValue({ tools: [{ name: 'read_file', description: 'Read' }] })

    const mgr = newMgr()
    await mgr.startAll()

    expect(mgr.getToolSchemas()[0].function.name).toBe('fs__read_file')
  })
})

// ── removeServer ──────────────────────────────────────────────────

describe('removeServer()', () => {
  it('removes the server from the in-memory status map', async () => {
    setConfig({ 'my-server': { command: 'node', enabled: true } })

    const mgr = newMgr()
    await mgr.startAll()
    expect(mgr.getServerStatus()).toHaveLength(1)

    // After removal, subsequent readConfig returns empty config
    fsMock.readFileSync.mockReturnValue(JSON.stringify({}))
    await mgr.removeServer('my-server')

    expect(mgr.getServerStatus()).toHaveLength(0)
  })
})

// ── start failure → error status ──────────────────────────────────

describe('startAll() — server start failure', () => {
  it('sets status to error when the server fails to connect', async () => {
    setConfig({ 'bad-server': { command: 'nonexistent-bin', enabled: true } })
    sdkMocks.connect.mockRejectedValue(new Error('spawn ENOENT'))

    const mgr = newMgr()
    await mgr.startAll()

    const statuses = mgr.getServerStatus()
    expect(statuses).toHaveLength(1)
    expect(statuses[0].status).toBe('error')
    expect(statuses[0].error).toContain('ENOENT')
  })
})

// ── callTool guards ───────────────────────────────────────────────

describe('callTool()', () => {
  it('throws if the server is not running', async () => {
    await expect(newMgr().callTool('nonexistent', 'some_tool', {})).rejects.toThrow(
      'is not running'
    )
  })
})
