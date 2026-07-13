import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { SandboxExecutionBackend, SandboxRunSpec, SandboxRunResult } from '../types'
import { SandboxService } from '../../SandboxService'

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeMockChildProcess(): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter()
  return {
    pid: 12345,
    stdin: { write: vi.fn(), ...emitter } as any,
    stdout: emitter as any,
    stderr: emitter as any,
    killed: false,
    kill: vi.fn(),
    on: vi.fn(() => {
      return emitter as any
    }),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  } as unknown as ChildProcessWithoutNullStreams
}

function makeMockBackend(
  name: 'srt' | 'microsandbox',
  runImpl?: (spec: SandboxRunSpec) => Promise<SandboxRunResult>,
  spawnPersistentImpl?: (spec: SandboxRunSpec) => Promise<ChildProcessWithoutNullStreams>,
  wrapStdioCommandImpl?: (
    spec: SandboxRunSpec
  ) => Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>
): SandboxExecutionBackend {
  return {
    name,
    initialize: vi.fn(async () => {}),
    run:
      runImpl ??
      vi.fn(async (_spec: SandboxRunSpec): Promise<SandboxRunResult> => ({
        stdout: `mock-${name}-stdout`,
        stderr: '',
        exitCode: 0,
        backend: name
      })),
    spawnPersistent:
      spawnPersistentImpl ??
      vi.fn(async (_spec: SandboxRunSpec): Promise<ChildProcessWithoutNullStreams> =>
        makeMockChildProcess()
      ),
    wrapStdioCommand:
      wrapStdioCommandImpl ??
      vi.fn(async (_spec: SandboxRunSpec) => ({
        command: `mock-${name}-command`,
        args: ['--mock'],
        env: {} as NodeJS.ProcessEnv,
      })),
    shutdown: vi.fn(async () => {})
  }
}

const baseSpec: SandboxRunSpec = {
  workspaceDir: '/tmp/workspace',
  command: 'python3 /tmp/workspace/_exec.py',
  executionProfile: 'lightweight',
  allowedDomains: [],
  allowWrite: ['/tmp/workspace'],
  denyRead: [],
  timeoutMs: 30_000,
  maxRssMb: 512
}

// ── run() tests ───────────────────────────────────────────────────────────────

describe('SandboxService routing', () => {
  it('routes lightweight profile to the srt backend', async () => {
    const srt = makeMockBackend('srt')
    const microsandbox = makeMockBackend('microsandbox')
    const service = new SandboxService(srt, microsandbox)

    const result = await service.run(baseSpec)

    expect(srt.run).toHaveBeenCalledTimes(1)
    expect(srt.run).toHaveBeenCalledWith(baseSpec)
    expect(microsandbox.run).not.toHaveBeenCalled()
    expect(result.backend).toBe('srt')
  })

  it('routes untrusted-heavy profile to the microsandbox backend', async () => {
    const srt = makeMockBackend('srt')
    const microsandbox = makeMockBackend('microsandbox')
    const service = new SandboxService(srt, microsandbox)

    const heavySpec: SandboxRunSpec = { ...baseSpec, executionProfile: 'untrusted-heavy' }

    const result = await service.run(heavySpec)

    expect(microsandbox.run).toHaveBeenCalledTimes(1)
    expect(microsandbox.run).toHaveBeenCalledWith(heavySpec)
    expect(srt.run).not.toHaveBeenCalled()
    expect(result.backend).toBe('microsandbox')
  })

  it('does NOT silently fall back to srt when microsandbox throws', async () => {
    const srt = makeMockBackend('srt')
    const throwingMicrosandbox = makeMockBackend('microsandbox', async () => {
      throw new Error('MicrosandboxBackend is not yet implemented')
    })
    const service = new SandboxService(srt, throwingMicrosandbox)

    const heavySpec: SandboxRunSpec = { ...baseSpec, executionProfile: 'untrusted-heavy' }

    await expect(service.run(heavySpec)).rejects.toThrow(
      'MicrosandboxBackend is not yet implemented'
    )

    expect(srt.run).not.toHaveBeenCalled()
  })

  it('propagates the exact rejection message from microsandbox', async () => {
    const srt = makeMockBackend('srt')
    const expectedMessage =
      'MicrosandboxBackend is not yet implemented — ' +
      'see SANDBOX_ARCHITECTURE_SPEC.html section 14 for the benchmark gate ' +
      'that must pass before this backend is enabled'
    const microsandbox = makeMockBackend('microsandbox', async () => {
      throw new Error(expectedMessage)
    })
    const service = new SandboxService(srt, microsandbox)

    const heavySpec: SandboxRunSpec = { ...baseSpec, executionProfile: 'untrusted-heavy' }

    await expect(service.run(heavySpec)).rejects.toThrow(expectedMessage)
  })

  it('returns the srt result unchanged for lightweight profile', async () => {
    const expectedResult: SandboxRunResult = {
      stdout: 'hello world',
      stderr: '',
      exitCode: 0,
      backend: 'srt'
    }
    const srt = makeMockBackend('srt', async () => expectedResult)
    const microsandbox = makeMockBackend('microsandbox')
    const service = new SandboxService(srt, microsandbox)

    const result = await service.run(baseSpec)

    expect(result).toEqual(expectedResult)
    expect(result.backend).toBe('srt')
  })

  it('calls srt.run exactly once per lightweight invocation', async () => {
    const srt = makeMockBackend('srt')
    const microsandbox = makeMockBackend('microsandbox')
    const service = new SandboxService(srt, microsandbox)

    await service.run(baseSpec)
    await service.run(baseSpec)
    await service.run(baseSpec)

    expect(srt.run).toHaveBeenCalledTimes(3)
    expect(microsandbox.run).not.toHaveBeenCalled()
  })
})

// ── spawnPersistent() tests ───────────────────────────────────────────────────

describe('SandboxService spawnPersistent routing', () => {
  it('routes lightweight spawnPersistent to the srt backend', async () => {
    const srt = makeMockBackend('srt')
    const microsandbox = makeMockBackend('microsandbox')
    const service = new SandboxService(srt, microsandbox)

    const proc = await service.spawnPersistent(baseSpec)

    expect(srt.spawnPersistent).toHaveBeenCalledTimes(1)
    expect(srt.spawnPersistent).toHaveBeenCalledWith(baseSpec)
    expect(microsandbox.spawnPersistent).not.toHaveBeenCalled()
    expect(proc.pid).toBe(12345)
  })

  it('routes untrusted-heavy spawnPersistent to the microsandbox backend', async () => {
    const srt = makeMockBackend('srt')
    const microsandbox = makeMockBackend('microsandbox')
    const service = new SandboxService(srt, microsandbox)

    const heavySpec: SandboxRunSpec = { ...baseSpec, executionProfile: 'untrusted-heavy' }

    const proc = await service.spawnPersistent(heavySpec)

    expect(microsandbox.spawnPersistent).toHaveBeenCalledTimes(1)
    expect(microsandbox.spawnPersistent).toHaveBeenCalledWith(heavySpec)
    expect(srt.spawnPersistent).not.toHaveBeenCalled()
    expect(proc.pid).toBe(12345)
  })

  it('does NOT silently fall back to srt spawnPersistent when microsandbox throws', async () => {
    const srt = makeMockBackend('srt')
    const throwingMicrosandbox = makeMockBackend('microsandbox', undefined, async () => {
      throw new Error('MicrosandboxBackend is not yet implemented')
    })
    const service = new SandboxService(srt, throwingMicrosandbox)

    const heavySpec: SandboxRunSpec = { ...baseSpec, executionProfile: 'untrusted-heavy' }

    await expect(service.spawnPersistent(heavySpec)).rejects.toThrow(
      'MicrosandboxBackend is not yet implemented'
    )

    expect(srt.spawnPersistent).not.toHaveBeenCalled()
  })

  it('calls srt.spawnPersistent exactly once per lightweight invocation', async () => {
    const srt = makeMockBackend('srt')
    const microsandbox = makeMockBackend('microsandbox')
    const service = new SandboxService(srt, microsandbox)

    await service.spawnPersistent(baseSpec)
    await service.spawnPersistent(baseSpec)

    expect(srt.spawnPersistent).toHaveBeenCalledTimes(2)
    expect(microsandbox.spawnPersistent).not.toHaveBeenCalled()
  })
})

// ── wrapStdioCommand() tests ──────────────────────────────────────────────────

describe('SandboxService wrapStdioCommand routing', () => {
  it('routes lightweight wrapStdioCommand to the srt backend', async () => {
    const srt = makeMockBackend('srt')
    const microsandbox = makeMockBackend('microsandbox')
    const service = new SandboxService(srt, microsandbox)

    const result = await service.wrapStdioCommand(baseSpec)

    expect(srt.wrapStdioCommand).toHaveBeenCalledTimes(1)
    expect(srt.wrapStdioCommand).toHaveBeenCalledWith(baseSpec)
    expect(microsandbox.wrapStdioCommand).not.toHaveBeenCalled()
    expect(result.command).toBe('mock-srt-command')
  })

  it('routes untrusted-heavy wrapStdioCommand to the microsandbox backend', async () => {
    const srt = makeMockBackend('srt')
    const microsandbox = makeMockBackend('microsandbox')
    const service = new SandboxService(srt, microsandbox)

    const heavySpec: SandboxRunSpec = { ...baseSpec, executionProfile: 'untrusted-heavy' }

    const result = await service.wrapStdioCommand(heavySpec)

    expect(microsandbox.wrapStdioCommand).toHaveBeenCalledTimes(1)
    expect(microsandbox.wrapStdioCommand).toHaveBeenCalledWith(heavySpec)
    expect(srt.wrapStdioCommand).not.toHaveBeenCalled()
    expect(result.command).toBe('mock-microsandbox-command')
  })

  it('does NOT silently fall back to srt when microsandbox.wrapStdioCommand throws', async () => {
    const srt = makeMockBackend('srt')
    const throwingMicrosandbox = makeMockBackend('microsandbox', undefined, undefined, async () => {
      throw new Error('MicrosandboxBackend is not yet implemented')
    })
    const service = new SandboxService(srt, throwingMicrosandbox)

    const heavySpec: SandboxRunSpec = { ...baseSpec, executionProfile: 'untrusted-heavy' }

    await expect(service.wrapStdioCommand(heavySpec)).rejects.toThrow(
      'MicrosandboxBackend is not yet implemented'
    )

    expect(srt.wrapStdioCommand).not.toHaveBeenCalled()
  })
})