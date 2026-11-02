// Path policy for built-in file access — the one choke point for every path
// decision (specs/builtin-file-system-access.md section 2.3). Pure apart from
// the injected realpath / lstat / stat, and free of Electron imports so the
// sandboxed fs worker runs the exact same checks (defence in depth).

import { isAbsolute, join, normalize, relative, dirname, basename, sep } from 'path'
import { realpathSync, lstatSync, statSync } from 'fs'
import { blockedNameMatcher, describeAccess, type FsAccessLevel } from '../../../shared/fsAccess'
import { matchCredentialPath, credentialPrefixes } from '../../../shared/credentialPathMatch'

export interface FsGrant {
  path: string
  access: FsAccessLevel
  askBeforeEdit: boolean
}

export interface FsPolicyDeps {
  /** fs.realpathSync.native semantics: throws with .code on failure. */
  realpath(p: string): string
  /** True when an entry exists at p without following a final symlink. */
  lexists(p: string): boolean
  /** true / false for an existing directory / non-directory; null when missing. */
  isDirectory(p: string): boolean | null
  /** Real (symlink-resolved) home folder. */
  homedir: string
  /** Real path of DI's own data folder (app.getPath('userData')). */
  userDataDir: string
  /** BASELINE_DENY_READ entries (tilde-relative or absolute). */
  credentialEntries: readonly string[]
}

export type Resolved = { ok: true; real: string; exists: boolean } | { ok: false; reason: string }
export type Verdict<T = object> = ({ ok: true } & T) | { ok: false; reason: string }

const ABSOLUTE_HINT = 'Use an absolute path (for example /Users/you/project/src/app.ts).'
const SYSTEM_DIRS = ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private', '/var', '/cores', '/opt']

export function realFsDeps(opts: { homedir: string; userDataDir: string; credentialEntries: readonly string[] }): FsPolicyDeps {
  const canon = (p: string): string => {
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  return {
    realpath: (p) => realpathSync.native(p),
    lexists: (p) => {
      try {
        return lstatSync(p, { throwIfNoEntry: false }) !== undefined
      } catch {
        return false
      }
    },
    isDirectory: (p) => {
      try {
        const st = statSync(p, { throwIfNoEntry: false })
        return st ? st.isDirectory() : null
      } catch {
        return null
      }
    },
    homedir: canon(opts.homedir),
    userDataDir: canon(opts.userDataDir),
    credentialEntries: opts.credentialEntries,
  }
}

/** Containment by path.relative — never startsWith ("/a/foobar" is not in "/a/foo"). */
export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/**
 * Expand a leading "~", require an absolute path, normalise, and resolve
 * symlinks (realpath on the path, or on its deepest existing ancestor with
 * the missing segments appended). Defeats symlink and ".." escapes and gives
 * the canonical case on case-insensitive APFS.
 */
export function resolveTarget(input: string, deps: FsPolicyDeps): Resolved {
  if (typeof input !== 'string' || input === '') return { ok: false, reason: ABSOLUTE_HINT }
  if (input.includes('\0')) return { ok: false, reason: 'The path contains a NUL byte.' }
  let p = input === '~' || input.startsWith('~/') ? deps.homedir + input.slice(1) : input
  if (!isAbsolute(p)) return { ok: false, reason: ABSOLUTE_HINT }
  p = normalize(p)
  if (p.length > 1) p = p.replace(/\/+$/, '')

  let cur = p
  const missing: string[] = []
  for (;;) {
    try {
      const real = deps.realpath(cur)
      return missing.length === 0
        ? { ok: true, real, exists: true }
        : { ok: true, real: join(real, ...missing.reverse()), exists: false }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown error'
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { ok: false, reason: `Cannot resolve ${p} (${code}).` }
      // realpath fails but the entry itself exists → a symlink to nowhere.
      if (code === 'ENOENT' && deps.lexists(cur)) return { ok: false, reason: `${cur} is a broken symbolic link.` }
      const parent = dirname(cur)
      if (parent === cur) return { ok: false, reason: `Cannot resolve ${p} (${code}).` }
      missing.push(basename(cur))
      cur = parent
    }
  }
}

export function describeGrants(grants: FsGrant[]): string {
  return grants.length === 0 ? 'none yet' : grants.map((g) => `${g.path} (${describeAccess(g.access)})`).join(', ')
}

/** Union of grant lists, one entry per path: most permissive access, least asking. */
export function mergeGrants(...lists: FsGrant[][]): FsGrant[] {
  const byPath = new Map<string, FsGrant>()
  for (const g of lists.flat()) {
    const prev = byPath.get(g.path)
    if (!prev) byPath.set(g.path, { path: g.path, access: g.access, askBeforeEdit: g.askBeforeEdit })
    else {
      prev.access = prev.access === 'write' || g.access === 'write' ? 'write' : 'read'
      prev.askBeforeEdit = prev.askBeforeEdit && g.askBeforeEdit
    }
  }
  return [...byPath.values()]
}

const matcherCache = new Map<string, (segment: string) => string | null>()
function matcherFor(patterns: string[]): (segment: string) => string | null {
  const key = JSON.stringify(patterns)
  let m = matcherCache.get(key)
  if (!m) {
    m = blockedNameMatcher(patterns)
    if (matcherCache.size > 20) matcherCache.clear()
    matcherCache.set(key, m)
  }
  return m
}

const deeper = (a: FsGrant, b: FsGrant): FsGrant => (b.path.length > a.path.length ? b : a)

/**
 * Decide whether `real` (already resolved) may be read or written under
 * `grants`. Credential paths, DI's data folder and blocked names are denied
 * whatever the grants. Returns the governing grant (most permissive).
 */
export function checkAccess(
  real: string,
  op: FsAccessLevel,
  grants: FsGrant[],
  blockedNames: string[],
  deps: FsPolicyDeps
): Verdict<{ grant: FsGrant }> {
  if (matchCredentialPath(real, deps.credentialEntries, deps.homedir)) {
    return { ok: false, reason: `${real} is a credential path; access is always denied.` }
  }
  if (isInside(deps.userDataDir, real)) {
    return { ok: false, reason: `${real} is in Desktop Intelligence's own data folder; access is always denied.` }
  }
  const containing = grants.filter((g) => isInside(g.path, real))
  if (containing.length === 0) {
    return {
      ok: false,
      reason:
        grants.length === 0
          ? `${real} is not inside a granted folder. No folders are granted yet. Call fs_request_access to ask for one.`
          : `${real} is not inside a granted folder. Granted folders: ${describeGrants(grants)}. Call fs_request_access to ask for another folder.`,
    }
  }
  // Blocked names apply below the root: a granted folder's own path never trips them.
  const innermost = containing.reduce(deeper)
  const match = matcherFor(blockedNames)
  for (const segment of relative(innermost.path, real).split(sep).filter(Boolean)) {
    const pattern = match(segment)
    if (pattern) return { ok: false, reason: `${real} matches the blocked file name "${pattern}"; access is always denied.` }
  }
  const writers = containing.filter((g) => g.access === 'write')
  if (op === 'write' && writers.length === 0) {
    return {
      ok: false,
      reason: `${real} is in a read-only folder (${innermost.path}). Editing needs read and write access: call fs_request_access with access "write".`,
    }
  }
  const grant =
    writers.find((g) => !g.askBeforeEdit) ?? (writers.length ? writers.reduce(deeper) : containing.reduce(deeper))
  return { ok: true, grant }
}

/** May `real` become a root (Settings or an approved request)? */
export function validateGrantRoot(real: string, deps: FsPolicyDeps): Verdict {
  const no = (reason: string): Verdict => ({ ok: false, reason })
  if (real === '/') return no('/ is the whole disk. Choose a specific project folder.')
  if (real === deps.homedir) return no(`${real} is your home folder. Choose a specific project folder inside it.`)
  if (isInside(real, deps.homedir)) {
    return no(`${real} contains your home folder. Choose a specific project folder inside your home folder.`)
  }
  if (SYSTEM_DIRS.some((d) => isInside(d, real))) return no(`${real} is a system folder. Choose a project folder.`)
  if (isInside(deps.userDataDir, real)) return no(`${real} holds Desktop Intelligence's own data. Choose a project folder.`)
  if (isInside(real, deps.userDataDir)) return no(`${real} contains Desktop Intelligence's own data. Choose a project folder.`)
  for (const prefix of credentialPrefixes(deps.credentialEntries, deps.homedir)) {
    // The entry itself, inside or around the root…
    if (isInside(real, prefix) || isInside(prefix, real)) {
      return no(`${real} is or contains a credential path (${prefix}). Choose a folder without credentials.`)
    }
    // …or the same home-relative entry under the root (a copied ~/.aws, a dotfiles checkout).
    if (isInside(deps.homedir, prefix)) {
      const mirrored = join(real, relative(deps.homedir, prefix))
      if (deps.lexists(mirrored)) {
        return no(`${real} is or contains a credential path (${mirrored}). Choose a folder without credentials.`)
      }
    }
  }
  const dir = deps.isDirectory(real)
  if (dir === null) return no(`${real} does not exist.`)
  if (!dir) return no(`${real} is a file, not a folder.`)
  return { ok: true }
}
