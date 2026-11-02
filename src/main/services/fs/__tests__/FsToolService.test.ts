import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { quote } from 'shell-quote'
import { FsToolService, FS_UNAVAILABLE, FsToolError, computeAppCodeDirs } from '../FsToolService'
import { FsGrantStore } from '../FsGrantStore'
import { FsReadLedger } from '../FsReadLedger'
import { realFsDeps } from '../pathPolicy'
import { defaultFsAccessSettings, type FsAccessSettings } from '../../../../shared/fsAccess'
import type { SandboxRunSpec } from '../../sandbox/types'

const REPO = resolve(__dirname, '../../../../..')
const WORKER = resolve(__dirname, '../fsWorker.ts')

let base: string
let root: string
let ro: string
let settings: FsAccessSettings
let ready: boolean
let specs: SandboxRunSpec[]
let children: ChildProcessWithoutNullStreams[]
let grants: FsGrantStore
let ledger: FsReadLedger
let svc: FsToolService

// Fake spawner: the real worker over NDJSON, without the OS sandbox.
async function fakeSpawn(spec: SandboxRunSpec): Promise<ChildProcessWithoutNullStreams> {
  specs.push(spec)
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER], { cwd: REPO, env: { ...process.env, ...spec.env } })
  children.push(child)
  return child
}

function make(opts: { grep?: number; def?: number } = {}): FsToolService {
  svc = new FsToolService({
    spawn: fakeSpawn,
    sandboxReady: () => ready,
    getSettings: () => settings,
    grants,
    ledger,
    policyDeps: realFsDeps({ homedir: join(base, 'home'), userDataDir: join(base, 'ud'), credentialEntries: ['~/.ssh'] }),
    userDataDir: join(base, 'ud'),
    worker: { args: ['--import', 'tsx', WORKER], codeDirs: [join(base, 'code')] },
    execPath: '/x/Electron',
    timeouts: { default: opts.def ?? 15_000, grep: opts.grep ?? 30_000, ready: 15_000 },
  })
  return svc
}

const ctx = { chatId: 'c1' }
const failMessage = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(FsToolError)
    return (e as Error).message
  }
  throw new Error('expected FsToolError')
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'di-fts-')))
  root = join(base, 'root')
  ro = join(base, 'ro')
  mkdirSync(root)
  mkdirSync(ro)
  writeFileSync(join(root, 'a.txt'), 'alpha\n')
  settings = {
    ...defaultFsAccessSettings(),
    roots: [
      { path: root, access: 'write', askBeforeEdit: false, addedAt: 1 },
      { path: ro, access: 'read', askBeforeEdit: true, addedAt: 1 },
    ],
  }
  ready = true
  specs = []
  children = []
  grants = new FsGrantStore()
  ledger = new FsReadLedger()
})
afterEach(async () => {
  await svc?.shutdown()
  for (const c of children) c.kill('SIGKILL')
  rmSync(base, { recursive: true, force: true })
})

describe('FsToolService — fail closed', () => {
  it('S13: refuses every call when the sandbox is not ready, without spawning', async () => {
    ready = false
    expect(await failMessage(make().run('read', { path: join(root, 'a.txt') }, ctx))).toBe(FS_UNAVAILABLE)
    expect(FS_UNAVAILABLE).toBe('File access is unavailable: the tool sandbox is not running.')
    expect(specs).toHaveLength(0)
    expect(svc.isAvailable()).toBe(false)
  })

  it('refuses when file access is turned off in Settings', async () => {
    settings.enabled = false
    expect(await failMessage(make().run('read', { path: join(root, 'a.txt') }, ctx))).toBe('File access is turned off in Settings → File System Access.')
    expect(specs).toHaveLength(0)
  })

  it('applies the main-process policy for the chat before reaching the worker', async () => {
    const outside = join(base, 'x.txt')
    expect(await failMessage(make().run('read', { path: outside }, ctx))).toMatch(/is not inside a granted folder/)
    expect(specs).toHaveLength(0)
  })

  it('a chat cannot use another chat\'s grant (per-chat separation in main)', async () => {
    const other = join(base, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'o.txt'), 'o')
    grants.addGrant('c2', other, 'read')
    expect(await failMessage(make().run('read', { path: join(other, 'o.txt') }, ctx))).toMatch(/is not inside a granted folder/)
  })
})

describe('FsToolService — worker', () => {
  it('spawns the worker with the spec the sandbox needs', async () => {
    const r = await make().run('read', { path: join(root, 'a.txt') }, ctx)
    expect(r.text).toContain('     1\talpha')
    expect(specs).toHaveLength(1)
    const s = specs[0]
    const workspace = join(base, 'ud', 'sandboxes', 'fs-worker')
    expect(s.command).toBe(quote(['/x/Electron', '--import', 'tsx', WORKER]))
    expect(s.executionProfile).toBe('lightweight')
    expect(s.allowedDomains).toEqual([])
    expect(s.denyRead).toEqual([join(base, 'home')])
    expect(s.allowRead).toEqual([root, ro, join(base, 'code'), workspace])
    expect(s.allowWrite).toEqual([root])
    expect(s.workspaceDir).toBe(workspace)
    expect(s.timeoutMs).toBe(0)
    expect(s.maxRssMb).toBe(512)
    expect(s.callerLabel).toBe('fs-worker')
    expect(s.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(s.env?.TMPDIR).toBe(workspace)
    expect(JSON.parse(s.env!.DI_FS_POLICY)).toEqual({
      grants: [
        { path: root, access: 'write', askBeforeEdit: false },
        { path: ro, access: 'read', askBeforeEdit: true },
      ],
      blockedNames: settings.blockedNames,
      homedir: join(base, 'home'),
      userDataDir: join(base, 'ud'),
      credentialEntries: ['~/.ssh'],
    })
  })

  it('records reads in the ledger so an edit can follow; an unread edit is refused', async () => {
    make()
    const p = join(root, 'a.txt')
    expect(await failMessage(svc.run('edit', { path: p, old_string: 'alpha', new_string: 'beta' }, ctx))).toBe('Read the file with fs_read before editing it.')
    await svc.run('read', { path: p }, ctx)
    expect(ledger.get('c1', p)?.size).toBe(6)
    const e = await svc.run('edit', { path: p, old_string: 'alpha', new_string: 'beta' }, ctx)
    expect(e.text.split('\n')[0]).toBe(`Edited ${p}: replaced 1 occurrence (line 1).`)
    expect(readFileSync(p, 'utf8')).toBe('beta\n')
    // the ledger follows the write, so a second edit needs no new read
    await svc.run('edit', { path: p, old_string: 'beta', new_string: 'gamma' }, ctx)
    expect(readFileSync(p, 'utf8')).toBe('gamma\n')
    // another chat has not read it
    expect(await failMessage(svc.run('edit', { path: p, old_string: 'gamma', new_string: 'x' }, { chatId: 'c2' }))).toBe('Read the file with fs_read before editing it.')
  })

  it('serves concurrent calls one at a time on one worker', async () => {
    make()
    writeFileSync(join(root, 'b.txt'), 'bravo\n')
    const [a, b] = await Promise.all([svc.run('read', { path: join(root, 'a.txt') }, ctx), svc.run('read', { path: join(root, 'b.txt') }, ctx)])
    expect(a.text).toContain('alpha')
    expect(b.text).toContain('bravo')
    expect(specs).toHaveLength(1)
  })

  it('S12: kills a runaway grep at the timeout, restarts the worker and serves the next call', async () => {
    make({ grep: 1500 })
    writeFileSync(join(root, 'evil.txt'), `${'a'.repeat(40)}!\n`)
    expect(await failMessage(svc.run('grep', { pattern: '(a+)+$', path: join(root, 'evil.txt') }, ctx))).toBe('The operation timed out.')
    const r = await svc.run('read', { path: join(root, 'a.txt') }, ctx)
    expect(r.text).toContain('alpha')
    expect(specs).toHaveLength(2)
  }, 20_000)

  it('restarts the worker when the grant union changes, not otherwise', async () => {
    make()
    await svc.run('read', { path: join(root, 'a.txt') }, ctx)
    await svc.run('read', { path: join(root, 'a.txt') }, ctx)
    expect(specs).toHaveLength(1)
    const extra = join(base, 'extra')
    mkdirSync(extra)
    writeFileSync(join(extra, 'e.txt'), 'echo\n')
    grants.addGrant('c1', extra, 'read')
    expect((await svc.run('read', { path: join(extra, 'e.txt') }, ctx)).text).toContain('echo')
    expect(specs).toHaveLength(2)
    expect(specs[1].allowRead).toContain(extra)
    settings = { ...settings, blockedNames: ['*.zzz'] }
    await svc.run('read', { path: join(root, 'a.txt') }, ctx)
    expect(specs).toHaveLength(3)
  })

  it('cancels an in-flight call when the signal aborts, and recovers', async () => {
    make({ grep: 30_000 })
    writeFileSync(join(root, 'evil.txt'), `${'a'.repeat(40)}!\n`)
    const ac = new AbortController()
    const p = svc.run('grep', { pattern: '(a+)+$', path: join(root, 'evil.txt') }, { chatId: 'c1', signal: ac.signal })
    setTimeout(() => ac.abort(), 300)
    expect(await failMessage(p)).toBe('The operation was cancelled.')
    expect((await svc.run('read', { path: join(root, 'a.txt') }, ctx)).text).toContain('alpha')
    expect(specs).toHaveLength(2)
  }, 20_000)

  it('refuses at once when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await failMessage(make().run('read', { path: join(root, 'a.txt') }, { chatId: 'c1', signal: ac.signal }))).toBe('The operation was cancelled.')
  })

  it('reports a worker that dies mid-call, then restarts it', async () => {
    make({ grep: 30_000 })
    writeFileSync(join(root, 'evil.txt'), `${'a'.repeat(40)}!\n`)
    const p = svc.run('grep', { pattern: '(a+)+$', path: join(root, 'evil.txt') }, ctx)
    setTimeout(() => children[0].kill('SIGKILL'), 300)
    expect(await failMessage(p)).toBe('The file worker stopped unexpectedly. Try again.')
    expect((await svc.run('read', { path: join(root, 'a.txt') }, ctx)).text).toContain('alpha')
  }, 20_000)

  it('passes maxChars to fs_read', async () => {
    make()
    writeFileSync(join(root, 'long.txt'), 'x'.repeat(60) + '\n' + 'y'.repeat(60) + '\n' + 'z\n')
    const r = await svc.run('read', { path: join(root, 'long.txt') }, { chatId: 'c1', maxChars: 300 })
    expect(r.text.length).toBeLessThanOrEqual(300)
    expect(r.text).toContain('Continue with offset=')
  })

  it('rawRequest goes straight to the worker, whose own check still refuses paths outside the union', async () => {
    make()
    writeFileSync(join(base, 'secret.txt'), 's')
    await expect(svc.rawRequest('read', { path: join(base, 'secret.txt') })).rejects.toThrow(/is not inside a granted folder/)
  })
})

describe('computeAppCodeDirs (Phase 0 measurement)', () => {
  const home = '/Users/u'
  it('dev: the Electron.app bundle, the worker folder and the repo package.json', () => {
    const exists = (p: string): boolean => p === '/Users/u/repo/package.json'
    expect(
      computeAppCodeDirs('/Users/u/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', '/Users/u/repo/out/main/fsWorker.js', home, exists)
    ).toEqual(['/Users/u/repo/node_modules/electron/dist/Electron.app', '/Users/u/repo/out/main', '/Users/u/repo/package.json'])
  })
  it('packaged in /Applications: nothing under home is needed', () => {
    const exists = (p: string): boolean => p.endsWith('app.asar/package.json')
    expect(
      computeAppCodeDirs(
        '/Applications/Desktop Intelligence.app/Contents/MacOS/Desktop Intelligence',
        '/Applications/Desktop Intelligence.app/Contents/Resources/app.asar/out/main/fsWorker.js',
        home,
        exists
      )
    ).toEqual([])
  })
  it('a plain binary under home is kept as itself', () => {
    expect(computeAppCodeDirs('/Users/u/.nvm/bin/node', '/opt/w/fsWorker.js', home, () => false)).toEqual(['/Users/u/.nvm/bin/node'])
  })
})
