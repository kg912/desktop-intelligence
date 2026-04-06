/**
 * SettingsStore
 *
 * Lightweight JSON persistence for user preferences that must survive
 * app restarts.  Stored in app.getPath('userData') alongside the SQLite
 * database so it is never bundled into the asar archive.
 *
 * Currently tracks:
 *   - contextLength  → n_ctx passed to `lms load` on every startup
 *
 * Designed to be synchronous (readFileSync / writeFileSync) so callers
 * don't need to await before using the value.
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

export interface AppSettings {
  /** Context length (n_ctx) to use when loading the model. */
  contextLength?: number
  /** LM Studio model identifier chosen by the user (e.g. "mlx-community/Qwen3.5-35B-A3B-6bit"). */
  modelId?: string
  /** Whether Brave Search is enabled. */
  braveSearchEnabled?: boolean
  /** User-entered Brave Search API key (superseded by BRAVE_SEARCH_API_KEY env var). */
  braveSearchApiKey?:  string
  /** Maximum number of mid-stream search rounds before forcing a final answer. Default: 4. */
  maxSearchLoops?: number
  /** LM Studio generation temperature (0–2). Default: 0.7 */
  temperature?: number
  /** Nucleus sampling top-p (0–1). Default: 0.95 */
  topP?: number
  /** Max output tokens for Step 2 stream body. Default: 16384 */
  maxOutputTokens?: number
  /** Repetition penalty (1.0–1.5). Default: 1.1 */
  repeatPenalty?: number
  /** Global system prompt prepended to every request. Default: '' */
  systemPrompt?: string
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

/**
 * Read the persisted settings file.
 * Returns an empty object if the file is missing or unreadable.
 */
export function readSettings(): AppSettings {
  try {
    const p = settingsPath()
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf8')) as AppSettings
    }
  } catch (err) {
    console.warn('[SettingsStore] read failed (using defaults):', err)
  }
  return {}
}

/**
 * Merge `patch` into the current settings and write to disk.
 */
export function writeSettings(patch: Partial<AppSettings>): void {
  try {
    const current = readSettings()
    const next    = { ...current, ...patch }
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
    console.log('[SettingsStore] Saved:', next)
  } catch (err) {
    console.error('[SettingsStore] write failed:', err)
  }
}
