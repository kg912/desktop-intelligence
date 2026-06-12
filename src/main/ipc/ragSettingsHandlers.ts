/**
 * RAG v2 settings IPC handlers — Phase 3 (reranker toggle).
 *
 * Registered separately from handlers.ts (which is off-limits per Phase 3
 * hard constraints) via registerRagSettingsHandlers() called from index.ts.
 *
 * Exposes two channels:
 *   SETTINGS_GET_RAG  → { rerankEnabled: boolean }
 *   SETTINGS_SAVE_RAG → void (patch: { rerankEnabled?: boolean })
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'

export function registerRagSettingsHandlers(): void {
  // ── GET ─────────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_RAG, async () => {
    const { readSettings } = await import('../services/SettingsStore')
    const s = readSettings()
    return { rerankEnabled: s.rerankEnabled ?? false }
  })

  // ── SAVE ────────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_RAG,
    async (_, patch: { rerankEnabled?: boolean }) => {
      const { writeSettings } = await import('../services/SettingsStore')
      if (patch.rerankEnabled !== undefined) {
        writeSettings({ rerankEnabled: patch.rerankEnabled })

        // Fire-and-forget warm-up when the user enables reranking so the model
        // download completes before the first document query arrives.
        if (patch.rerankEnabled) {
          void import('../services/rag/RerankerService')
            .then(m => m.ensureRerankerReady())
            .catch(() => {/* model load failure is non-fatal */})
        }
      }
    }
  )
}
