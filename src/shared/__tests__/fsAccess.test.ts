import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BLOCKED_NAMES,
  defaultFsAccessSettings,
  sanitizeFsAccessSettings,
  validateBlockedName,
  blockedNameMatcher,
  describeAccess,
} from '../fsAccess'

describe('defaultFsAccessSettings', () => {
  it('is enabled with no roots and the spec blocked names', () => {
    expect(defaultFsAccessSettings()).toEqual({
      enabled: true,
      roots: [],
      blockedNames: ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '.netrc', '.npmrc', '.pypirc'],
    })
    expect(DEFAULT_BLOCKED_NAMES).toHaveLength(9)
  })

  it('returns a fresh copy each time', () => {
    const a = defaultFsAccessSettings()
    a.blockedNames.push('x')
    expect(defaultFsAccessSettings().blockedNames).not.toContain('x')
  })
})

describe('sanitizeFsAccessSettings', () => {
  it('fills defaults for undefined, null and non-objects', () => {
    expect(sanitizeFsAccessSettings(undefined)).toEqual(defaultFsAccessSettings())
    expect(sanitizeFsAccessSettings(null)).toEqual(defaultFsAccessSettings())
    expect(sanitizeFsAccessSettings('x')).toEqual(defaultFsAccessSettings())
  })

  it('keeps enabled false only when it is the boolean false', () => {
    expect(sanitizeFsAccessSettings({ enabled: false }).enabled).toBe(false)
    expect(sanitizeFsAccessSettings({ enabled: 'no' }).enabled).toBe(true)
  })

  it('drops malformed roots and defaults askBeforeEdit to true', () => {
    const out = sanitizeFsAccessSettings({
      roots: [
        { path: '/Users/u/a', access: 'write', addedAt: 5 },
        { path: 'relative/b', access: 'read', askBeforeEdit: false, addedAt: 1 },
        { path: '/Users/u/c', access: 'admin', askBeforeEdit: false, addedAt: 1 },
        { path: 42, access: 'read' },
        null,
        'str',
        { path: '/Users/u/d', access: 'read', askBeforeEdit: false },
      ],
    })
    expect(out.roots).toEqual([
      { path: '/Users/u/a', access: 'write', askBeforeEdit: true, addedAt: 5 },
      { path: '/Users/u/d', access: 'read', askBeforeEdit: false, addedAt: 0 },
    ])
  })

  it('merges duplicate roots by path: most permissive access, ask if either asks, earliest addedAt', () => {
    const out = sanitizeFsAccessSettings({
      roots: [
        { path: '/Users/u/a', access: 'read', askBeforeEdit: false, addedAt: 9 },
        { path: '/Users/u/a', access: 'write', askBeforeEdit: true, addedAt: 3 },
        { path: '/Users/u/a/', access: 'read', askBeforeEdit: false, addedAt: 4 },
      ],
    })
    expect(out.roots).toEqual([{ path: '/Users/u/a', access: 'write', askBeforeEdit: true, addedAt: 3 }])
  })

  it('keeps valid blocked names, drops invalid ones and duplicates', () => {
    const out = sanitizeFsAccessSettings({ blockedNames: ['.env', '.env', 'a/b', '', '[x]', 7, 'secret?.txt'] })
    expect(out.blockedNames).toEqual(['.env', 'secret?.txt'])
  })

  it('uses the default blocked names when the field is missing', () => {
    expect(sanitizeFsAccessSettings({ roots: [] }).blockedNames).toEqual([...DEFAULT_BLOCKED_NAMES])
  })

  it('keeps an explicitly empty blocked-name list', () => {
    expect(sanitizeFsAccessSettings({ blockedNames: [] }).blockedNames).toEqual([])
  })
})

describe('validateBlockedName', () => {
  it('accepts names with * and ?', () => {
    expect(validateBlockedName('.env')).toBeNull()
    expect(validateBlockedName('*.pem')).toBeNull()
    expect(validateBlockedName('id_rsa?')).toBeNull()
  })
  it('rejects empty, slashes, other glob syntax, NUL and overlong names with plain reasons', () => {
    expect(validateBlockedName('')).toBe('Enter a file name pattern.')
    expect(validateBlockedName('   ')).toBe('Enter a file name pattern.')
    expect(validateBlockedName('a/b')).toBe('Use a file or folder name, not a path (no "/").')
    expect(validateBlockedName('a\\b')).toBe('Use a file or folder name, not a path (no "/").')
    expect(validateBlockedName('[ab]')).toBe('Only * and ? are supported as wildcards.')
    expect(validateBlockedName('{a,b}')).toBe('Only * and ? are supported as wildcards.')
    expect(validateBlockedName('a\0b')).toBe('The pattern contains an invalid character.')
    expect(validateBlockedName('x'.repeat(101))).toBe('Keep the pattern under 100 characters.')
    expect(validateBlockedName(3)).toBe('Enter a file name pattern.')
  })
})

describe('blockedNameMatcher', () => {
  const match = blockedNameMatcher([...DEFAULT_BLOCKED_NAMES])
  it('matches whole segments only', () => {
    expect(match('.env')).toBe('.env')
    expect(match('.env.production')).toBe('.env.*')
    expect(match('server.pem')).toBe('*.pem')
    expect(match('id_rsa.pub')).toBe('id_rsa*')
    expect(match('.envrc')).toBeNull()
    expect(match('my.env')).toBeNull()
    expect(match('pem')).toBeNull()
  })
  it('treats regex metacharacters literally and ? as one character', () => {
    const m = blockedNameMatcher(['a+b(1)?'])
    expect(m('a+b(1)x')).toBe('a+b(1)?')
    expect(m('aab(1)x')).toBeNull()
    expect(m('a+b(1)')).toBeNull()
  })
})

describe('describeAccess', () => {
  it('names the levels', () => {
    expect(describeAccess('write')).toBe('read and write')
    expect(describeAccess('read')).toBe('read-only')
  })
})
