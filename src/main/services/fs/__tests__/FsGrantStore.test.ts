import { describe, it, expect, vi } from 'vitest'
import { FsGrantStore } from '../FsGrantStore'
import { FsReadLedger } from '../FsReadLedger'

describe('FsGrantStore — chat grants', () => {
  it('adds a grant per chat with askBeforeEdit always true', () => {
    const s = new FsGrantStore(() => 100)
    s.addGrant('c1', '/Users/u/a', 'read')
    expect(s.getGrants('c1')).toEqual([{ path: '/Users/u/a', access: 'read', askBeforeEdit: true }])
    expect(s.getGrants('c2')).toEqual([])
  })

  it('upgrades an existing grant to write, never downgrades', () => {
    const s = new FsGrantStore(() => 1)
    s.addGrant('c1', '/a', 'read')
    s.addGrant('c1', '/a', 'write')
    s.addGrant('c1', '/a', 'read')
    expect(s.getGrants('c1')).toEqual([{ path: '/a', access: 'write', askBeforeEdit: true }])
  })

  it('lists every chat grant with its time, and revokes one', () => {
    const s = new FsGrantStore(() => 7)
    s.addGrant('c1', '/a', 'read')
    s.addGrant('c2', '/b', 'write')
    expect(s.listAll()).toEqual([
      { chatId: 'c1', path: '/a', access: 'read', addedAt: 7 },
      { chatId: 'c2', path: '/b', access: 'write', addedAt: 7 },
    ])
    expect(s.revoke('c1', '/a')).toBe(true)
    expect(s.revoke('c1', '/a')).toBe(false)
    expect(s.listAll()).toEqual([{ chatId: 'c2', path: '/b', access: 'write', addedAt: 7 }])
  })

  it('union merges all chats, most permissive per path', () => {
    const s = new FsGrantStore()
    s.addGrant('c1', '/a', 'read')
    s.addGrant('c2', '/a', 'write')
    s.addGrant('c2', '/b', 'read')
    expect(s.union()).toEqual([
      { path: '/a', access: 'write', askBeforeEdit: true },
      { path: '/b', access: 'read', askBeforeEdit: true },
    ])
  })

  it('notifies listeners on add, upgrade, revoke and clear, not on no-ops', () => {
    const s = new FsGrantStore()
    const fn = vi.fn()
    const off = s.onChange(fn)
    s.addGrant('c1', '/a', 'read')
    s.addGrant('c1', '/a', 'read')
    s.addGrant('c1', '/a', 'write')
    s.revoke('c1', '/nope')
    s.revoke('c1', '/a')
    s.addGrant('c1', '/b', 'read')
    s.clearChat('c1')
    s.clearChat('c1')
    expect(fn).toHaveBeenCalledTimes(5)
    off()
    s.addGrant('c1', '/c', 'read')
    expect(fn).toHaveBeenCalledTimes(5)
  })
})

describe('FsGrantStore — denial memory', () => {
  it('a full denial matches the path and its subfolders, at any level', () => {
    const s = new FsGrantStore()
    s.recordDenial('c1', '/Users/u/a', 'all')
    expect(s.findDenial('c1', '/Users/u/a', 'read')).toEqual({ path: '/Users/u/a', scope: 'all' })
    expect(s.findDenial('c1', '/Users/u/a/sub', 'write')).toEqual({ path: '/Users/u/a', scope: 'all' })
    expect(s.findDenial('c1', '/Users/u/ab', 'read')).toBeNull()
    expect(s.findDenial('c1', '/Users/u', 'read')).toBeNull()
    expect(s.findDenial('c2', '/Users/u/a', 'read')).toBeNull()
  })

  it('a write denial matches only write requests', () => {
    const s = new FsGrantStore()
    s.recordDenial('c1', '/a', 'write')
    expect(s.findDenial('c1', '/a/x', 'write')).toEqual({ path: '/a', scope: 'write' })
    expect(s.findDenial('c1', '/a/x', 'read')).toBeNull()
  })

  it('prefers a full denial over a write denial for the same request', () => {
    const s = new FsGrantStore()
    s.recordDenial('c1', '/a', 'write')
    s.recordDenial('c1', '/a', 'all')
    expect(s.findDenial('c1', '/a', 'write')).toEqual({ path: '/a', scope: 'all' })
  })

  it('clearChat drops grants and denials of that chat only', () => {
    const s = new FsGrantStore()
    s.addGrant('c1', '/a', 'read')
    s.recordDenial('c1', '/b', 'all')
    s.addGrant('c2', '/a', 'read')
    s.clearChat('c1')
    expect(s.getGrants('c1')).toEqual([])
    expect(s.findDenial('c1', '/b', 'read')).toBeNull()
    expect(s.getGrants('c2')).toHaveLength(1)
  })
})

describe('FsReadLedger', () => {
  it('records, reads and clears per chat and path', () => {
    const l = new FsReadLedger()
    l.record('c1', '/a/x.ts', { sha256: 'h1', mtimeMs: 1, size: 2 })
    expect(l.get('c1', '/a/x.ts')).toEqual({ sha256: 'h1', mtimeMs: 1, size: 2 })
    expect(l.get('c2', '/a/x.ts')).toBeUndefined()
    l.record('c1', '/a/x.ts', { sha256: 'h2', mtimeMs: 3, size: 4 })
    expect(l.get('c1', '/a/x.ts')?.sha256).toBe('h2')
    l.clearChat('c1')
    expect(l.get('c1', '/a/x.ts')).toBeUndefined()
  })
})
