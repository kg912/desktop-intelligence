import { describe, it, expect, vi, afterAll } from 'vitest'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import type { SandboxRunSpec } from '../types'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? '/tmp/di-srt-integration-userdata' : '/tmp') },
}))

import { SrtBackend } from '../SrtBackend'

// ── Environment gate ─────────────────────────────────────────────────────
// Real macOS Seatbelt + the real policy host (policyHost.ts via tsx) + real
// network. Skipped where any of those is unavailable rather than failing.
function canRun(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execSync('which sandbox-exec curl', { stdio: 'ignore' })
    execSync('curl -sS -o /dev/null --max-time 10 https://example.com', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const ENABLED = canRun()
const WORKSPACE = '/tmp/di-srt-integration-workspace'
execSync(`mkdir -p ${WORKSPACE}`)

const spec = (overrides: Partial<SandboxRunSpec>): SandboxRunSpec => ({
  workspaceDir: WORKSPACE,
  command: 'true',
  executionProfile: 'lightweight',
  allowedDomains: [],
  allowWrite: [],
  denyRead: [],
  timeoutMs: 30_000,
  maxRssMb: 0,
  ...overrides,
})

const curl = (url: string): string => `curl -sS -o /dev/null --max-time 15 ${url}`

describe.skipIf(!ENABLED)('SrtBackend — real sandbox integration', () => {
  const backend = new SrtBackend()

  afterAll(async () => {
    await backend.shutdown()
  })

  it('D4: a process with no declared domains cannot reach any host', async () => {
    const result = await backend.run(spec({ command: curl('https://example.com') }))
    expect(result.exitCode).not.toBe(0)
  }, 40_000)

  it('D5: a process with one allowed domain reaches only that domain', async () => {
    const allowed = await backend.run(spec({ allowedDomains: ['example.com'], command: curl('https://example.com') }))
    const other = await backend.run(spec({ allowedDomains: ['example.com'], command: curl('https://example.org') }))
    expect(allowed.exitCode).toBe(0)
    expect(other.exitCode).not.toBe(0)
  }, 60_000)

  it('keeps each running process on its own allowlist when other policies spawn concurrently', async () => {
    // A long-lived process allowed example.com waits for a line on stdin,
    // then tries the network — AFTER a deny-all process has been spawned.
    // With a single shared allowlist (the pre-2026-09-30 design) the later
    // spawn replaced A's policy and A's request failed.
    const a = await backend.spawnPersistent(
      spec({
        allowedDomains: ['example.com'],
        command: `read line; ${curl('https://example.com')} && echo A-OK || echo A-FAIL`,
      })
    )
    const aOutput = new Promise<string>((resolve) => {
      let buf = ''
      a.stdout.on('data', (d: Buffer) => {
        buf += d.toString()
        if (buf.includes('\n')) resolve(buf.trim())
      })
    })

    const denied = await backend.run(spec({ allowedDomains: [], command: curl('https://example.com') }))
    expect(denied.exitCode).not.toBe(0)

    a.stdin.write('go\n')
    expect(await aOutput).toBe('A-OK')
    a.kill()
  }, 60_000)

  it('D1: a sandboxed process cannot read a baseline-denied credential path', async () => {
    const target = join(homedir(), '.gitconfig')
    const result = await backend.run(spec({ command: `cat ${target}` }))
    expect(result.exitCode).not.toBe(0)
  }, 30_000)

  it('L3: the workspace is writable, the rest of the home directory is not', async () => {
    const inside = await backend.run(spec({ command: `touch ${WORKSPACE}/probe && echo ok` }))
    const outside = await backend.run(spec({ command: `touch ${homedir()}/di-sandbox-write-probe` }))
    expect(inside.stdout.trim()).toBe('ok')
    expect(outside.exitCode).not.toBe(0)
  }, 30_000)
})
