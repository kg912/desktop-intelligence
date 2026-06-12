/**
 * RerankerService tests — Phase 3
 *
 * All tests use an injectable scoreFn stub; the real model is NEVER downloaded.
 */

import { describe, it, expect } from 'vitest'
import { rerank } from '../RerankerService'
import type { RerankerScoreFn } from '../RerankerService'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stub that returns passages in the order given, with scores descending from 1.0. */
function makeStubbedScoreFn(rowidOrder: number[]): RerankerScoreFn {
  return async (_query, _passages) =>
    rowidOrder.map((rowid, i) => ({ rowid, score: 1.0 - i * 0.1 }))
}

/** Stub that returns a fixed score for each passage. */
function makeFixedScoreFn(scores: Map<number, number>): RerankerScoreFn {
  return async (_query, passages) =>
    passages
      .map(p => ({ rowid: p.rowid, score: scores.get(p.rowid) ?? 0 }))
      .sort((a, b) => b.score - a.score)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('rerank — empty input', () => {
  it('returns empty array when passages is empty', async () => {
    const result = await rerank('any query', [], async () => [])
    expect(result).toEqual([])
  })
})

describe('rerank — injectable scoreFn', () => {
  it('uses scoreFn result directly and returns it', async () => {
    const passages = [
      { rowid: 10, content: 'alpha passage' },
      { rowid: 20, content: 'beta passage' },
      { rowid: 30, content: 'gamma passage' },
    ]
    const expected = [
      { rowid: 20, score: 0.95 },
      { rowid: 10, score: 0.80 },
      { rowid: 30, score: 0.30 },
    ]
    const stubFn: RerankerScoreFn = async () => expected
    const result = await rerank('query', passages, stubFn)
    expect(result).toEqual(expected)
  })

  it('result is sorted descending by score', async () => {
    const passages = [
      { rowid: 1, content: 'low relevance' },
      { rowid: 2, content: 'high relevance' },
      { rowid: 3, content: 'medium relevance' },
    ]
    const scores = new Map([[1, 0.1], [2, 0.9], [3, 0.5]])
    const result = await rerank('query', passages, makeFixedScoreFn(scores))

    expect(result[0].rowid).toBe(2)   // highest score
    expect(result[1].rowid).toBe(3)
    expect(result[2].rowid).toBe(1)   // lowest score
    expect(result[0].score).toBeGreaterThan(result[1].score)
    expect(result[1].score).toBeGreaterThan(result[2].score)
  })

  it('preserves rowid ordering from stubbed scoreFn exactly', async () => {
    const passages = [
      { rowid: 101, content: 'a' },
      { rowid: 102, content: 'b' },
      { rowid: 103, content: 'c' },
    ]
    // Stub inverts the order: 103 > 102 > 101
    const stubFn = makeStubbedScoreFn([103, 102, 101])
    const result = await rerank('query', passages, stubFn)
    expect(result.map(r => r.rowid)).toEqual([103, 102, 101])
  })

  it('single passage returned as single-element array', async () => {
    const passages = [{ rowid: 99, content: 'only one' }]
    const stubFn: RerankerScoreFn = async () => [{ rowid: 99, score: 0.7 }]
    const result = await rerank('query', passages, stubFn)
    expect(result).toHaveLength(1)
    expect(result[0].rowid).toBe(99)
    expect(result[0].score).toBe(0.7)
  })
})
