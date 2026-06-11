/**
 * Phase 0 spike — Vitest harness validation for sqlite-vec
 *
 * Proves the sqlite-vec extension loads inside the Vitest test environment.
 * Later phases depend on the test harness being able to load the extension;
 * this test locks that behaviour in first.
 *
 * TEMPORARY — Phase 0 spike, removed in RAG v2 Phase 5.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { loadSqliteVec } from '../../../../scripts/spike-sqlite-vec'

function randomFloat32Array(dim: number): Float32Array {
  const arr = new Float32Array(dim)
  for (let i = 0; i < dim; i++) arr[i] = Math.random() * 2 - 1
  return arr
}

function vecBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

describe('sqlite-vec Phase 0 spike — Vitest harness', () => {
  let db: Database.Database

  beforeAll(() => {
    db = new Database(':memory:')
  })

  it('loadSqliteVec() returns true on an in-memory DB', () => {
    const ok = loadSqliteVec(db)
    expect(ok).toBe(true)
  })

  it('vec_version() is defined and non-empty after load', () => {
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string }
    expect(typeof row.v).toBe('string')
    expect(row.v.length).toBeGreaterThan(0)
  })

  it('can create a vec0(embedding float[384]) virtual table', () => {
    expect(() => {
      db.exec('CREATE VIRTUAL TABLE vitest_vec USING vec0(embedding float[384])')
    }).not.toThrow()
  })

  it('inserts 10 random 384-dim vectors without error', () => {
    const stmt = db.prepare('INSERT INTO vitest_vec(embedding) VALUES (?)')
    const tx = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        stmt.run(vecBuffer(randomFloat32Array(384)))
      }
    })
    expect(() => tx(10)).not.toThrow()
  })

  it('KNN query returns 5 rows ordered by ascending distance', () => {
    const query = vecBuffer(randomFloat32Array(384))
    const rows = db.prepare(
      'SELECT rowid, distance FROM vitest_vec WHERE embedding MATCH ? AND k = 5'
    ).all(query) as Array<{ rowid: number; distance: number }>

    expect(rows).toHaveLength(5)
    // Distances must be non-negative
    for (const row of rows) {
      expect(row.distance).toBeGreaterThanOrEqual(0)
    }
    // Must be in ascending distance order
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].distance).toBeGreaterThanOrEqual(rows[i - 1].distance)
    }
  })
})
