import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { SandboxRunSpec } from '../types'

interface FakeViolation {
  line: string
  command?: string
  timestamp: Date
}

// ── Mock @anthropic-ai/sandbox-runtime — SrtBackend delegates config/command
// building to SandboxManager; we only care that SrtBackend passes the right
// spawn() options through, not that the real sandbox-exec wrapping happens.
const { mockInitialize, mockUpdateConfig, mockWrapWithSandbox, mockWrapWithSandboxArgv, mockReset, mockGetSandboxViolationStore, fakeStoreState } = vi.hoisted(() => {
  const fakeStoreState = {
    violations: [] as FakeViolation[],
    totalCount: 0,
    listeners: [] as Array<(v: FakeViolation[]) => void>,
  }
  const mockGetSandboxViolationStore = vi.fn(() => ({
    getTotalCount: () => fakeStoreState.totalCount,
    getViolations: () => [...fakeStoreState.violations],
    subscribe: (listener: (v: FakeViolation[]) => void) => {
      fakeStoreState.listeners.push(listener)
      listener([...fakeStoreState.violations])
      return () => {
        const i = fakeStoreState.listeners.indexOf(listener)
        if (i !== -1) fakeStoreState.listeners.splice(i, 1)
      }
    },
  }))
  return {
    mockInitialize: vi.fn(async () => {}),
    mockUpdateConfig: vi.fn((_config: { network: { allowedDomains: string[] } }) => {}),
    mockWrapWithSandbox: vi.fn(async (command: string) => `sandbox-exec -f wrapped -- ${command}`),
    mockWrapWithSandboxArgv: vi.fn(async (command: string) => ({
      argv: ['sandbox-exec', '-f', 'wrapped', '--', ...command.split(' ')],
      env: { ...process.env, SANDBOX_MARKER: '1' },
    })),
    mockReset: vi.fn(async () => {}),
    mockGetSandboxViolationStore,
    fakeStoreState,
  }
})

// Simulates SandboxViolationStore.addViolation() — pushes + notifies all
// current subscribers with the FULL array (matches the real store's
// "always notify with all violations" behavior, see SrtBackend.ts header).
function fakeAddViolation(v: FakeViolation): void {
  fakeStoreState.violations.push(v)
  fakeStoreState.totalCount++
  for (const listener of [...fakeStoreState.listeners]) {
    listener([...fakeStoreState.violations])
  }
}

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    initialize: mockInitialize,
    updateConfig: mockUpdateConfig,
    wrapWithSandbox: mockWrapWithSandbox,
    wrapWithSandboxArgv: mockWrapWithSandboxArgv,
    reset: mockReset,
    getSandboxViolationStore: mockGetSandboxViolationStore,
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

describe('SrtBackend.subscribeToViolations', () => {
  beforeEach(() => {
    fakeStoreState.violations = []
    fakeStoreState.totalCount = 0
    fakeStoreState.listeners = []
    mockGetSandboxViolationStore.mockClear()
  })

  it('delivers a new violation labeled with the caller that triggered it, classified from the line', async () => {
    const backend = new SrtBackend()
    const spec: SandboxRunSpec = {
      ...baseSpec,
      command: 'python3 /path/to/worker.py',
      callerLabel: 'python-worker',
    }
    await backend.wrapStdioCommand(spec) // populates commandLabels via buildPerSpecConfig

    const received: unknown[] = []
    backend.subscribeToViolations((event) => received.push(event))

    fakeAddViolation({
      line: 'python3(123) deny(1) file-read-data /Users/x/.ssh/id_ed25519',
      command: 'python3 /path/to/worker.py',
      timestamp: new Date('2026-07-13T12:00:00.000Z'),
    })

    expect(received).toEqual([
      {
        source: 'python-worker',
        kind: 'read',
        target: '/Users/x/.ssh/id_ed25519',
        timestamp: new Date('2026-07-13T12:00:00.000Z').getTime(),
      },
    ])
  })

  it('classifies write and network operations correctly', async () => {
    const backend = new SrtBackend()
    const received: Array<{ kind: string }> = []
    backend.subscribeToViolations((event) => received.push(event))

    fakeAddViolation({ line: 'proc(1) deny(1) file-write-create /tmp/x', timestamp: new Date() })
    fakeAddViolation({ line: 'proc(1) deny(1) network-outbound 93.184.216.34:443', timestamp: new Date() })

    expect(received.map((e) => e.kind)).toEqual(['write', 'network'])
  })

  it('skips violations whose operation does not map to read/write/network', async () => {
    const backend = new SrtBackend()
    const received: unknown[] = []
    backend.subscribeToViolations((event) => received.push(event))

    fakeAddViolation({ line: 'bash(1) deny(1) sysctl-read kern.iossupportversion', timestamp: new Date() })
    // sysctl-read DOES contain "read" per the generalized classifier — use
    // a genuinely unclassifiable operation to test the skip path instead.
    fakeAddViolation({ line: 'proc(1) deny(1) mach-lookup com.apple.foo', timestamp: new Date() })

    // sysctl-read → 'read' (1 delivered), mach-lookup → skipped (0 delivered)
    expect(received).toHaveLength(1)
  })

  it('falls back to "unknown" when the violation is not attributable to a tracked command', async () => {
    const backend = new SrtBackend()
    const received: Array<{ source: string }> = []
    backend.subscribeToViolations((event) => received.push(event))

    fakeAddViolation({
      line: 'proc(1) deny(1) file-read-data /some/path',
      command: 'node /never-called-through-srtbackend.js',
      timestamp: new Date(),
    })

    expect(received).toEqual([{ source: 'unknown', kind: 'read', target: '/some/path', timestamp: expect.any(Number) }])
  })

  it('does not replay violations that existed before subscribing', async () => {
    fakeAddViolation({ line: 'proc(1) deny(1) file-read-data /pre-existing', timestamp: new Date() })

    const backend = new SrtBackend()
    const received: unknown[] = []
    backend.subscribeToViolations((event) => received.push(event))

    expect(received).toHaveLength(0)
  })

  it('the returned unsubscribe function stops delivery', async () => {
    const backend = new SrtBackend()
    const received: unknown[] = []
    const unsubscribe = backend.subscribeToViolations((event) => received.push(event))

    unsubscribe()
    fakeAddViolation({ line: 'proc(1) deny(1) file-read-data /after-unsubscribe', timestamp: new Date() })

    expect(received).toHaveLength(0)
  })
})
