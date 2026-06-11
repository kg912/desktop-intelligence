/**
 * sqliteVecLoader — canonical sqlite-vec extension loader for RAG v2.
 *
 * Single source of truth for loading the sqlite-vec native extension.
 * Used by DatabaseService (production) and the Phase 0 spike script.
 *
 * TEMPORARY marker — remove module-level `_loadAttempted` in Phase 5 if the
 * loader is moved into DatabaseService directly.
 */

import path from 'path'
import type Database from 'better-sqlite3'

// Lazy import of sqlite-vec (native module — only available in main process).
// Dynamic require avoids bundling issues in renderer stubs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqliteVec = require('sqlite-vec') as {
  load: (db: unknown) => void
  getLoadablePath: () => string
}

// Module-level state — set once per process lifetime.
let _vecAvailable  = false
let _loadAttempted = false

// ── Exported canonical loader ─────────────────────────────────────────────────

/**
 * Load the sqlite-vec extension into a better-sqlite3 Database instance.
 *
 * Primary path: delegates to sqlite-vec's own load() helper.
 * Fallback path: resolves the dylib manually, rewrites app.asar → app.asar.unpacked,
 * and strips the .dylib suffix before calling loadExtension().
 * This fixes electron-builder issue #8824 where better-sqlite3/SQLite appends the
 * platform suffix, producing vec0.dylib.dylib inside the ASAR virtual filesystem.
 *
 * Returns true if the extension loaded successfully, false otherwise.
 */
export function loadSqliteVec(db: Database.Database): boolean {
  // Primary: use the sqlite-vec package's own load helper
  try {
    sqliteVec.load(db)
    return true
  } catch {
    // fall through to manual fallback
  }

  // Fallback: manual path resolution with ASAR rewrite + extension strip
  try {
    let extPath = sqliteVec.getLoadablePath()

    // Rewrite app.asar → app.asar.unpacked so dlopen sees a real on-disk path.
    // Electron patches require() to redirect ASAR paths but sqlite3_load_extension
    // calls dlopen() directly, which has no knowledge of ASAR.
    if (extPath.includes('app.asar' + path.sep)) {
      extPath = extPath.split('app.asar' + path.sep).join('app.asar.unpacked' + path.sep)
    }

    // Strip .dylib: better-sqlite3 passes the path to sqlite3_load_extension which
    // appends the platform suffix on macOS when the path does not already have it.
    // When the resolved path already ends in .dylib and the suffix is added again,
    // the resulting vec0.dylib.dylib does not exist → ENOENT.
    if (extPath.endsWith('.dylib')) {
      extPath = extPath.slice(0, -'.dylib'.length)
    }

    db.loadExtension(extPath)
    return true
  } catch (fallbackErr) {
    console.error('[loadSqliteVec] Fallback loader failed:', fallbackErr)
    return false
  }
}

/**
 * Returns true if the sqlite-vec extension has been successfully loaded into
 * the database for this process. Set by ensureVecLoaded().
 */
export function isVecAvailable(): boolean {
  return _vecAvailable
}

/**
 * Attempt to load the sqlite-vec extension once per process lifetime.
 * Sets the `isVecAvailable()` flag.
 * Logs exactly ONE [RAG] warning on failure; never throws.
 */
export function ensureVecLoaded(db: Database.Database): void {
  if (_loadAttempted) return
  _loadAttempted = true
  try {
    _vecAvailable = loadSqliteVec(db)
    if (!_vecAvailable) {
      console.warn(
        '[RAG] sqlite-vec extension failed to load — ' +
        'vector index will be unavailable (D10: FTS5-only retrieval active).'
      )
    } else {
      console.log('[RAG] sqlite-vec extension loaded successfully.')
    }
  } catch (err) {
    _vecAvailable = false
    console.warn('[RAG] sqlite-vec load error (non-fatal, FTS5-only retrieval active):', err)
  }
}

/** Exposed for tests only — resets the module-level state so tests can force-reload. */
export function _resetForTests(): void {
  _vecAvailable  = false
  _loadAttempted = false
}
