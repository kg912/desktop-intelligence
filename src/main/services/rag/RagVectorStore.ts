/**
 * RagVectorStore — thin wrapper around the chunks_vec sqlite-vec virtual table.
 *
 * Phase 1: insert, KNN query, and per-chat deletion.
 * All methods check isVecAvailable() first and return no-ops / empty arrays when false.
 *
 * IMPORTANT: vec0 requires BigInt for explicit rowid values.
 * Passing a JS Number raises "Only integers are allowed for primary key values".
 * See Phase 0 spike findings.
 */

import { getDB } from '../DatabaseService'
import { isVecAvailable } from './sqliteVecLoader'

export interface VecInsertRow {
  rowid:     number
  chatId:    string
  embedding: Float32Array
}

export interface VecKnnRow {
  rowid:    number
  distance: number
}

/** Convert a Float32Array to a Buffer suitable for vec0 binding. */
function toBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

/**
 * Insert embedding vectors for a batch of chunk rows.
 * Rowids are passed as BigInt to satisfy vec0's integer-only primary key requirement.
 */
export function insertVectors(rows: VecInsertRow[]): void {
  if (!isVecAvailable() || rows.length === 0) return

  const db   = getDB()
  const stmt = db.prepare(
    'INSERT INTO chunks_vec(rowid, chat_id, embedding) VALUES (?, ?, ?)'
  )
  const tx = db.transaction((items: VecInsertRow[]) => {
    for (const row of items) {
      stmt.run(BigInt(row.rowid), row.chatId, toBuffer(row.embedding))
    }
  })
  tx(rows)
}

/**
 * Run a KNN query on chunks_vec, filtering by chatId via the partition key.
 * Returns up to `k` results in ascending distance order.
 */
export function knn(queryVec: Float32Array, k: number, chatId: string): VecKnnRow[] {
  if (!isVecAvailable()) return []
  const db = getDB()
  return db.prepare(
    'SELECT rowid, distance FROM chunks_vec WHERE chat_id = ? AND embedding MATCH ? AND k = ?'
  ).all(chatId, toBuffer(queryVec), k) as VecKnnRow[]
}

/**
 * Delete all vectors for a chat session.
 */
export function deleteByChat(chatId: string): void {
  if (!isVecAvailable()) return
  try {
    getDB().prepare('DELETE FROM chunks_vec WHERE chat_id = ?').run(chatId)
  } catch (err) {
    console.warn('[RagVectorStore] deleteByChat failed (non-fatal):', err)
  }
}
