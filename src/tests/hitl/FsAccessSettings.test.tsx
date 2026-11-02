import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { FsAccessSettingsPanel } from '../../renderer/src/components/settings/FsAccessSettingsPanel'
import { defaultFsAccessSettings, type FsAccessSettings, type FsPickResult, type FsChatGrantView } from '../../shared/fsAccess'
import type { SandboxStatusInfo } from '../../shared/types'

let settings: FsAccessSettings
let grants: FsChatGrantView[]
let sandbox: SandboxStatusInfo
let nextPick: FsPickResult
let rejectOnSave: Array<{ path: string; reason: string }>
const save = vi.fn()
const revoke = vi.fn()

beforeEach(() => {
  settings = defaultFsAccessSettings()
  grants = []
  sandbox = { supported: true, ready: true, errors: [], warnings: [], baselineDenyRead: ['~/.ssh', '~/.aws'], activePolicies: [] }
  nextPick = { ok: false, cancelled: true }
  rejectOnSave = []
  save.mockReset().mockImplementation(async (s: FsAccessSettings) => {
    settings = { ...s, roots: s.roots.filter((r) => !rejectOnSave.some((x) => x.path === r.path)) }
    return { settings, rejected: rejectOnSave }
  })
  revoke.mockReset().mockImplementation(async (chatId: string, path: string) => {
    grants = grants.filter((g) => !(g.chatId === chatId && g.path === path))
    return true
  })
  ;(window as any).api = {
    fsGetSettings: async () => ({ settings, dataFolder: '/Users/you/Library/Application Support/Desktop Intelligence', home: '/Users/you' }),
    fsSaveSettings: (s: FsAccessSettings) => save(s),
    fsPickFolder: async () => nextPick,
    fsListChatGrants: async () => grants,
    fsRevokeChatGrant: (c: string, p: string) => revoke(c, p),
    getSandboxStatus: async () => sandbox,
  }
})
afterEach(cleanup)

const root = (path: string, access: 'read' | 'write', askBeforeEdit = true) => ({ path, access, askBeforeEdit, addedAt: 1 })
async function renderPanel() {
  render(<FsAccessSettingsPanel />)
  await screen.findByText('Allowed folders')
}
const lastSaved = (): FsAccessSettings => save.mock.calls.at(-1)![0]

describe('Settings → File System Access', () => {
  it('renders defaults: switch on, no folders, no chat grants, the nine blocked names', async () => {
    await renderPanel()
    expect(screen.getByRole('switch', { name: 'Let DI read and edit files in folders you allow' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('No folders allowed yet.')).toBeTruthy()
    expect(screen.getByText('No folders allowed from chats yet.')).toBeTruthy()
    for (const n of settings.blockedNames) expect(screen.getByRole('button', { name: `Remove pattern ${n}` })).toBeTruthy()
  })

  it('the master switch saves enabled false', async () => {
    await renderPanel()
    fireEvent.click(screen.getByRole('switch', { name: 'Let DI read and edit files in folders you allow' }))
    await waitFor(() => expect(lastSaved().enabled).toBe(false))
  })

  it('adds a folder from the picker; the row appears read-only with ask before edits', async () => {
    nextPick = { ok: true, root: root('/Users/you/projects/foo', 'read') }
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    await waitFor(() => expect(lastSaved().roots).toEqual([root('/Users/you/projects/foo', 'read')]))
    const row = await screen.findByTestId('fs-root-row')
    expect(within(row).getByText('~/projects/foo')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Read-only' }).getAttribute('aria-pressed')).toBe('true')
    expect((within(row).getByRole('switch', { name: 'Ask before edits' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the reason under the button for an invalid pick, and adds nothing', async () => {
    nextPick = { ok: false, reason: '/Users/you is your home folder. Choose a specific project folder inside it.' }
    await renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    expect((await screen.findByRole('alert')).textContent).toBe('/Users/you is your home folder. Choose a specific project folder inside it.')
    expect(save).not.toHaveBeenCalled()
  })

  it('changes access and ask-before-edits, and removes a folder — each saved', async () => {
    settings.roots = [root('/Users/you/a', 'read')]
    await renderPanel()
    const row = screen.getByTestId('fs-root-row')
    fireEvent.click(within(row).getByRole('button', { name: 'Read & write' }))
    await waitFor(() => expect(lastSaved().roots[0]).toEqual(root('/Users/you/a', 'write', true)))
    const ask = await within(screen.getByTestId('fs-root-row')).findByRole('switch', { name: 'Ask before edits' })
    expect((ask as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(ask)
    await waitFor(() => expect(lastSaved().roots[0].askBeforeEdit).toBe(false))
    fireEvent.click(within(screen.getByTestId('fs-root-row')).getByRole('button', { name: 'Remove /Users/you/a' }))
    await waitFor(() => expect(lastSaved().roots).toEqual([]))
    expect(await screen.findByText('No folders allowed yet.')).toBeTruthy()
  })

  it('shows folders main refused when saving', async () => {
    settings.roots = [root('/Users/you/a', 'read')]
    rejectOnSave = [{ path: '/Users/you/a', reason: '/Users/you/a does not exist.' }]
    await renderPanel()
    fireEvent.click(within(screen.getByTestId('fs-root-row')).getByRole('button', { name: 'Read & write' }))
    expect(await screen.findByText('Not saved: /Users/you/a does not exist.')).toBeTruthy()
  })

  it('lists chat grants this session and revokes one', async () => {
    grants = [{ chatId: 'c1', chatTitle: 'Fix the README typo', path: '/Users/you/proj', access: 'write', addedAt: 1 }]
    await renderPanel()
    const row = await screen.findByTestId('fs-chat-grant-row')
    expect(within(row).getByText('Fix the README typo')).toBeTruthy()
    expect(within(row).getByText('~/proj')).toBeTruthy()
    expect(within(row).getByText('read & write')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('c1', '/Users/you/proj'))
    expect(await screen.findByText('No folders allowed from chats yet.')).toBeTruthy()
  })

  it('always blocked: credential paths and DI\'s data folder, collapsed until opened', async () => {
    await renderPanel()
    const toggle = screen.getByRole('button', { name: /Credential paths \(2\) and DI's own data folder/ })
    expect(screen.queryByText('~/.ssh')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('~/.ssh')).toBeTruthy()
    expect(screen.getByText('~/Library/Application Support/Desktop Intelligence')).toBeTruthy()
  })

  it('adds a valid blocked name, refuses an invalid one with the reason, and removes a chip', async () => {
    await renderPanel()
    const input = screen.getByPlaceholderText('Add a pattern (* and ? allowed)')
    fireEvent.change(input, { target: { value: 'secrets/*' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Use a file or folder name, not a path (no "/").')).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '*.p12' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(lastSaved().blockedNames.at(-1)).toBe('*.p12'))
    fireEvent.change(input, { target: { value: '.env' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Already blocked.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove pattern .env' }))
    await waitFor(() => expect(lastSaved().blockedNames).not.toContain('.env'))
  })

  it('sandbox not ready: red banner with the errors and every control disabled', async () => {
    sandbox = { ...sandbox, ready: false, errors: ['sandbox-exec not found'] }
    settings.roots = [root('/Users/you/a', 'write')]
    await renderPanel()
    expect(screen.getByText('File access is off because the tool sandbox is not running')).toBeTruthy()
    expect(screen.getByText('sandbox-exec not found')).toBeTruthy()
    expect((screen.getByRole('switch', { name: 'Let DI read and edit files in folders you allow' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Add folder…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Read & write' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByPlaceholderText('Add a pattern (* and ? allowed)') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('SettingsPage tab', () => {
  it('has "File System Access" right after "MCP Servers" and opens the panel', async () => {
    const { SettingsPage } = await import('../../renderer/src/components/settings/SettingsPage')
    render(<SettingsPage onClose={() => {}} initialTab="files" />)
    const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim()).filter(Boolean)
    expect(labels.indexOf('File System Access')).toBe(labels.indexOf('MCP Servers') + 1)
    expect(await screen.findByTestId('fs-access-settings')).toBeTruthy()
  })
})
