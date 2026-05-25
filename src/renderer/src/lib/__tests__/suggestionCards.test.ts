/**
 * Unit tests for suggestionCards.ts pure utility functions.
 *
 * Guarded invariants:
 *  - resolveCards: empty array → defaults, non-empty → pass-through, excess trimmed to 4
 *  - buildDisplaySlots: always returns CARD_SLOT_COUNT entries; extras become null
 *  - normalizeDraft: empty/null/whitespace treated as deleted; result trimmed
 *  - placeholderCount: counts null + empty string entries
 *  - All-deleted state: normalizeDraft([null,null,null,null]) === []
 *  - Placeholder count is always (CARD_SLOT_COUNT − real cards)
 */

import { describe, it, expect } from 'vitest'
import {
  resolveCards,
  buildDisplaySlots,
  normalizeDraft,
  placeholderCount,
  DEFAULT_CARDS,
  CARD_SLOT_COUNT,
} from '../suggestionCards'

// ─────────────────────────────────────────────────────────────────────────────
// resolveCards
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveCards — default card loading', () => {
  it('returns DEFAULT_CARDS when persisted array is empty', () => {
    expect(resolveCards([])).toEqual(DEFAULT_CARDS)
  })

  it('returns DEFAULT_CARDS when persisted array contains only whitespace', () => {
    expect(resolveCards(['  ', '\t', ''])).toEqual(DEFAULT_CARDS)
  })

  it('passes through a 1-card array unchanged', () => {
    const cards = ['Hello world']
    expect(resolveCards(cards)).toEqual(['Hello world'])
  })

  it('passes through a full 4-card array unchanged', () => {
    const cards = ['A', 'B', 'C', 'D']
    expect(resolveCards(cards)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('trims excess cards beyond 4', () => {
    const cards = ['A', 'B', 'C', 'D', 'E', 'F']
    expect(resolveCards(cards)).toHaveLength(CARD_SLOT_COUNT)
    expect(resolveCards(cards)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('filters out empty strings from a mixed array', () => {
    // Only the non-empty ones survive
    const cards = ['', 'Keep me', '', 'And me']
    expect(resolveCards(cards)).toEqual(['Keep me', 'And me'])
  })

  it('returns DEFAULT_CARDS (not empty array) when all entries are blank', () => {
    const result = resolveCards(['   '])
    expect(result).toBe(DEFAULT_CARDS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildDisplaySlots
// ─────────────────────────────────────────────────────────────────────────────
describe('buildDisplaySlots — always 4 slots', () => {
  it('returns exactly CARD_SLOT_COUNT entries for an empty card list', () => {
    const slots = buildDisplaySlots([])
    expect(slots).toHaveLength(CARD_SLOT_COUNT)
  })

  it('fills remaining slots with null when fewer than 4 cards', () => {
    const slots = buildDisplaySlots(['One', 'Two'])
    expect(slots).toEqual(['One', 'Two', null, null])
  })

  it('returns all nulls when card list is empty (all-deleted state)', () => {
    const slots = buildDisplaySlots([])
    expect(slots).toEqual([null, null, null, null])
  })

  it('returns all 4 real cards when list has exactly 4', () => {
    const cards = ['A', 'B', 'C', 'D']
    const slots = buildDisplaySlots(cards)
    expect(slots).toEqual(['A', 'B', 'C', 'D'])
    expect(slots.filter((s) => s === null)).toHaveLength(0)
  })

  it('placeholder count equals (4 - number of real cards)', () => {
    for (let n = 0; n <= CARD_SLOT_COUNT; n++) {
      const cards = Array.from({ length: n }, (_, i) => `Card ${i}`)
      const slots = buildDisplaySlots(cards)
      const nullCount = slots.filter((s) => s === null).length
      expect(nullCount).toBe(CARD_SLOT_COUNT - n)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// normalizeDraft — save/persist behaviour
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeDraft — save/persist behaviour', () => {
  it('returns empty array when all slots are null (all-deleted state)', () => {
    expect(normalizeDraft([null, null, null, null])).toEqual([])
  })

  it('returns empty array when all slots are empty strings', () => {
    expect(normalizeDraft(['', '', '', ''])).toEqual([])
  })

  it('returns empty array when all slots are whitespace-only', () => {
    expect(normalizeDraft(['  ', '\t', ' \n ', '   '])).toEqual([])
  })

  it('strips null slots from a mixed draft', () => {
    const result = normalizeDraft(['Hello', null, 'World', null])
    expect(result).toEqual(['Hello', 'World'])
  })

  it('strips empty strings from a mixed draft', () => {
    const result = normalizeDraft(['Hello', '', 'World', ''])
    expect(result).toEqual(['Hello', 'World'])
  })

  it('trims whitespace from surviving card strings', () => {
    const result = normalizeDraft(['  Hello  ', null, '  World  ', ''])
    expect(result).toEqual(['Hello', 'World'])
  })

  it('caps result at CARD_SLOT_COUNT even if draft has extra real cards', () => {
    const draft: Array<string | null> = ['A', 'B', 'C', 'D', 'E']
    expect(normalizeDraft(draft)).toHaveLength(CARD_SLOT_COUNT)
  })

  it('preserves a single non-empty card', () => {
    expect(normalizeDraft([null, null, 'Keep', null])).toEqual(['Keep'])
  })

  it('never includes null in result', () => {
    const result = normalizeDraft([null, 'A', null, 'B'])
    expect(result.every((c) => c !== null)).toBe(true)
  })

  it('empty-card-becomes-deleted: whitespace-only card treated same as null', () => {
    const fromNull = normalizeDraft([null, 'A'])
    const fromEmpty = normalizeDraft(['   ', 'A'])
    expect(fromNull).toEqual(fromEmpty)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// placeholderCount
// ─────────────────────────────────────────────────────────────────────────────
describe('placeholderCount', () => {
  it('returns 4 when all slots are null', () => {
    expect(placeholderCount([null, null, null, null])).toBe(4)
  })

  it('returns 4 when all slots are empty strings', () => {
    expect(placeholderCount(['', '', '', ''])).toBe(4)
  })

  it('returns 0 when all slots are real cards', () => {
    expect(placeholderCount(['A', 'B', 'C', 'D'])).toBe(0)
  })

  it('counts mixed null and string placeholders correctly', () => {
    // 2 real + null + empty = 2 placeholders
    expect(placeholderCount(['A', null, 'B', ''])).toBe(2)
  })

  it('returns (4 - real cards) for a buildDisplaySlots result', () => {
    const cards = ['X', 'Y']
    const slots = buildDisplaySlots(cards)
    expect(placeholderCount(slots)).toBe(CARD_SLOT_COUNT - cards.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integration: round-trip save → load
// ─────────────────────────────────────────────────────────────────────────────
describe('round-trip: normalizeDraft → resolveCards', () => {
  it('saving 2 cards and reloading shows those 2 cards, not defaults', () => {
    const draft: Array<string | null> = ['Card A', null, 'Card B', null]
    const saved = normalizeDraft(draft)           // ['Card A', 'Card B']
    const resolved = resolveCards(saved)          // ['Card A', 'Card B']
    expect(resolved).toEqual(['Card A', 'Card B'])
  })

  it('saving empty draft falls back to defaults on next load', () => {
    const draft: Array<string | null> = [null, null, null, null]
    const saved = normalizeDraft(draft)           // []
    const resolved = resolveCards(saved)          // DEFAULT_CARDS
    expect(resolved).toEqual(DEFAULT_CARDS)
  })

  it('saving all-whitespace draft falls back to defaults', () => {
    const draft: Array<string | null> = ['  ', '  ', '  ', '  ']
    const saved = normalizeDraft(draft)
    expect(resolveCards(saved)).toEqual(DEFAULT_CARDS)
  })
})
