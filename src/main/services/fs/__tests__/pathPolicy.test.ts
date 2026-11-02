import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveTarget,
  isInside,
  checkAccess,
  validateGrantRoot,
  realFsDeps,
  mergeGrants,
  describeGrants,
  type FsPolicyDeps,
  type FsGrant,
} from '../pathPolicy'
import { DEFAULT_BLOCKED_NAMES } from '../../../../shared/fsAccess'

const CRED = [
  '~/.ssh',
  '~/.aws',
  '~/.gitconfig',
  '~/Library/Keychains',
  '~/Library/Application Support/Google/Chrome/*/Cookies',
]
const BLOCKED = [...DEFAULT_BLOCKED_NAMES]

// ── Fake fs: a set of dirs and files plus symlinks, for layout-dependent rules ──
function fakeDeps(opts: {
  dirs: string[]
  files?: string[]
  links?: Record<string, string>
  homedir?: string
  userDataDir?: string
}): FsPolicyDeps {
  const dirs = new Set(opts.dirs)
  const files = new Set(opts.files ?? [])
  const links = opts.links ?? {}
  const err = (code: string): Error => Object.assign(new Error(code), { code })
  const realpath = (p: string): string => {
    const parts = p.split('/').filter(Boolean)
    let cur = ''
    for (let i = 0; i < parts.length; i++) {
      cur = `${cur}/${parts[i]}`
      if (links[cur]) cur = links[cur]
      const last = i === parts.length - 1
      if (!dirs.has(cur) && !(last && files.has(cur))) throw err(files.has(cur) ? 'ENOTDIR' : 'ENOENT')
    }
    return cur || '/'
  }
  return {
    realpath,
    lexists: (p) => dirs.has(p) || files.has(p) || p in links,
    isDirectory: (p) => {
      try {
        return dirs.has(realpath(p))
      } catch {
        return null
      }
    },
    homedir: opts.homedir ?? '/Users/u',
    userDataDir: opts.userDataDir ?? '/Users/u/Library/Application Support/Desktop Intelligence',
    credentialEntries: CRED,
  }
}

describe('isInside (containment by path.relative, never startsWith)', () => {
  it('root contains itself and its children', () => {
    expect(isInside('/a/foo', '/a/foo')).toBe(true)
    expect(isInside('/a/foo', '/a/foo/x')).toBe(true)
    expect(isInside('/a/foo', '/a/foo/x/y.ts')).toBe(true)
  })
  it('a sibling with the same prefix is outside', () => {
    expect(isInside('/a/foo', '/a/foobar')).toBe(false)
    expect(isInside('/a/foo', '/a')).toBe(false)
    expect(isInside('/a/foo', '/b')).toBe(false)
  })
  it('a child named "..x" is inside', () => {
    expect(isInside('/a/foo', '/a/foo/..x')).toBe(true)
  })
  it('the filesystem root contains everything', () => {
    expect(isInside('/', '/etc')).toBe(true)
  })
})

describe('resolveTarget — real temp folders and symlinks', () => {
  let base: string
  let home: string
  let deps: FsPolicyDeps
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'di-pp-')))
    home = join(base, 'home')
    mkdirSync(join(home, 'proj', 'src'), { recursive: true })
    mkdirSync(join(base, 'outside'), { recursive: true })
    writeFileSync(join(home, 'proj', 'src', 'app.ts'), 'x')
    writeFileSync(join(base, 'outside', 'secret.txt'), 's')
    deps = realFsDeps({ homedir: home, userDataDir: join(home, 'ud'), credentialEntries: CRED })
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('expands a leading ~ only', () => {
    expect(resolveTarget('~/proj/src/app.ts', deps)).toEqual({ ok: true, real: join(home, 'proj/src/app.ts'), exists: true })
    expect(resolveTarget('~', deps)).toEqual({ ok: true, real: home, exists: true })
    expect(resolveTarget(`${home}/proj/~x`, deps)).toEqual({ ok: true, real: join(home, 'proj/~x'), exists: false })
  })

  it('rejects relative paths, ~user and empty input', () => {
    const reason = 'Use an absolute path (for example /Users/you/project/src/app.ts).'
    expect(resolveTarget('proj/src', deps)).toEqual({ ok: false, reason })
    expect(resolveTarget('./x', deps)).toEqual({ ok: false, reason })
    expect(resolveTarget('~other/x', deps)).toEqual({ ok: false, reason })
    expect(resolveTarget('', deps)).toEqual({ ok: false, reason })
  })

  it('rejects a NUL byte', () => {
    expect(resolveTarget(`${home}/a\0b`, deps)).toEqual({ ok: false, reason: 'The path contains a NUL byte.' })
  })

  it('normalises .. segments', () => {
    expect(resolveTarget(`${home}/proj/src/../src/./app.ts`, deps)).toEqual({ ok: true, real: join(home, 'proj/src/app.ts'), exists: true })
    expect(resolveTarget(`${home}/proj/../../outside/secret.txt`, deps)).toEqual({ ok: true, real: join(base, 'outside/secret.txt'), exists: true })
  })

  it('resolves a missing target through its deepest existing ancestor', () => {
    expect(resolveTarget(`${home}/proj/src/new/deep/file.ts`, deps)).toEqual({ ok: true, real: join(home, 'proj/src/new/deep/file.ts'), exists: false })
  })

  it('resolves a missing target whose existing ancestor is a symlink', () => {
    symlinkSync(join(base, 'outside'), join(home, 'proj', 'out'))
    expect(resolveTarget(`${home}/proj/out/new.txt`, deps)).toEqual({ ok: true, real: join(base, 'outside/new.txt'), exists: false })
  })

  it('follows a symlink to its real target', () => {
    symlinkSync(join(base, 'outside', 'secret.txt'), join(home, 'proj', 'link'))
    expect(resolveTarget(`${home}/proj/link`, deps)).toEqual({ ok: true, real: join(base, 'outside/secret.txt'), exists: true })
  })

  it('rejects a path through a broken symlink (it could point anywhere once created)', () => {
    symlinkSync(join(base, 'outside', 'nope'), join(home, 'proj', 'dangling'))
    expect(resolveTarget(`${home}/proj/dangling`, deps)).toEqual({
      ok: false,
      reason: `${home}/proj/dangling is a broken symbolic link.`,
    })
    expect(resolveTarget(`${home}/proj/dangling/x`, deps)).toEqual({
      ok: false,
      reason: `${home}/proj/dangling is a broken symbolic link.`,
    })
  })

  it('treats a path under a file as missing (ENOTDIR) and resolves through the file', () => {
    expect(resolveTarget(`${home}/proj/src/app.ts/x`, deps)).toEqual({ ok: true, real: join(home, 'proj/src/app.ts/x'), exists: false })
  })

  it('gives the canonical case on a case-insensitive volume', () => {
    if (!existsSync(join(home, 'PROJ'))) {
      console.log('[pathPolicy.test] tmp volume is case-sensitive — canonical-case check skipped')
      return
    }
    expect(resolveTarget(`${home}/PROJ/SRC/APP.TS`, deps)).toEqual({ ok: true, real: join(home, 'proj/src/app.ts'), exists: true })
  })

  it('surfaces an unexpected realpath error as a plain reason', () => {
    const broken: FsPolicyDeps = {
      ...deps,
      realpath: () => {
        throw Object.assign(new Error('boom'), { code: 'EACCES' })
      },
    }
    expect(resolveTarget(`${home}/x`, broken)).toEqual({ ok: false, reason: `Cannot resolve ${home}/x (EACCES).` })
  })
})

describe('checkAccess — real symlinks', () => {
  let base: string
  let home: string
  let root: string
  let deps: FsPolicyDeps
  const grantsFor = (r: string, access: 'read' | 'write' = 'write'): FsGrant[] => [{ path: r, access, askBeforeEdit: true }]
  const resolve = (p: string): string => {
    const r = resolveTarget(p, deps)
    if (!r.ok) throw new Error(r.reason)
    return r.real
  }
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'di-ca-')))
    home = join(base, 'home')
    root = join(home, 'proj')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(home, 'Documents'), { recursive: true })
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'k')
    writeFileSync(join(home, 'Documents', 'd.txt'), 'd')
    deps = realFsDeps({ homedir: home, userDataDir: join(home, 'Library/Application Support/DI'), credentialEntries: CRED })
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('allows a file inside a grant and returns the governing grant', () => {
    expect(checkAccess(join(root, 'src/a.ts'), 'read', grantsFor(root), BLOCKED, deps)).toEqual({
      ok: true,
      grant: { path: root, access: 'write', askBeforeEdit: true },
    })
  })

  it('denies a symlink inside a root that points outside, listing roots', () => {
    symlinkSync(join(home, 'Documents'), join(root, 'link'))
    expect(checkAccess(resolve(`${root}/link`), 'read', grantsFor(root), BLOCKED, deps)).toEqual({
      ok: false,
      reason: `${home}/Documents is not inside a granted folder. Granted folders: ${root} (read and write). Call fs_request_access to ask for another folder.`,
    })
  })

  it('allows a symlink that points to another place inside the root', () => {
    symlinkSync(join(root, 'src'), join(root, 'srclink'))
    expect(checkAccess(resolve(`${root}/srclink/a.ts`), 'read', grantsFor(root), BLOCKED, deps).ok).toBe(true)
  })

  it('S2: <root>/../secret.txt normalises outside and is denied', () => {
    const r = checkAccess(resolve(`${root}/../secret.txt`), 'read', grantsFor(root), BLOCKED, deps)
    expect(r).toEqual({
      ok: false,
      reason: `${home}/secret.txt is not inside a granted folder. Granted folders: ${root} (read and write). Call fs_request_access to ask for another folder.`,
    })
  })

  it('says when no folder is granted yet', () => {
    expect(checkAccess(join(root, 'a'), 'read', [], BLOCKED, deps)).toEqual({
      ok: false,
      reason: `${root}/a is not inside a granted folder. No folders are granted yet. Call fs_request_access to ask for one.`,
    })
  })

  it('S1: credential paths are denied even inside a grant', () => {
    expect(checkAccess(join(home, '.ssh/id_rsa'), 'read', grantsFor(home), BLOCKED, deps)).toEqual({
      ok: false,
      reason: `${home}/.ssh/id_rsa is a credential path; access is always denied.`,
    })
    expect(checkAccess(join(home, '.gitconfig'), 'read', grantsFor(home), BLOCKED, deps).ok).toBe(false)
    const chrome = join(home, 'Library/Application Support/Google/Chrome/Default/Cookies')
    expect(checkAccess(chrome, 'read', grantsFor(home), BLOCKED, deps).ok).toBe(false)
  })

  it('S8: anything under userData is denied even inside a grant', () => {
    const settings = join(home, 'Library/Application Support/DI/app-settings.json')
    expect(checkAccess(settings, 'read', grantsFor(home), BLOCKED, deps)).toEqual({
      ok: false,
      reason: `${settings} is in Desktop Intelligence's own data folder; access is always denied.`,
    })
    expect(checkAccess(join(home, 'Library/Application Support/DI'), 'read', grantsFor(home), BLOCKED, deps).ok).toBe(false)
  })

  it('S7: blocked names at any segment, exact segment glob', () => {
    const deny = (p: string): string => (checkAccess(join(root, p), 'read', grantsFor(root), BLOCKED, deps) as { reason: string }).reason
    expect(deny('.env')).toBe(`${root}/.env matches the blocked file name ".env"; access is always denied.`)
    expect(deny('config/.env.production')).toBe(`${root}/config/.env.production matches the blocked file name ".env.*"; access is always denied.`)
    expect(deny('certs/server.pem')).toBe(`${root}/certs/server.pem matches the blocked file name "*.pem"; access is always denied.`)
    expect(deny('.env/inner.txt')).toBe(`${root}/.env/inner.txt matches the blocked file name ".env"; access is always denied.`)
    expect(checkAccess(join(root, '.envrc'), 'read', grantsFor(root), BLOCKED, deps).ok).toBe(true)
  })

  it('checks blocked names only below the root, so a root path itself never trips them', () => {
    const odd = join(home, 'keys.key')
    expect(checkAccess(join(odd, 'a.txt'), 'read', grantsFor(odd), BLOCKED, deps).ok).toBe(true)
  })

  it('S5: write needs a write grant', () => {
    expect(checkAccess(join(root, 'a.ts'), 'write', grantsFor(root, 'read'), BLOCKED, deps)).toEqual({
      ok: false,
      reason: `${root}/a.ts is in a read-only folder (${root}). Editing needs read and write access: call fs_request_access with access "write".`,
    })
    expect(checkAccess(join(root, 'a.ts'), 'write', grantsFor(root, 'write'), BLOCKED, deps).ok).toBe(true)
  })

  it('overlapping grants: the most permissive wins', () => {
    const grants: FsGrant[] = [
      { path: root, access: 'read', askBeforeEdit: true },
      { path: join(root, 'src'), access: 'write', askBeforeEdit: true },
      { path: join(root, 'src'), access: 'write', askBeforeEdit: false },
    ]
    expect(checkAccess(join(root, 'src/a.ts'), 'write', grants, BLOCKED, deps)).toEqual({
      ok: true,
      grant: { path: join(root, 'src'), access: 'write', askBeforeEdit: false },
    })
    expect(checkAccess(join(root, 'b.ts'), 'write', grants, BLOCKED, deps).ok).toBe(false)
    expect(checkAccess(join(root, 'b.ts'), 'read', grants, BLOCKED, deps)).toEqual({
      ok: true,
      grant: { path: root, access: 'read', askBeforeEdit: true },
    })
  })

  it('S8b: a folder holding DI\'s own source is like any other folder', () => {
    const repo = join(home, 'desktop-intelligence')
    mkdirSync(repo)
    writeFileSync(join(repo, 'package.json'), '{"name":"desktop-intelligence"}')
    expect(checkAccess(join(repo, 'package.json'), 'write', grantsFor(repo), BLOCKED, deps).ok).toBe(true)
    expect(checkAccess(join(repo, 'package.json'), 'read', [], BLOCKED, deps).ok).toBe(false)
  })
})

describe('validateGrantRoot', () => {
  const deps = fakeDeps({
    dirs: [
      '/',
      '/Users',
      '/Users/u',
      '/Users/u/projects',
      '/Users/u/projects/foo',
      '/Users/u/projects/foo/.aws-not',
      '/Users/u/desktop-intelligence',
      '/Users/u/.ssh',
      '/Users/u/work',
      '/Users/u/work/.aws',
      '/Users/u/Library',
      '/Users/u/Library/Application Support',
      '/Users/u/Library/Application Support/Desktop Intelligence',
      '/Users/u/Library/Application Support/Desktop Intelligence/logs',
      '/System',
      '/System/x',
      '/private',
      '/private/etc',
      '/opt',
      '/opt/homebrew',
      '/Volumes',
      '/Volumes/Ext',
      '/Volumes/Ext/code',
    ],
    files: ['/Users/u/projects/foo/a.txt', '/Users/u/desktop-intelligence/package.json'],
  })
  const reason = (p: string): string | undefined => {
    const r = validateGrantRoot(p, deps)
    return r.ok ? undefined : r.reason
  }

  it('accepts a project folder, one holding DI\'s own source, and an external volume', () => {
    expect(validateGrantRoot('/Users/u/projects/foo', deps)).toEqual({ ok: true })
    expect(validateGrantRoot('/Users/u/desktop-intelligence', deps)).toEqual({ ok: true })
    expect(validateGrantRoot('/Volumes/Ext/code', deps)).toEqual({ ok: true })
  })

  it('rejects / and the home folder and its ancestors', () => {
    expect(reason('/')).toBe('/ is the whole disk. Choose a specific project folder.')
    expect(reason('/Users/u')).toBe('/Users/u is your home folder. Choose a specific project folder inside it.')
    expect(reason('/Users')).toBe('/Users contains your home folder. Choose a specific project folder inside your home folder.')
  })

  it('rejects system folders', () => {
    expect(reason('/System/x')).toBe('/System/x is a system folder. Choose a project folder.')
    expect(reason('/private/etc')).toBe('/private/etc is a system folder. Choose a project folder.')
    expect(reason('/opt/homebrew')).toBe('/opt/homebrew is a system folder. Choose a project folder.')
  })

  it('rejects DI\'s data folder and anything inside it', () => {
    const ud = '/Users/u/Library/Application Support/Desktop Intelligence'
    expect(reason(ud)).toBe(`${ud} holds Desktop Intelligence's own data. Choose a project folder.`)
    expect(reason(`${ud}/logs`)).toBe(`${ud}/logs holds Desktop Intelligence's own data. Choose a project folder.`)
  })

  it('rejects a credential folder, and a folder containing one', () => {
    expect(reason('/Users/u/.ssh')).toBe('/Users/u/.ssh is or contains a credential path (/Users/u/.ssh). Choose a folder without credentials.')
    expect(reason('/Users/u/work')).toBe('/Users/u/work is or contains a credential path (/Users/u/work/.aws). Choose a folder without credentials.')
    expect(reason('/Users/u/Library')).toBe("/Users/u/Library contains Desktop Intelligence's own data. Choose a project folder.")
  })

  it('rejects a folder containing the Chrome cookie glob prefix', () => {
    expect(reason('/Users/u/Library/Application Support')).toBe(
      '/Users/u/Library/Application Support contains Desktop Intelligence\'s own data. Choose a project folder.'
    )
  })

  it('rejects files and missing paths', () => {
    expect(reason('/Users/u/projects/foo/a.txt')).toBe('/Users/u/projects/foo/a.txt is a file, not a folder.')
    expect(reason('/Users/u/projects/nope')).toBe('/Users/u/projects/nope does not exist.')
  })
})

describe('validateGrantRoot — credential glob prefix', () => {
  it('rejects a folder that contains a glob entry\'s fixed prefix', () => {
    const deps = fakeDeps({
      dirs: ['/', '/Users', '/Users/u', '/Users/u/Library', '/Users/u/Library/Application Support', '/Users/u/Library/Application Support/Google'],
      userDataDir: '/Users/u/elsewhere/DI',
    })
    expect(validateGrantRoot('/Users/u/Library/Application Support/Google', deps)).toEqual({
      ok: false,
      reason:
        '/Users/u/Library/Application Support/Google is or contains a credential path (/Users/u/Library/Application Support/Google/Chrome). Choose a folder without credentials.',
    })
    expect(validateGrantRoot('/Users/u/Library', deps)).toEqual({
      ok: false,
      reason: '/Users/u/Library is or contains a credential path (/Users/u/Library/Keychains). Choose a folder without credentials.',
    })
  })
})

describe('mergeGrants and describeGrants', () => {
  it('dedupes by path keeping the most permissive access and the least asking', () => {
    expect(
      mergeGrants(
        [{ path: '/a', access: 'read', askBeforeEdit: true }],
        [
          { path: '/a', access: 'write', askBeforeEdit: true },
          { path: '/b', access: 'read', askBeforeEdit: true },
        ],
        [{ path: '/a', access: 'write', askBeforeEdit: false }]
      )
    ).toEqual([
      { path: '/a', access: 'write', askBeforeEdit: false },
      { path: '/b', access: 'read', askBeforeEdit: true },
    ])
  })
  it('describes grants for messages and prompts', () => {
    expect(describeGrants([{ path: '/a', access: 'write', askBeforeEdit: true }, { path: '/b', access: 'read', askBeforeEdit: true }])).toBe(
      '/a (read and write), /b (read-only)'
    )
    expect(describeGrants([])).toBe('none yet')
  })
})

describe('realFsDeps', () => {
  it('reports missing and non-folder paths, and paths under a file, without throwing', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'di-rfd-')))
    writeFileSync(join(base, 'f'), 'x')
    const d = realFsDeps({ homedir: join(base, 'nohome'), userDataDir: join(base, 'noud'), credentialEntries: [] })
    expect(d.homedir).toBe(join(base, 'nohome'))
    expect(d.isDirectory(base)).toBe(true)
    expect(d.isDirectory(join(base, 'f'))).toBe(false)
    expect(d.isDirectory(join(base, 'missing'))).toBeNull()
    expect(d.isDirectory(join(base, 'f', 'x'))).toBeNull()
    expect(d.lexists(join(base, 'f'))).toBe(true)
    expect(d.lexists(join(base, 'f', 'x'))).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })
})

describe('pathPolicy — more branches', () => {
  const fake = (realpath: (p: string) => string): FsPolicyDeps => ({
    realpath,
    lexists: () => false,
    isDirectory: () => null,
    homedir: '/Users/u',
    userDataDir: '/Users/u/ud',
    credentialEntries: [],
  })
  it('an error without a code, and a path whose every ancestor is missing', () => {
    expect(resolveTarget('/a/b', fake(() => { throw new Error('odd') }))).toEqual({ ok: false, reason: 'Cannot resolve /a/b (unknown error).' })
    expect(resolveTarget('/a/b', fake(() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }))).toEqual({ ok: false, reason: 'Cannot resolve /a/b (ENOENT).' })
  })
  it('mergeGrants keeps read when both are read', () => {
    expect(mergeGrants([{ path: '/a', access: 'read', askBeforeEdit: true }], [{ path: '/a', access: 'read', askBeforeEdit: true }])).toEqual([
      { path: '/a', access: 'read', askBeforeEdit: true },
    ])
  })
  it('keeps working past the blocked-name matcher cache size', () => {
    const d = fake((p) => p)
    for (let i = 0; i < 25; i++) {
      expect(checkAccess('/r/x', 'read', [{ path: '/r', access: 'read', askBeforeEdit: true }], [`n${i}`], d).ok).toBe(true)
    }
    expect(checkAccess('/r/n3', 'read', [{ path: '/r', access: 'read', askBeforeEdit: true }], ['n3'], d).ok).toBe(false)
  })
  it('a credential entry outside home is only checked as itself', () => {
    const d = { ...fake((p) => p), credentialEntries: ['/etc/secret'], isDirectory: () => true }
    expect(validateGrantRoot('/Volumes/x/y', d)).toEqual({ ok: true })
    expect(validateGrantRoot('/Volumes/etc', { ...d, credentialEntries: ['/Volumes/etc/k'] })).toEqual({
      ok: false,
      reason: '/Volumes/etc is or contains a credential path (/Volumes/etc/k). Choose a folder without credentials.',
    })
  })
})

describe('denials never reveal what a path resolves to outside the grants', () => {
  it('a symlink outside every grant: the message names only the given path and the granted folders', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'di-leak-')))
    const home = join(base, 'home')
    const granted = join(home, 'proj')
    const secretDir = join(home, 'private-notes', 'tax-2026')
    mkdirSync(granted, { recursive: true })
    mkdirSync(secretDir, { recursive: true })
    writeFileSync(join(secretDir, 'return.pdf'), 'x')
    mkdirSync(join(home, 'elsewhere'))
    symlinkSync(join(secretDir, 'return.pdf'), join(home, 'elsewhere', 'link'))
    const deps = realFsDeps({ homedir: home, userDataDir: join(base, 'ud'), credentialEntries: CRED })
    const given = join(home, 'elsewhere', 'link')
    const r = resolveTarget(given, deps)
    if (!r.ok) throw new Error(r.reason)
    const v = checkAccess(r.real, 'read', [{ path: granted, access: 'read', askBeforeEdit: true }], BLOCKED, deps, given)
    expect(v).toEqual({
      ok: false,
      reason: `${given} is not inside a granted folder. Granted folders: ${granted} (read-only). Call fs_request_access to ask for another folder.`,
    })
    expect((v as { reason: string }).reason).not.toContain('private-notes')
    rmSync(base, { recursive: true, force: true })
  })

  it('a symlink to a credential file: the message does not reveal the target', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'di-leak-')))
    const home = join(base, 'home')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'k')
    mkdirSync(join(home, 'proj'))
    symlinkSync(join(home, '.ssh', 'id_rsa'), join(home, 'proj', 'key'))
    const deps = realFsDeps({ homedir: home, userDataDir: join(base, 'ud'), credentialEntries: CRED })
    const given = join(home, 'proj', 'key')
    const r = resolveTarget(given, deps) as { real: string }
    const v = checkAccess(r.real, 'read', [{ path: join(home, 'proj'), access: 'read', askBeforeEdit: true }], BLOCKED, deps, given)
    expect(v).toEqual({ ok: false, reason: `${given} is a credential path; access is always denied.` })
    rmSync(base, { recursive: true, force: true })
  })

  it('within a grant, messages and the governing grant are unchanged', () => {
    const deps = { ...realFsDeps({ homedir: '/Users/u', userDataDir: '/Users/u/ud', credentialEntries: [] }) }
    expect(checkAccess('/r/a.ts', 'write', [{ path: '/r', access: 'read', askBeforeEdit: true }], BLOCKED, deps, '/given/a.ts')).toEqual({
      ok: false,
      reason: '/r/a.ts is in a read-only folder (/r). Editing needs read and write access: call fs_request_access with access "write".',
    })
  })
})
