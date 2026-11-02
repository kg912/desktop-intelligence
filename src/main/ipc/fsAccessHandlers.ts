/**
 * Built-in file system access IPC (specs/builtin-file-system-access.md 2.9).
 * Registered from index.ts, like registerRagSettingsHandlers().
 *
 * Main never trusts a root from the renderer: every saved or picked folder is
 * resolved and re-validated with the path policy here.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import {
  sanitizeFsAccessSettings,
  type FsAccessResponse,
  type FsAccessSettings,
  type FsChatGrantView,
  type FsPickResult,
  type FsRoot,
  type FsSaveResult,
  type FsSettingsView,
} from '../../shared/fsAccess'
import { resolveTarget, validateGrantRoot, type FsPolicyDeps } from '../services/fs/pathPolicy'
import type { FsGrantStore } from '../services/fs/FsGrantStore'

export interface FsHandlerDeps {
  getSettings: () => FsAccessSettings
  saveSettings: (s: FsAccessSettings) => void
  policyDeps: FsPolicyDeps
  grants: FsGrantStore
  respond: (r: FsAccessResponse) => void
  /** Native folder picker; null when cancelled. */
  pickFolder: () => Promise<string | null>
  chatTitle: (chatId: string) => string | null
  now?: () => number
}

function checkRoot(path: string, deps: FsPolicyDeps): { ok: true; real: string } | { ok: false; reason: string } {
  const r = resolveTarget(path, deps)
  if (!r.ok) return r
  const v = validateGrantRoot(r.real, deps)
  return v.ok ? { ok: true, real: r.real } : v
}

export function createFsAccessHandlers(d: FsHandlerDeps) {
  return {
    getSettings: (): FsSettingsView => ({ settings: d.getSettings(), dataFolder: d.policyDeps.userDataDir, home: d.policyDeps.homedir }),

    saveSettings(raw: unknown): FsSaveResult {
      const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const kept: FsRoot[] = []
      const rejected: FsSaveResult['rejected'] = []
      for (const e of Array.isArray(obj.roots) ? obj.roots : []) {
        if (!e || typeof e !== 'object' || typeof (e as FsRoot).path !== 'string') continue
        const c = checkRoot((e as FsRoot).path, d.policyDeps)
        if (c.ok) kept.push({ ...(e as FsRoot), path: c.real })
        else rejected.push({ path: (e as FsRoot).path, reason: c.reason })
      }
      const settings = sanitizeFsAccessSettings({ ...obj, roots: kept })
      d.saveSettings(settings)
      return { settings, rejected }
    },

    async pickFolder(purpose: 'settings' | 'request'): Promise<FsPickResult> {
      const picked = await d.pickFolder()
      if (!picked) return { ok: false, cancelled: true }
      const c = checkRoot(picked, d.policyDeps)
      if (!c.ok) return c
      if (purpose === 'settings' && d.getSettings().roots.some((r) => r.path === c.real)) return { ok: false, reason: 'Already allowed.' }
      return { ok: true, root: { path: c.real, access: 'read', askBeforeEdit: true, addedAt: (d.now ?? Date.now)() } }
    },

    listChatGrants: (): FsChatGrantView[] =>
      d.grants.listAll().map((g) => ({ chatId: g.chatId, chatTitle: d.chatTitle(g.chatId) ?? 'Untitled chat', path: g.path, access: g.access, addedAt: g.addedAt })),

    revokeChatGrant: (chatId: string, path: string): boolean => d.grants.revoke(chatId, path),

    respondAccess: (r: FsAccessResponse): void => d.respond(r),
  }
}

export async function registerFsAccessHandlers(): Promise<void> {
  const fs = await import('../services/fs/fsAccessInstance')
  const { getAllChats } = await import('../services/DatabaseService')
  const h = createFsAccessHandlers({
    getSettings: fs.getFsAccessSettings,
    saveSettings: fs.saveFsAccessSettings,
    policyDeps: fs.fsPolicyDeps,
    grants: fs.fsGrantStore,
    respond: (r) => fs.fsAccessBroker.respond(r),
    pickFolder: async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { properties: ['openDirectory' as const], title: 'Choose a folder for Desktop Intelligence' }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled ? null : (res.filePaths[0] ?? null)
    },
    chatTitle: (chatId) => getAllChats().find((c) => c.id === chatId)?.title ?? null,
  })
  ipcMain.handle(IPC_CHANNELS.FS_GET_SETTINGS, () => h.getSettings())
  ipcMain.handle(IPC_CHANNELS.FS_SAVE_SETTINGS, (_e, raw: unknown) => h.saveSettings(raw))
  ipcMain.handle(IPC_CHANNELS.FS_PICK_FOLDER, (_e, purpose: 'settings' | 'request') => h.pickFolder(purpose === 'request' ? 'request' : 'settings'))
  ipcMain.handle(IPC_CHANNELS.FS_LIST_CHAT_GRANTS, () => h.listChatGrants())
  ipcMain.handle(IPC_CHANNELS.FS_REVOKE_CHAT_GRANT, (_e, chatId: string, path: string) => h.revokeChatGrant(chatId, path))
  ipcMain.handle(IPC_CHANNELS.FS_ACCESS_RESPONSE, (_e, r: FsAccessResponse) => h.respondAccess(r))
}
