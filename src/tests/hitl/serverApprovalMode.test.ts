import { describe, it, expect } from 'vitest'
import { McpServerManagerTestable } from '../../main/services/McpServerManager'

describe('per-server approval mode', () => {
  it('defaults to requiresApproval=true when field absent in config', () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', {})
    expect(m.getServerRequiresApproval('srv')).toBe(true)
  })
  it('respects requiresApproval=false when explicitly set', () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: false })
    expect(m.getServerRequiresApproval('srv')).toBe(false)
  })
  it('setServerApprovalMode updates in-memory entry immediately', () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.setServerApprovalMode('srv', false)
    expect(m.getServerRequiresApproval('srv')).toBe(false)
  })
})
