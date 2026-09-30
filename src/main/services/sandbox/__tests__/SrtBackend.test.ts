import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'path'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { SandboxRunSpec } from '../types'

// BASELINE_DENY_READ resolves the app settings path via electron's app.
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? '/tmp/di-srt-test-userdata' : '/tmp') },
}))

import { SrtBackend } from '../SrtBackend'
import { BASELINE_DENY_READ } from '../BASELINE_DENY_READ'
import type { SandboxViolationTraceEvent } from '../../../../shared/types'

// Real child processes throughout; only the policy host is a protocol-level
// fake (no sandbox-exec) — see fixtures/fakePolicyHost.mjs.
const FAKE_HOST = join(__dirname, 'fixtures', 'fakePolicyHost.mjs')

const baseSpec: SandboxRunSpec = {
  workspaceDir: '/tmp/workspace',
  command: 'true',
  executionProfile: 'lightweight',
  allowedDomains: [],
  allowWrite: [],
  denyRead: [],
  timeoutMs: 10_000,
  maxRssMb: 0,
}

let backend: SrtBackend
function makeBackend(opts: { hostIdleMs?: number } = {}): SrtBackend {
  backend = new SrtBackend({ hostEntry: FAKE_HOST, hostExecArgv: [], ...opts })
  return backend
}

afterEach(async () => {
  await backend?.shutdown()
})

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

function readLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      if (buf.includes('\n')) resolve(buf.split('\n')[0])
    })
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('SrtBackend.run', () => {
  it('returns stdout, stderr and exit code from the wrapped command', async () => {
    const result = await makeBackend().run({ ...baseSpec, command: 'echo out; echo err >&2; exit 3' })
    expect(result).toMatchObject({ stdout: 'out\n', exitCode: 3, backend: 'srt' })
    expect(result.stderr).toContain('err')
  })

  it('merges spec.env over process.env', async () => {
    const result = await makeBackend().run({
      ...baseSpec,
      command: 'printf "%s|%s" "$SPEC_VAR" "$HOME"',
      env: { SPEC_VAR: 'from-spec' },
    })
    expect(result.stdout).toBe(`from-spec|${process.env.HOME}`)
  })

  it('passes the merged deny-read baseline, workspace-writable allowlist and network policy to the host', async () => {
    const result = await makeBackend().run({
      ...baseSpec,
      command: 'printf "%s" "$WRAP_CONFIG"',
      allowedDomains: ['api.example.com'],
      allowWrite: ['/tmp/extra'],
      denyRead: ['/secret/file'],
    })
    const config = JSON.parse(Buffer.from(result.stdout, 'base64').toString())
    expect(config.network.allowedDomains).toEqual(['api.example.com'])
    expect(config.filesystem.denyRead).toEqual(expect.arrayContaining([...BASELINE_DENY_READ, '/secret/file']))
    expect(config.filesystem.allowWrite).toEqual(['/tmp/workspace', '/tmp/extra'])
  })

  it('kills the whole process group when the wall-clock timeout expires (D6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srt-timeout-'))
    const pidFile = join(dir, 'grandchild.pid')
    const started = Date.now()
    const result = await makeBackend().run({
      ...baseSpec,
      // A backgrounded grandchild — killing only the shell would orphan it.
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
      timeoutMs: 400,
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain('wall-clock timeout (400 ms)')
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    await new Promise((r) => setTimeout(r, 100))
    expect(isAlive(grandchild)).toBe(false)
  })

  it('kills a process tree that exceeds maxRssMb within one polling interval (D7)', async () => {
    try {
      execSync('which python3', { stdio: 'ignore' })
    } catch {
      return // python3 unavailable — covered by ResourceGovernor unit tests
    }
    const started = Date.now()
    const result = await makeBackend().run({
      ...baseSpec,
      // The memory is held by python, a descendant of the spawned shell.
      command: `python3 -c "x = bytearray(300 * 1024 * 1024); import time; time.sleep(30)"`,
      timeoutMs: 20_000,
      maxRssMb: 100,
    })
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain('RSS exceeded 100 MB')
    expect(Date.now() - started).toBeLessThan(12_000)
  }, 20_000)
})

describe('SrtBackend network policy isolation', () => {
  it('gives processes with different allowlists different policy hosts, and identical allowlists the same one', async () => {
    const b = makeBackend()
    const a = await b.spawnPersistent({ ...baseSpec, allowedDomains: ['a.test', 'b.test'], command: 'echo "$HOST_PID $HOST_POLICY"; cat' })
    const sameSet = await b.spawnPersistent({ ...baseSpec, allowedDomains: ['b.test', 'a.test'], command: 'echo "$HOST_PID $HOST_POLICY"; cat' })
    const none = await b.spawnPersistent({ ...baseSpec, allowedDomains: [], command: 'echo "$HOST_PID $HOST_POLICY"; cat' })

    const [lineA, lineSame, lineNone] = await Promise.all([readLine(a), readLine(sameSet), readLine(none)])
    const [pidA, policyA] = lineA.split(' ')
    const [pidSame] = lineSame.split(' ')
    const [pidNone, policyNone] = lineNone.split(' ')

    expect(pidSame).toBe(pidA)
    expect(pidNone).not.toBe(pidA)
    expect(JSON.parse(policyA)).toEqual(['a.test', 'b.test'])
    expect(JSON.parse(policyNone)).toEqual([])
    expect(b.getActivePolicies()).toEqual(
      expect.arrayContaining([
        { allowedDomains: ['a.test', 'b.test'], allowLocalBinding: false, leases: 2 },
        { allowedDomains: [], allowLocalBinding: false, leases: 1 },
      ])
    )

    for (const child of [a, sameSet, none]) child.kill()
  })

  it('releases a persistent lease on exit and stops the idle host', async () => {
    const b = makeBackend({ hostIdleMs: 50 })
    const child = await b.spawnPersistent({ ...baseSpec, allowedDomains: ['idle.test'], command: 'exit 0' })
    await waitForExit(child)
    expect(b.getActivePolicies()).toEqual([{ allowedDomains: ['idle.test'], allowLocalBinding: false, leases: 0 }])
    await new Promise((r) => setTimeout(r, 400))
    expect(b.getActivePolicies()).toEqual([])
  })

  it('keeps the deny-all host warm after initialize()', async () => {
    const b = makeBackend({ hostIdleMs: 20 })
    await b.initialize()
    await b.run({ ...baseSpec })
    await new Promise((r) => setTimeout(r, 200))
    expect(b.getActivePolicies()).toEqual([{ allowedDomains: [], allowLocalBinding: false, leases: 0 }])
  })

  it('wrapStdioCommand returns a bash -c argv and holds the lease until release()', async () => {
    const b = makeBackend({ hostIdleMs: 20 })
    const wrapped = await b.wrapStdioCommand({ ...baseSpec, allowedDomains: ['mcp.test'], command: 'my-server --flag' })
    expect(wrapped.command).toBe('/bin/bash')
    expect(wrapped.args[0]).toBe('-c')
    expect(wrapped.args[1]).toMatch(/HOST_POLICY='\["mcp.test"\]' .*; my-server --flag$/)
    expect(wrapped.env.PATH).toBe(process.env.PATH)
    expect(wrapped.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(b.getActivePolicies()).toEqual([{ allowedDomains: ['mcp.test'], allowLocalBinding: false, leases: 1 }])

    wrapped.release()
    wrapped.release() // idempotent
    expect(b.getActivePolicies()).toEqual([{ allowedDomains: ['mcp.test'], allowLocalBinding: false, leases: 0 }])
  })

  it('replaces a crashed policy host on the next lease', async () => {
    const b = makeBackend()
    const first = await b.run({ ...baseSpec, allowedDomains: ['crash.test'], command: 'printf "%s" "$HOST_PID"' })
    process.kill(Number(first.stdout), 'SIGKILL')
    await new Promise((r) => setTimeout(r, 100))
    const second = await b.run({ ...baseSpec, allowedDomains: ['crash.test'], command: 'printf "%s" "$HOST_PID"' })
    expect(second.exitCode).toBe(0)
    expect(second.stdout).not.toBe(first.stdout)
  })

  it('isolates loopback binding as part of the policy (same domains, different host)', async () => {
    const b = makeBackend()
    const plain = await b.run({ ...baseSpec, allowedDomains: ['x.test'], command: 'printf "%s" "$HOST_PID"' })
    const binding = await b.run({ ...baseSpec, allowedDomains: ['x.test'], allowLocalBinding: true, command: 'printf "%s" "$HOST_PID"' })
    expect(binding.stdout).not.toBe(plain.stdout)
    expect(b.getActivePolicies()).toEqual(
      expect.arrayContaining([
        { allowedDomains: ['x.test'], allowLocalBinding: false, leases: 0 },
        { allowedDomains: ['x.test'], allowLocalBinding: true, leases: 0 },
      ])
    )
  })

  it('rejects (fails closed) when the policy host cannot initialize, without leaking a lease', async () => {
    const b = makeBackend()
    await expect(b.run({ ...baseSpec, allowedDomains: ['fail-init.test'] })).rejects.toThrow(
      'simulated init failure'
    )
    expect(b.getActivePolicies().filter((p) => p.leases > 0)).toEqual([])
  })
})

describe('SrtBackend.subscribeToViolations', () => {
  it('delivers host violations parsed and attributed to the caller label; skips unclassifiable ones', async () => {
    const b = makeBackend()
    const events: SandboxViolationTraceEvent[] = []
    b.subscribeToViolations((e) => events.push(e))
    await b.run({ ...baseSpec, command: 'echo violate', callerLabel: 'python-worker' })
    await new Promise((r) => setTimeout(r, 50))
    expect(events).toEqual([
      { source: 'python-worker', kind: 'read', target: '/Users/someone/.ssh/id_rsa', timestamp: 1234 },
    ])
  })

  it('falls back to "unknown" for an unlabeled command, and unsubscribe stops delivery', async () => {
    const b = makeBackend()
    const events: SandboxViolationTraceEvent[] = []
    const unsubscribe = b.subscribeToViolations((e) => events.push(e))
    await b.run({ ...baseSpec, command: 'echo violate unlabeled' })
    await new Promise((r) => setTimeout(r, 50))
    expect(events.map((e) => e.source)).toEqual(['unknown'])

    unsubscribe()
    await b.run({ ...baseSpec, command: 'echo violate again' })
    await new Promise((r) => setTimeout(r, 50))
    expect(events).toHaveLength(1)
  })
})

describe('SrtBackend.shutdown', () => {
  it('stops every policy host and kills in-flight runs', async () => {
    const b = makeBackend()
    const pending = b.run({ ...baseSpec, allowedDomains: ['slow.test'], command: 'sleep 30', timeoutMs: 0 })
    await new Promise((r) => setTimeout(r, 300))
    await b.shutdown()
    const result = await pending
    expect(result.exitCode).toBe(-1)
    expect(b.getActivePolicies()).toEqual([])
  })
})
