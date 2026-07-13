import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { isCredentialPath, shouldAlertForViolation } from '../isCredentialPath'
import type { SandboxViolationTraceEvent } from '../../../../shared/types'

describe('isCredentialPath', () => {
  it('matches an exact BASELINE_DENY_READ entry', () => {
    expect(isCredentialPath(join(homedir(), '.gitconfig'))).toBe(true)
  })

  it('matches a file inside a BASELINE_DENY_READ directory entry', () => {
    expect(isCredentialPath(join(homedir(), '.ssh', 'id_ed25519'))).toBe(true)
    expect(isCredentialPath(join(homedir(), '.aws', 'credentials'))).toBe(true)
  })

  it('matches the glob-pattern Chrome Cookies entry regardless of profile name', () => {
    expect(
      isCredentialPath(
        join(homedir(), 'Library/Application Support/Google/Chrome/Default/Cookies')
      )
    ).toBe(true)
    expect(
      isCredentialPath(
        join(homedir(), 'Library/Application Support/Google/Chrome/Profile 3/Cookies')
      )
    ).toBe(true)
  })

  it('does not match an unrelated path', () => {
    expect(isCredentialPath('/tmp/some-scratch-file.py')).toBe(false)
    expect(isCredentialPath(join(homedir(), 'Documents', 'notes.txt'))).toBe(false)
  })

  it('does not false-positive on a path that merely starts with the same prefix string', () => {
    // ~/.ssh should not match ~/.ssh-backup (prefix match must respect the '/' boundary)
    expect(isCredentialPath(join(homedir(), '.ssh-backup', 'whatever'))).toBe(false)
  })
})

describe('shouldAlertForViolation', () => {
  const base: SandboxViolationTraceEvent = {
    source: 'python-worker',
    kind: 'read',
    target: join(homedir(), '.ssh', 'id_ed25519'),
    timestamp: Date.now(),
  }

  it('alerts on a read of a credential path', () => {
    expect(shouldAlertForViolation(base)).toBe(true)
  })

  it('does not alert on a read of a non-credential path', () => {
    expect(shouldAlertForViolation({ ...base, target: '/tmp/scratch.py' })).toBe(false)
  })

  it('does not alert on a write to a credential path (only reads escalate)', () => {
    expect(shouldAlertForViolation({ ...base, kind: 'write' })).toBe(false)
  })

  it('does not alert on a network violation', () => {
    expect(shouldAlertForViolation({ ...base, kind: 'network', target: 'evil.example.com' })).toBe(false)
  })
})
