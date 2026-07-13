import { describe, it, expect } from 'vitest'
import type { SandboxRunSpec } from '../types'
import { MicrosandboxBackend } from '../MicrosandboxBackend'

const NOT_IMPLEMENTED =
  'MicrosandboxBackend is not yet implemented — ' +
  'see SANDBOX_ARCHITECTURE_SPEC.html section 14 for the benchmark gate ' +
  'that must pass before this backend is enabled'

const baseSpec: SandboxRunSpec = {
  workspaceDir: '/tmp/workspace',
  command: 'node /path/to/server.js',
  executionProfile: 'untrusted-heavy',
  allowedDomains: [],
  allowWrite: [],
  denyRead: [],
  timeoutMs: 0,
  maxRssMb: 512,
}

describe('MicrosandboxBackend', () => {
  it('run() throws NOT_IMPLEMENTED', async () => {
    const backend = new MicrosandboxBackend()
    await expect(backend.run(baseSpec)).rejects.toThrow(NOT_IMPLEMENTED)
  })

  it('spawnPersistent() throws NOT_IMPLEMENTED', async () => {
    const backend = new MicrosandboxBackend()
    await expect(backend.spawnPersistent(baseSpec)).rejects.toThrow(NOT_IMPLEMENTED)
  })

  it('wrapStdioCommand() throws the same NOT_IMPLEMENTED error', async () => {
    const backend = new MicrosandboxBackend()
    await expect(backend.wrapStdioCommand(baseSpec)).rejects.toThrow(NOT_IMPLEMENTED)
  })

  it('initialize() and shutdown() are no-ops that resolve cleanly', async () => {
    const backend = new MicrosandboxBackend()
    await expect(backend.initialize()).resolves.toBeUndefined()
    await expect(backend.shutdown()).resolves.toBeUndefined()
  })
})
