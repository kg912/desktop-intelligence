/**
 * runtimeSignals — module-level Preact Signals for ModelStore volatile state.
 *
 * Defined in a pure .ts file (no JSX) so vitest's node environment can import
 * and test them directly without triggering JSX parse errors from ModelStore.tsx.
 *
 * ModelStore.tsx re-exports all three names so every consumer continues to use
 * a single import path:  import { contextUsageSignal, … } from '../store/ModelStore'
 *
 * The dual-write useEffect hooks in ModelStoreProvider keep these signals in sync
 * with the React state so both the old context path and the new signal path are
 * always consistent.
 */

import { signal, computed } from '@preact/signals-react'

/** Token usage for the context bar. Updated once per completed assistant turn. */
export const contextUsageSignal = signal<{ used: number; total: number }>({
  used: 0,
  total: 0,
})

/** True while the context-compaction rewrite is running. */
export const isCompactingSignal = signal<boolean>(false)

/** Derived: 0–1 fill fraction for the context bar. */
export const contextFillSignal = computed<number>(() => {
  const { used, total } = contextUsageSignal.value
  return total > 0 ? Math.min(used / total, 1) : 0
})
