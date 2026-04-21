import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServerManager } from '../McpServerManager'
import type { McpServerSettings } from '../../../shared/types'

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
