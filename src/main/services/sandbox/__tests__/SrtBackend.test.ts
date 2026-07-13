import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { SandboxRunSpec } from '../types'

// ── Mock @anthropic-ai/sandbox-runtime — SrtBackend delegates config/command
// building to SandboxManager; we only care that SrtBackend passes the right
// spawn() options through, not that the real sandbox-exec wrapping happens.
const { mockInitialize, mockUpdateConfig, mockWrapWithSandbox, mockWrapWithSandboxArgv, mockReset } = vi.hoisted(() => ({
  mockInitialize: vi.fn(async () => {}),
  mockUpdateConfig: vi.fn((_config: { network: { allowedDomains: string[] } }) => {}),
  mockWrapWithSandbox: vi.fn(async (command: string) => `sandbox-exec -f wrapped -- ${command}`),
  mockWrapWithSandboxArgv: vi.fn(async (command: string) => ({
    argv: ['sandbox-exec', '-f', 'wrapped', '--', ...command.split(' ')],
    env: { ...process.env, SANDBOX_MARKER: '1' },
  })),
  mockReset: vi.fn(async () => {}),
}))

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    initialize: mockInitialize,
    updateConfig: mockUpdateConfig,
    wrapWithSandbox: mockWrapWithSandbox,
    wrapWithSandboxArgv: mockWrapWithSandboxArgv,
    reset: mockReset,
  },
}))

// ── Mock child_process.spawn — capture the options passed by SrtBackend ────
function makeMockChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}))

// Import AFTER mocks are in place
import { SrtBackend } from '../SrtBackend'

const baseSpec: SandboxRunSpec = {
  workspaceDir: '/tmp/workspace',
  command: 'python3 /tmp/workspace/_exec.py',
  executionProfile: 'lightweight',
  allowedDomains: [],
  allowWrite: ['/tmp/workspace'],
  denyRead: [],
  timeoutMs: 30_000,
  maxRssMb: 512,
}

describe('SrtBackend.run', () => {
  beforeEach(() => {
    mockSpawn.mockReset()
    mockInitialize.mockClear()
    mockUpdateConfig.mockClear()
    mockWrapWithSandbox.mockClear()
  })

  it('merges spec.env with process.env and passes it to spawn()', async () => {
    const child = makeMockChild()
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0))
      return child
    })

    const backend = new SrtBackend()
    const spec: SandboxRunSpec = { ...baseSpec, env: { MPLBACKEND: 'Agg' } }

    const originalPathEnv = process.env['PATH']
    const result = await backend.run(spec)

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [, options] = mockSpawn.mock.calls[0]
    expect(options.env).toMatchObject({ MPLBACKEND: 'Agg' })
    // process.env is preserved additively — an unrelated existing var survives.
    expect(options.env.PATH).toBe(originalPathEnv)
    expect(result.exitCode).toBe(0)
  })

  it('does not throw when spec.env is undefined', async () => {
    const child = makeMockChild()
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0))
      return child
    })

    const backend = new SrtBackend()
    await expect(backend.run(baseSpec)).resolves.toMatchObject({ exitCode: 0 })

    const [, options] = mockSpawn.mock.calls[0]
    expect(options.env).toMatchObject(process.env as Record<string, string>)
  })

  // Regression test for a real bug found 2026-07-13 (progress.md row 303):
  // wrapWithSandbox()'s customConfig does NOT push a new network allowlist to
  // the live enforcement proxy — only SandboxManager.updateConfig() does.
  // Every spec-specific network policy must be pushed via updateConfig()
  // before wrapWithSandbox() is called, or the process silently gets
  // initialize()'s (deny-all) network policy instead of spec.allowedDomains.
  it('calls SandboxManager.updateConfig() with the per-spec allowlist before wrapWithSandbox()', async () => {
    const child = makeMockChild()
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0))
      return child
    })

    const backend = new SrtBackend()
    const spec: SandboxRunSpec = {
      ...baseSpec,
      allowedDomains: ['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'fc.yahoo.com'],
    }

    await backend.run(spec)

    expect(mockUpdateConfig).toHaveBeenCalledTimes(1)
    const [config] = mockUpdateConfig.mock.calls[0]
    expect(config.network.allowedDomains).toEqual([
      'query1.finance.yahoo.com',
      'query2.finance.yahoo.com',
      'fc.yahoo.com',
    ])

    // updateConfig() must run before wrapWithSandbox() — check call order.
    const updateOrder = mockUpdateConfig.mock.invocationCallOrder[0]
    const wrapOrder = mockWrapWithSandbox.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(wrapOrder)
  })
})

describe('SrtBackend.wrapStdioCommand', () => {
  beforeEach(() => {
    mockInitialize.mockClear()
    mockUpdateConfig.mockClear()
    mockWrapWithSandboxArgv.mockClear()
  })

  it('calls updateConfig() with the per-spec allowlist before wrapWithSandboxArgv()', async () => {
    const backend = new SrtBackend()
    const spec: SandboxRunSpec = {
      ...baseSpec,
      command: 'node /path/to/server.js --flag',
      allowedDomains: ['api.example.com'],
    }

    await backend.wrapStdioCommand(spec)

    expect(mockUpdateConfig).toHaveBeenCalledTimes(1)
    const [config] = mockUpdateConfig.mock.calls[0]
    expect(config.network.allowedDomains).toEqual(['api.example.com'])

    expect(mockWrapWithSandboxArgv).toHaveBeenCalledTimes(1)
    const updateOrder = mockUpdateConfig.mock.invocationCallOrder[0]
    const wrapOrder = mockWrapWithSandboxArgv.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(wrapOrder)
  })

  it('reshapes { argv, env } into { command, args, env }', async () => {
    const backend = new SrtBackend()
    const spec: SandboxRunSpec = { ...baseSpec, command: 'node /path/to/server.js --flag' }

    const result = await backend.wrapStdioCommand(spec)

    expect(result.command).toBe('sandbox-exec')
    expect(result.args).toEqual(['-f', 'wrapped', '--', 'node', '/path/to/server.js', '--flag'])
    expect(result.env).toMatchObject({ SANDBOX_MARKER: '1' })
  })

  it('lazily initializes if not already initialized', async () => {
    const backend = new SrtBackend()
    await backend.wrapStdioCommand(baseSpec)
    expect(mockInitialize).toHaveBeenCalledTimes(1)
  })
})
