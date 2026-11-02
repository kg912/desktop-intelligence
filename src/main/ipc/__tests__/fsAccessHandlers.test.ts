import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {}, BrowserWindow: {} }))

import { createFsAccessHandlers, type FsHandlerDeps } from '../fsAccessHandlers'
import { FsGrantStore } from '../../services/fs/FsGrantStore'
import { realFsDeps } from '../../services/fs/pathPolicy'
import { defaultFsAccessSettings, type FsAccessSettings } from '../../../shared/fsAccess'

let base: string
let home: string
let saved: FsAccessSettings
let picked: string | null
let responded: unknown[]
let grants: FsGrantStore
let h: ReturnType<typeof createFsAccessHandlers>

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'di-fsh-')))
  home = join(base, 'Users', 'u')
  for (const d of ['projects/foo', 'projects/bar', 'Library/Application Support/DI']) mkdirSync(join(home, d), { recursive: true })
  writeFileSync(join(home, 'projects/file.txt'), 'x')
  saved = defaultFsAccessSettings()
  picked = null
  responded = []
  grants = new FsGrantStore(() => 42)
  const deps: FsHandlerDeps = {
    getSettings: () => saved,
    saveSettings: (s) => {
      saved = s
    },
    policyDeps: { ...realFsDeps({ homedir: home, userDataDir: join(home, 'Library/Application Support/DI'), credentialEntries: ['~/.ssh'] }), systemDirs: ['/System'] },
    grants,
    respond: (r) => responded.push(r),
    pickFolder: async () => picked,
    chatTitle: (id) => (id === 'c1' ? 'Fix the README typo' : null),
    now: () => 1000,
  }
  h = createFsAccessHandlers(deps)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('FS_GET_SETTINGS', () => {
  it('returns the sanitised settings, DI\'s data folder and home', () => {
    expect(h.getSettings()).toEqual({ settings: defaultFsAccessSettings(), dataFolder: join(home, 'Library/Application Support/DI'), home })
  })
})

describe('FS_SAVE_SETTINGS', () => {
  it('S11: rejects a renderer-supplied "/" and "~" in main, keeps valid roots (as real paths)', () => {
    const r = h.saveSettings({
      enabled: true,
      blockedNames: ['.env', 'bad/name'],
      roots: [
        { path: '/', access: 'write', askBeforeEdit: false, addedAt: 1 },
        { path: '~', access: 'read', askBeforeEdit: true, addedAt: 1 },
        { path: join(home, 'projects/foo/'), access: 'write', askBeforeEdit: false, addedAt: 2 },
      ],
    })
    expect(r.rejected).toEqual([
      { path: '/', reason: '/ is the whole disk. Choose a specific project folder.' },
      { path: '~', reason: `${home} is your home folder. Choose a specific project folder inside it.` },
    ])
    expect(r.settings).toEqual({
      enabled: true,
      blockedNames: ['.env'],
      roots: [{ path: join(home, 'projects/foo'), access: 'write', askBeforeEdit: false, addedAt: 2 }],
    })
    expect(saved).toEqual(r.settings)
  })

  it('rejects files, missing folders and DI data, and survives garbage input', () => {
    const r = h.saveSettings({
      roots: [
        { path: join(home, 'projects/file.txt'), access: 'read', askBeforeEdit: true, addedAt: 1 },
        { path: join(home, 'nope'), access: 'read', askBeforeEdit: true, addedAt: 1 },
        { path: join(home, 'Library/Application Support/DI'), access: 'read', askBeforeEdit: true, addedAt: 1 },
      ],
    })
    expect(r.rejected.map((x) => x.reason)).toEqual([
      `${join(home, 'projects/file.txt')} is a file, not a folder.`,
      `${join(home, 'nope')} does not exist.`,
      `${join(home, 'Library/Application Support/DI')} holds Desktop Intelligence's own data. Choose a project folder.`,
    ])
    expect(r.settings.roots).toEqual([])
    expect(h.saveSettings('garbage').settings).toEqual(defaultFsAccessSettings())
  })
})

describe('FS_PICK_FOLDER', () => {
  it('returns cancelled when the picker is closed', async () => {
    expect(await h.pickFolder('settings')).toEqual({ ok: false, cancelled: true })
  })
  it('returns a read-only, asking root for a valid folder', async () => {
    picked = join(home, 'projects/foo')
    expect(await h.pickFolder('settings')).toEqual({ ok: true, root: { path: join(home, 'projects/foo'), access: 'read', askBeforeEdit: true, addedAt: 1000 } })
  })
  it('explains an invalid folder', async () => {
    picked = home
    expect(await h.pickFolder('settings')).toEqual({ ok: false, reason: `${home} is your home folder. Choose a specific project folder inside it.` })
  })
  it('refuses a duplicate in Settings, but not for an access request', async () => {
    saved = { ...saved, roots: [{ path: join(home, 'projects/foo'), access: 'read', askBeforeEdit: true, addedAt: 1 }] }
    picked = join(home, 'projects/foo')
    expect(await h.pickFolder('settings')).toEqual({ ok: false, reason: 'Already allowed.' })
    expect((await h.pickFolder('request')).ok).toBe(true)
  })
})

describe('chat grants and access responses', () => {
  it('lists chat grants with titles (fallback "Untitled chat") and revokes one', () => {
    grants.addGrant('c1', join(home, 'projects/foo'), 'write')
    grants.addGrant('c2', join(home, 'projects/bar'), 'read')
    expect(h.listChatGrants()).toEqual([
      { chatId: 'c1', chatTitle: 'Fix the README typo', path: join(home, 'projects/foo'), access: 'write', addedAt: 42 },
      { chatId: 'c2', chatTitle: 'Untitled chat', path: join(home, 'projects/bar'), access: 'read', addedAt: 42 },
    ])
    expect(h.revokeChatGrant('c1', join(home, 'projects/foo'))).toBe(true)
    expect(h.listChatGrants().map((g) => g.chatId)).toEqual(['c2'])
  })
  it('forwards an access response to the broker', () => {
    h.respondAccess({ requestId: 'r1', decision: 'chat', access: 'read', path: '/x' })
    expect(responded).toEqual([{ requestId: 'r1', decision: 'chat', access: 'read', path: '/x' }])
  })
})
