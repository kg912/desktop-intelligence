/**
 * unsafePorts — blocked-port detection
 *
 * Background: MTPLX was running on port 6000 and `curl` reached it fine, but
 * Desktop Intelligence could not. Both of the app's real HTTP clients refuse
 * that port before opening a socket — Node's `fetch` (undici) with
 * cause "bad port", and Electron's `net.fetch` with net::ERR_UNSAFE_PORT.
 * axios does not enforce the list, which is why the health checks in
 * ModelConnectionManager / MTPLXDaemonManager reported the backend as ready
 * while every fetch-based call failed.
 *
 * The list is asserted here so a future edit cannot quietly drop an entry and
 * reintroduce a silent connection failure.
 */

import { describe, it, expect } from 'vitest'
import {
  UNSAFE_PORTS,
  isUnsafePort,
  portFromUrl,
  describeUnsafePort,
} from '../../../shared/unsafePorts'

describe('UNSAFE_PORTS list', () => {
  it('contains the 82 ports undici rejects, as measured against this runtime', () => {
    expect(UNSAFE_PORTS).toHaveLength(82)
  })

  it('is sorted ascending with no duplicates', () => {
    const sorted = [...UNSAFE_PORTS].sort((a, b) => a - b)
    expect([...UNSAFE_PORTS]).toEqual(sorted)
    expect(new Set(UNSAFE_PORTS).size).toBe(UNSAFE_PORTS.length)
  })

  it('blocks 6000 — the port that triggered this investigation (X11)', () => {
    expect(isUnsafePort(6000)).toBe(true)
  })

  it('blocks the IRC range a user might plausibly pick', () => {
    for (const p of [6665, 6666, 6667, 6668, 6669, 6679, 6697]) {
      expect(isUnsafePort(p)).toBe(true)
    }
  })

  it('does NOT block the ports the shipped backends actually use', () => {
    // This is why the bug never surfaced for any other provider.
    expect(isUnsafePort(1234)).toBe(false)   // LM Studio
    expect(isUnsafePort(8000)).toBe(false)   // MTPLX default
    expect(isUnsafePort(11434)).toBe(false)  // Ollama local
    expect(isUnsafePort(443)).toBe(false)    // cloud providers over https
  })
})

describe('portFromUrl', () => {
  it('reads an explicit port', () => {
    expect(portFromUrl('http://localhost:6000')).toBe(6000)
    expect(portFromUrl('http://127.0.0.1:8000/v1/models')).toBe(8000)
  })

  it('falls back to the protocol default when no port is given', () => {
    expect(portFromUrl('http://localhost')).toBe(80)
    expect(portFromUrl('https://example.com')).toBe(443)
  })

  it('returns null for an unparseable URL rather than throwing', () => {
    expect(portFromUrl('not a url')).toBeNull()
    expect(portFromUrl('')).toBeNull()
  })
})

describe('describeUnsafePort', () => {
  it('returns null for a usable port', () => {
    expect(describeUnsafePort('http://localhost:8000', 'MTPLX')).toBeNull()
  })

  it('returns null for an unparseable URL — that is a different failure', () => {
    expect(describeUnsafePort('garbage', 'MTPLX')).toBeNull()
  })

  it('names the offending port and the backend', () => {
    const msg = describeUnsafePort('http://localhost:6000', 'MTPLX')
    expect(msg).toContain('6000')
    expect(msg).toContain('MTPLX')
  })

  it('explains the curl discrepancy that makes this so confusing', () => {
    const msg = describeUnsafePort('http://localhost:6000', 'MTPLX') ?? ''
    expect(msg).toContain('curl')
  })

  it('tells the user what to actually do about it', () => {
    const msg = describeUnsafePort('http://localhost:6000', 'MTPLX') ?? ''
    expect(msg).toMatch(/different port/i)
  })

  it('flags the port regardless of host — the block is port-based, not host-based', () => {
    // Confirmed empirically: localhost and the IP literal fail identically,
    // which is why swapping to 127.0.0.1 would not have helped.
    expect(describeUnsafePort('http://localhost:6000', 'MTPLX')).not.toBeNull()
    expect(describeUnsafePort('http://127.0.0.1:6000', 'MTPLX')).not.toBeNull()
  })
})
