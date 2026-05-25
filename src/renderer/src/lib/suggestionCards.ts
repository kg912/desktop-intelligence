/**
 * suggestionCards.ts
 *
 * Pure utility functions for the customisable suggestion-card feature.
 * No React, no IPC — plain string transforms that are trivially testable.
 */

export const CARD_SLOT_COUNT = 4

export const DEFAULT_CARDS: string[] = [
  'Explain the math behind transformer self-attention',
  'Write a Rust async file watcher using tokio',
  'Compare RLHF vs DPO for fine-tuning LLMs',
  'Design a RAG pipeline for a 10M-document corpus',
]

/**
 * Given the persisted card list from settings (may be empty = "use defaults"),
 * return the canonical set of cards to display.
 *
 * - Empty array → fall back to DEFAULT_CARDS
 * - 1-4 non-empty strings → use as-is
 */
export function resolveCards(persisted: string[]): string[] {
  const clean = persisted.filter((c) => c.trim().length > 0).slice(0, CARD_SLOT_COUNT)
  return clean.length > 0 ? clean : DEFAULT_CARDS
}

/**
 * Build the fixed-length display slot array (always CARD_SLOT_COUNT entries).
 * Real cards are strings; empty/placeholder slots are null.
 *
 * Used in both view mode and edit mode — callers decide how to render each slot type.
 */
export function buildDisplaySlots(cards: string[]): Array<string | null> {
  const slots: Array<string | null> = []
  for (let i = 0; i < CARD_SLOT_COUNT; i++) {
    slots.push(cards[i] ?? null)
  }
  return slots
}

/**
 * Normalise a draft array (which may include empty strings or nulls) into
 * the persisted format: only non-empty trimmed strings, at most CARD_SLOT_COUNT.
 *
 * Empty or whitespace-only strings are treated as deleted.
 * null values (placeholder slots) are never persisted.
 */
export function normalizeDraft(draft: Array<string | null>): string[] {
  return draft
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    .map((c) => c.trim())
    .slice(0, CARD_SLOT_COUNT)
}

/**
 * Count how many placeholder slots exist in a draft array.
 * Placeholders are null entries or empty/whitespace strings.
 */
export function placeholderCount(draft: Array<string | null>): number {
  return draft.filter(
    (c) => c === null || (typeof c === 'string' && c.trim().length === 0)
  ).length
}
