import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { execSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? '/tmp/di-fs-integration-userdata' : '/tmp') },
}))

import { SrtBackend } from '../../sandbox/SrtBackend'
import { BASELINE_DENY_READ } from '../../sandbox/BASELINE_DENY_READ'
import { FsToolService } from '../FsToolService'
import { FsGrantStore } from '../FsGrantStore'
import { FsReadLedger } from '../FsReadLedger'
import { realFsDeps } from '../pathPolicy'
import { defaultFsAccessSettings, type FsAccessSettings } from '../../../../shared/fsAccess'

// Real macOS Seatbelt through the real SrtBackend + policy host, the real
// worker (tsx), real folders under home (the OS read deny covers home only).
function canRun(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execSync('which sandbox-exec', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const ENABLED = canRun()

function descendants(pid: number): number[] {
  const rows = execSync('ps -A -o pid=,ppid=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
  const out: number[] = []
  const walk = (p: number): void => {
    for (const [c, pp] of rows) if (pp === p) out.push(c), walk(c)
  }
  walk(pid)
  return out
}
// Alive = present and not a zombie (kill(pid, 0) succeeds on an unreaped zombie).
const alive = (pid: number): boolean => {
  try {
    return !execSync(`ps -o stat= -p ${pid}`).toString().trim().startsWith('Z')
  } catch {
    return false
  }
}

describe.skipIf(!ENABLED)('FsToolService — real sandbox integration', () => {
  const home = realpathSync(homedir())
  const base = join(home, `.di-fs-it-${randomBytes(4).toString('hex')}`)
  const grant = join(base, 'grant')
  const readonly = join(base, 'readonly')
  const outside = join(base, 'outside')
  const backend = new SrtBackend()
  const svcKids: ChildProcessWithoutNullStreams[] = []
  const bareKids: ChildProcessWithoutNullStreams[] = []
  const settings: FsAccessSettings = {
    ...defaultFsAccessSettings(),
    roots: [
      { path: grant, access: 'write', askBeforeEdit: false, addedAt: 0 },
      { path: readonly, access: 'read', askBeforeEdit: true, addedAt: 0 },
    ],
  }
  const make = (testDisableWorkerCheck = false): FsToolService =>
    new FsToolService({
      spawn: async (spec) => {
        const c = await backend.spawnPersistent(spec)
        ;(testDisableWorkerCheck ? bareKids : svcKids).push(c)
        return c
      },
      sandboxReady: () => true,
      getSettings: () => settings,
      grants: new FsGrantStore(),
      ledger: new FsReadLedger(),
      policyDeps: realFsDeps({ homedir: home, userDataDir: join(base, 'ud'), credentialEntries: BASELINE_DENY_READ }),
      userDataDir: join(base, 'ud'),
      timeouts: { default: 20_000, grep: 4_000, ready: 30_000 },
      testDisableWorkerCheck,
    })
  const svc = make()
  const bare = make(true)

  beforeAll(() => {
    for (const d of [grant, readonly, outside, join(base, 'ud')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(grant, 'inside.txt'), 'inside\n')
    writeFileSync(join(readonly, 'r.txt'), 'r\n')
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    symlinkSync(outside, join(grant, 'link'))
  })
  afterAll(async () => {
    await svc.shutdown()
    await bare.shutdown()
    await backend.shutdown()
    rmSync(base, { recursive: true, force: true })
  })

  it('reads and edits inside a grant through the sandboxed worker', async () => {
    const p = join(grant, 'inside.txt')
    expect((await svc.run('read', { path: p }, { chatId: 'c' })).text).toContain('     1\tinside')
    await svc.run('edit', { path: p, old_string: 'inside', new_string: 'edited' }, { chatId: 'c' })
    expect(readFileSync(p, 'utf8')).toBe('edited\n')
  }, 60_000)

  it('the worker refuses a path outside the union even when main\'s policy is bypassed', async () => {
    // Outside home the OS allows reads, so this refusal is the worker's own policy.
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'di-fs-it-')))
    writeFileSync(join(tmp, 'x.txt'), 'x')
    await expect(svc.rawRequest('read', { path: join(tmp, 'x.txt') })).rejects.toThrow(`${join(tmp, 'x.txt')} is not inside a granted folder.`)
    rmSync(tmp, { recursive: true, force: true })
    // Under home the OS already hides it: realpath fails, so the worker refuses before reading.
    await expect(svc.rawRequest('read', { path: join(outside, 'secret.txt') })).rejects.toThrow(
      `Cannot resolve ${join(outside, 'secret.txt')} (EPERM).`
    )
  }, 60_000)

  it('with the worker\'s own check disabled, Seatbelt still refuses (EPERM)', async () => {
    await expect(bare.rawRequest('read', { path: join(outside, 'secret.txt') })).rejects.toThrow(/EPERM/)
    // and a read inside the grant still works in that worker
    expect((await bare.rawRequest('read', { path: join(grant, 'inside.txt') })).text).toContain('inside.txt')
  }, 60_000)

  it('S3: a symlink in the grant to outside — main and worker deny, and Seatbelt denies too', async () => {
    await expect(svc.run('list', { path: join(grant, 'link') }, { chatId: 'c' })).rejects.toThrow(/is not inside a granted folder/)
    await expect(svc.rawRequest('list', { path: join(grant, 'link') })).rejects.toThrow(/is not inside a granted folder/)
    await expect(bare.rawRequest('list', { path: join(grant, 'link') })).rejects.toThrow(/EPERM/)
  }, 60_000)

  it('Seatbelt refuses a write in a read-only grant', async () => {
    await expect(bare.rawRequest('write', { path: join(readonly, 'x.txt'), content: 'x' })).rejects.toThrow(/EPERM/)
  }, 60_000)

  it('S12: a catastrophic regex is killed at the timeout with its whole process tree; the next call works', async () => {
    writeFileSync(join(grant, 'evil.txt'), `${'a'.repeat(40)}!\n`)
    await svc.run('read', { path: join(grant, 'inside.txt') }, { chatId: 'c' })
    const worker = svcKids.at(-1)!
    const tree = [worker.pid!, ...descendants(worker.pid!)]
    await expect(svc.run('grep', { pattern: '(a+)+$', path: join(grant, 'evil.txt') }, { chatId: 'c' })).rejects.toThrow('The operation timed out.')
    await new Promise((r) => setTimeout(r, 1000))
    expect(tree.filter(alive)).toEqual([])
    expect((await svc.run('read', { path: join(grant, 'inside.txt') }, { chatId: 'c' })).text).toContain('edited')
  }, 90_000)
})
