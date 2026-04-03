/**
 * ModelStore — global frontend model selection state
 *
 * Provides `selectedModel` (string) and `setSelectedModel` to the entire
 * renderer tree via React Context.
 *
 * Design goals:
 *   • Single source of truth for the active model — all send-message
 *     paths read from here so switching models in the future requires
 *     only one `setSelectedModel` call anywhere in the UI.
 *   • No external state library — React Context is sufficient for a
 *     single scalar value; add Zustand or Jotai later if the store grows.
 */

import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import type { ThinkingMode } from '../../../shared/types'

// ── Types ────────────────────────────────────────────────────────
interface ModelStoreValue {
  /** The currently selected LM Studio model identifier */
  selectedModel:    string
  /** Swap the active model — consumed by a future Model Switcher UI */
  setSelectedModel: (modelId: string) => void
  /** Whether the model reasons before answering (Section 5 of CLAUDE.md) */
  thinkingMode:     ThinkingMode
  /** Toggle between thinking and fast mode */
  setThinkingMode:  (mode: ThinkingMode) => void
  /** Context window utilisation from the last completed response; null before first response */
  contextUsage:     { used: number; total: number } | null
  /** Update context utilisation — called from useChat after each stream-end */
  setContextUsage:  (usage: { used: number; total: number } | null) => void
}

// ── Context ──────────────────────────────────────────────────────
const ModelStoreContext = createContext<ModelStoreValue | null>(null)

// ── Provider ─────────────────────────────────────────────────────
export function ModelStoreProvider({ children }: { children: ReactNode }) {
  // Intentionally empty string — App.tsx populates this via setSelectedModel
  // once it has read the saved modelId from SettingsStore (IPC round-trip).
  const [selectedModel,  setSelectedModel]  = useState<string>('')
  const [thinkingMode,   setThinkingMode]   = useState<ThinkingMode>('fast')
  const [contextUsage,   setContextUsage]   = useState<{ used: number; total: number } | null>(null)

  return (
    <ModelStoreContext.Provider value={{ selectedModel, setSelectedModel, thinkingMode, setThinkingMode, contextUsage, setContextUsage }}>
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
