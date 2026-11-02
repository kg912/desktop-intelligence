// Built-in file access singletons, wired to the app (settings, sandbox,
// permission dialogs, observability). Everything with logic lives in the
// modules imported here; this file only connects them.

import { app } from 'electron'
import { homedir } from 'os'
import { readSettings, writeSettings } from '../SettingsStore'
import { BASELINE_DENY_READ } from '../sandbox/BASELINE_DENY_READ'
import { sandboxService } from '../sandbox/sandboxServiceInstance'
import { getSandboxStatus } from '../sandbox/sandboxStatus'
import { mcpServerManager } from '../McpServerManager'
import { observabilityService } from '../ObservabilityService'
import { sanitizeFsAccessSettings, type FsAccessLevel, type FsAccessSettings } from '../../../shared/fsAccess'
import { realFsDeps } from './pathPolicy'
import { FsGrantStore } from './FsGrantStore'
import { FsReadLedger } from './FsReadLedger'
import { FsAccessBroker } from './FsAccessBroker'
import { FsToolService } from './FsToolService'

export const fsGrantStore = new FsGrantStore()
export const fsReadLedger = new FsReadLedger()
export const fsPolicyDeps = realFsDeps({ homedir: homedir(), userDataDir: app.getPath('userData'), credentialEntries: BASELINE_DENY_READ })

export function getFsAccessSettings(): FsAccessSettings {
  return sanitizeFsAccessSettings(readSettings().fsAccess)
}

export function saveFsAccessSettings(next: FsAccessSettings): void {
  writeSettings({ fsAccess: sanitizeFsAccessSettings(next) })
}

let fsToolServiceRef: FsToolService | null = null

export const fsAccessBroker = new FsAccessBroker({
  policyDeps: fsPolicyDeps,
  grants: fsGrantStore,
  effectiveGrants: (chatId) => fsToolServiceRef?.effectiveGrants(chatId) ?? [],
  blockedNames: () => getFsAccessSettings().blockedNames,
  addPersistentRoot: (path: string, access: FsAccessLevel) => {
    const cur = getFsAccessSettings()
    saveFsAccessSettings({ ...cur, roots: [...cur.roots, { path, access, askBeforeEdit: true, addedAt: Date.now() }] })
  },
  observe: (t) => observabilityService.emitFsAccess(t),
})

export const fsToolService = new FsToolService({
  spawn: (spec) => sandboxService.spawnPersistent(spec),
  sandboxReady: () => getSandboxStatus().ready,
  getSettings: getFsAccessSettings,
  grants: fsGrantStore,
  ledger: fsReadLedger,
  policyDeps: fsPolicyDeps,
  userDataDir: app.getPath('userData'),
  requestEditApproval: (chatId, toolName, args) => mcpServerManager.requestBuiltinPermission('fs', toolName, args, chatId),
  broker: fsAccessBroker,
})
fsToolServiceRef = fsToolService

/** A deleted chat loses its grants, denials, ledger and pending requests. */
export function forgetFsChat(chatId: string): void {
  fsAccessBroker.cancelChat(chatId)
  fsGrantStore.clearChat(chatId)
  fsReadLedger.clearChat(chatId)
}
