/**
 * RAG v2 settings IPC handlers — Phase 3 + Phase 4.
 *
 * Registered separately from handlers.ts via registerRagSettingsHandlers()
 * called from index.ts.
 *
 * Exposes two channels:
 *   SETTINGS_GET_RAG  → { rerankEnabled: boolean; ragVerboseTrace: boolean }
 *   SETTINGS_SAVE_RAG → void (patch: { rerankEnabled?: boolean; ragVerboseTrace?: boolean })
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'

export function registerRagSettingsHandlers(): void {
  // ── GET ─────────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_RAG, async () => {
    const { readSettings } = await import('../services/SettingsStore')
    const s = readSettings()
    return {
      rerankEnabled:   s.rerankEnabled   ?? false,
      ragVerboseTrace: s.ragVerboseTrace ?? false,
    }
  })

  // ── SAVE ────────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_RAG,
    async (_, patch: { rerankEnabled?: boolean; ragVerboseTrace?: boolean }) => {
      const { writeSettings } = await import('../services/SettingsStore')
      const p: { rerankEnabled?: boolean; ragVerboseTrace?: boolean } = {}
      if (patch.rerankEnabled !== undefined)   p.rerankEnabled   = patch.rerankEnabled
      if (patch.ragVerboseTrace !== undefined) p.ragVerboseTrace = patch.ragVerboseTrace
      if (Object.keys(p).length > 0) writeSettings(p)

      // Fire-and-forget warm-up when the user enables reranking so the model
      // download completes before the first document query arrives.
      if (patch.rerankEnabled) {
        void import('../services/rag/RerankerService')
          .then(m => m.ensureRerankerReady())
          .catch(() => {/* model load failure is non-fatal */})
      }
    }
  )
}
