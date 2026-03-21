/**
 * ModelStore — global frontend model selection state
 *
 * Provides `selectedModel` (string) and `setSelectedModel` to the entire
 * renderer tree via React Context.
 *
 * Design goals:
 *   • Zero-latency display on startup — `selectedModel` defaults to
 *     DEFAULT_MODEL_ID so UI components show the correct model name
 *     immediately, before any IPC round-trip completes.
 *   • Single source of truth for the active model — all send-message
 *     paths read from here so switching models in the future requires
 *     only one `setSelectedModel` call anywhere in the UI.
 *   • No external state library — React Context is sufficient for a
 *     single scalar value; add Zustand or Jotai later if the store grows.
 */

import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_MODEL_ID } from '../../../shared/types'

// ── Types ────────────────────────────────────────────────────────
interface ModelStoreValue {
  /** The currently selected LM Studio model identifier */
  selectedModel:    string
  /** Swap the active model — consumed by a future Model Switcher UI */
  setSelectedModel: (modelId: string) => void
}

// ── Context ──────────────────────────────────────────────────────
const ModelStoreContext = createContext<ModelStoreValue | null>(null)

// ── Provider ─────────────────────────────────────────────────────
export function ModelStoreProvider({ children }: { children: ReactNode }) {
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_ID)

  return (
    <ModelStoreContext.Provider value={{ selectedModel, setSelectedModel }}>
      {children}
    </ModelStoreContext.Provider>
  )
}

// ── Hook ─────────────────────────────────────────────────────────
/**
 * Returns the current model selection state.
 * Must be called from within a <ModelStoreProvider> subtree.
 */
export function useModelStore(): ModelStoreValue {
  const ctx = useContext(ModelStoreContext)
  if (!ctx) {
    throw new Error('useModelStore must be used within <ModelStoreProvider>')
  }
  return ctx
}
