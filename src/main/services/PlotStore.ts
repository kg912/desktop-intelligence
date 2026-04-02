/**
 * PlotStore — Main process
 *
 * Persists matplotlib chart renders so they can be retrieved later without
 * replaying the (potentially large) base64 PNG in the context window.
 *
 * Storage layout:
 *   SQLite: plot_store table (see DatabaseService migration)
 *   Disk:   <userData>/plots/<uuid>.png
 *
 * Retrieval uses simple keyword scoring over `code` + `caption` columns —
 * no embedding model required.  The code block itself is a perfect text
 * description of the chart it generates (plt.title, variable names, etc.).
 */

import path from 'path'
import fs   from 'fs'
import { app } from 'electron'
import crypto from 'crypto'
import { getDB } from './DatabaseService'

export interface PlotRecord {
  id:        string
  chatId:    string
  code:      string
  imagePath: string
  caption:   string
  ts:        number
}

// ── Internal helpers ─────────────────────────────────────────────

function plotsDir(): string {
  const dir = path.join(app.getPath('userData'), 'plots')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Words that appear in almost every "find my chart" query — they add
// no discriminative signal when matching against stored code/captions.
const STOP_WORDS = new Set([
  'that', 'this', 'show', 'the', 'chart', 'graph', 'plot', 'earlier',
  'previous', 'from', 'with', 'about', 'last', 'some', 'data', 'me',
  'what', 'was', 'look', 'like', 'find', 'recall', 'again', 'can',
  'you', 'did', 'made', 'generated', 'created',
])

// ── Public API ───────────────────────────────────────────────────

/**
 * Persist a rendered chart.
 * Writes the PNG to disk and inserts a metadata row into SQLite.
 * Returns the new plot id.
 */
export function savePlot(
  chatId:      string,
  code:        string,
  imageBase64: string,
  caption:     string
): string {
  const id        = crypto.randomUUID()
  const imagePath = path.join(plotsDir(), `${id}.png`)

  try {
    const buf = Buffer.from(imageBase64, 'base64')
    fs.writeFileSync(imagePath, buf)
  } catch (err) {
    console.error('[PlotStore] Failed to write PNG:', err)
    throw err
  }

  const ts = Date.now()
  getDB()
    .prepare(
      `INSERT INTO plot_store (id, chat_id, code, image_path, caption, ts)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, chatId, code, imagePath, caption, ts)

  console.log(`[PlotStore] ✅ Saved plot ${id} for chat ${chatId} (caption: "${caption}")`)
  return id
}

/**
 * Find the most relevant stored plots for a given query string.
 * Returns up to 2 results scored by keyword overlap with code + caption.
 * Falls back to the most recent plot if no keywords match.
 */
export function searchPlots(chatId: string, query: string): PlotRecord[] {
  const rows = getDB()
    .prepare(
      `SELECT id, chat_id, code, image_path, caption, ts
       FROM plot_store WHERE chat_id = ? ORDER BY ts DESC LIMIT 20`
    )
    .all(chatId) as Array<{
      id: string; chat_id: string; code: string
      image_path: string; caption: string; ts: number
    }>

  if (rows.length === 0) return []

  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))

  if (keywords.length === 0) {
    // No discriminative keywords — return most recent
    return [toRecord(rows[0])]
  }

  const scored = rows.map(r => {
    const haystack = (r.code + ' ' + r.caption).toLowerCase()
    const score    = keywords.reduce((s, kw) => s + (haystack.includes(kw) ? 1 : 0), 0)
    return { row: r, score }
  })

  const bestScore = Math.max(...scored.map(s => s.score))

  if (bestScore === 0) {
    // No keyword hits — return most recent as fallback
    return [toRecord(rows[0])]
  }

  return scored
    .filter(s => s.score === bestScore)
    .slice(0, 2)
    .map(s => toRecord(s.row))
}

/** Retrieve a single plot by id; returns null if not found. */
export function getPlot(id: string): PlotRecord | null {
  const row = getDB()
    .prepare(
      'SELECT id, chat_id, code, image_path, caption, ts FROM plot_store WHERE id = ?'
    )
    .get(id) as {
      id: string; chat_id: string; code: string
      image_path: string; caption: string; ts: number
    } | undefined

  return row ? toRecord(row) : null
}

/**
 * Delete all plots for a chat (called when the chat is deleted).
 * Removes PNG files from disk and rows from the DB.
 */
export function deletePlotsForChat(chatId: string): void {
  const rows = getDB()
    .prepare('SELECT image_path FROM plot_store WHERE chat_id = ?')
    .all(chatId) as Array<{ image_path: string }>

  for (const r of rows) {
    try { fs.unlinkSync(r.image_path) } catch { /* file already gone */ }
  }

  getDB().prepare('DELETE FROM plot_store WHERE chat_id = ?').run(chatId)
  console.log(`[PlotStore] Deleted all plots for chat ${chatId} (${rows.length} file(s))`)
}

// ── Type conversion ──────────────────────────────────────────────

function toRecord(r: {
  id: string; chat_id: string; code: string
  image_path: string; caption: string; ts: number
}): PlotRecord {
  return {
    id:        r.id,
    chatId:    r.chat_id,
    code:      r.code,
    imagePath: r.image_path,
    caption:   r.caption,
    ts:        r.ts,
  }
}
