import { describe, it, expect, vi } from 'vitest'
import { McpServerManagerTestable } from '../../main/services/McpServerManager'

describe('bypass flag', () => {
  it('is false on fresh instantiation', () => {
    const m = new McpServerManagerTestable()
    expect(m.getBypassFlag()).toBe(false)
  })
  it('auto-approves without calling dialog when bypass=true', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.setBypassPermissions(true)
    const dialogSpy = vi.spyOn(m, '_awaitPermissionDialog')
    const result = await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(result.approved).toBe(true)
    expect(dialogSpy).not.toHaveBeenCalled()
  })
  it('re-gates after setBypassPermissions(false)', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.setBypassPermissions(true)
    m.setBypassPermissions(false)
    m.mockNextDialogResponse({ approved: false, userNote: '' })
    const result = await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(result.approved).toBe(false)
  })
})

describe('server requiresApproval flag', () => {
  it('auto-approves without calling dialog when requiresApproval=false', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: false })
    const dialogSpy = vi.spyOn(m, '_awaitPermissionDialog')
    const result = await m.testRequestPermission('srv', 'read_file', {}, 'chat1')
    expect(result.approved).toBe(true)
    expect(dialogSpy).not.toHaveBeenCalled()
  })
  it('triggers dialog when requiresApproval=true', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.mockNextDialogResponse({ approved: true, userNote: '' })
    const dialogSpy = vi.spyOn(m, '_awaitPermissionDialog')
    await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(dialogSpy).toHaveBeenCalledOnce()
  })
  it('alwaysAllow=forever sets requiresApproval=false in-memory', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.mockNextDialogResponse({ approved: true, alwaysAllow: 'forever', userNote: '' })
    await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(m.getServerRequiresApproval('srv')).toBe(false)
  })
  it('alwaysAllow=session adds compound key, does not change requiresApproval', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.mockNextDialogResponse({ approved: true, alwaysAllow: 'session', userNote: '' })
    await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(m.getSessionAllowList().has('chat1__srv__write_file')).toBe(true)
    expect(m.getServerRequiresApproval('srv')).toBe(true)
  })
  it('sessionAllowList is empty on fresh instantiation', () => {
    const m = new McpServerManagerTestable()
    expect(m.getSessionAllowList().size).toBe(0)
  })
})

describe('session allow list', () => {
  it('auto-approves second call for same chatId+server+tool after session approval', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.mockNextDialogResponse({ approved: true, alwaysAllow: 'session', userNote: '' })
    await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    const dialogSpy = vi.spyOn(m, '_awaitPermissionDialog')
    const result = await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(result.approved).toBe(true)
    expect(dialogSpy).not.toHaveBeenCalled()
  })
  it('still gates second call for different chatId', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.mockNextDialogResponse({ approved: true, alwaysAllow: 'session', userNote: '' })
    await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    m.mockNextDialogResponse({ approved: false, userNote: '' })
    const result = await m.testRequestPermission('srv', 'write_file', {}, 'chat2')
    expect(result.approved).toBe(false)
  })
})

describe('drainPendingPermissions', () => {
  it('resolves all pending promises with approved=false', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    const pending = m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    m.drainPendingPermissions()
    const result = await pending
    expect(result.approved).toBe(false)
  })
  it('clears the pendingPermissions map', () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    m.drainPendingPermissions()
    expect(m.getPendingCount()).toBe(0)
  })
  it('is safe to call when map is empty', () => {
    const m = new McpServerManagerTestable()
    expect(() => m.drainPendingPermissions()).not.toThrow()
  })
})

describe('resolvePermission', () => {
  it('is a no-op for unknown requestId', () => {
    const m = new McpServerManagerTestable()
    expect(() =>
      m.resolvePermission({ requestId: 'unknown', approved: true, alwaysAllow: false, userNote: '' })
    ).not.toThrow()
  })
})
