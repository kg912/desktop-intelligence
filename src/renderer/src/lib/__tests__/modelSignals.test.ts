/**
 * modelSignals — tests for contextUsageSignal / contextFillSignal
 *
 * These signals are pure arithmetic with no React or DOM dependencies.
 * The tests write directly to contextUsageSignal and assert contextFillSignal.value,
 * verifying both the computed formula and signal reactivity.
 */

// Import from the pure .ts sidecar (not ModelStore.tsx) so vitest's node
// environment can parse the file without encountering JSX syntax.
// ModelStore.tsx re-exports both names — consumers use 'from ModelStore'.
import { contextUsageSignal, contextFillSignal, isCompactingSignal } from '../../store/runtimeSignals'

// Reset to initial state between tests so writes in one case don't bleed into the next.
beforeEach(() => {
  contextUsageSignal.value = { used: 0, total: 0 }
})

describe('contextFillSignal arithmetic', () => {
  test('1. initial state: used=0, total=0 → fill is 0', () => {
    contextUsageSignal.value = { used: 0, total: 0 }
    expect(contextFillSignal.value).toBe(0)
  })

  test('2. used=500, total=1000 → fill is 0.5', () => {
    contextUsageSignal.value = { used: 500, total: 1000 }
    expect(contextFillSignal.value).toBe(0.5)
  })

  test('3. used=1000, total=1000 → fill is exactly 1.0 (full)', () => {
    contextUsageSignal.value = { used: 1000, total: 1000 }
    expect(contextFillSignal.value).toBe(1)
  })

  test('4. overflow capped: used=1200, total=1000 → fill is 1.0 (not 1.2)', () => {
    contextUsageSignal.value = { used: 1200, total: 1000 }
    expect(contextFillSignal.value).toBe(1)
  })

  test('5. zero-total guard: used=500, total=0 → fill is 0 (no division by zero)', () => {
    contextUsageSignal.value = { used: 500, total: 0 }
    expect(contextFillSignal.value).toBe(0)
  })

  test('6. used=0, total=4096 → fill is 0', () => {
    contextUsageSignal.value = { used: 0, total: 4096 }
    expect(contextFillSignal.value).toBe(0)
  })

  test('7. signal is reactive: writing a new value immediately updates contextFillSignal.value', () => {
    contextUsageSignal.value = { used: 100, total: 1000 }
    expect(contextFillSignal.value).toBeCloseTo(0.1)

    // Write a new value — no React render cycle involved
    contextUsageSignal.value = { used: 800, total: 1000 }
    expect(contextFillSignal.value).toBeCloseTo(0.8)
  })
})

describe('isCompactingSignal', () => {
  beforeEach(() => {
    isCompactingSignal.value = false
  })

  test('8. initial state is false', () => {
    expect(isCompactingSignal.value).toBe(false)
  })

  test('9. can be set to true', () => {
    isCompactingSignal.value = true
    expect(isCompactingSignal.value).toBe(true)
  })

  test('10. returns to false after being reset', () => {
    isCompactingSignal.value = true
    isCompactingSignal.value = false
    expect(isCompactingSignal.value).toBe(false)
  })
})
