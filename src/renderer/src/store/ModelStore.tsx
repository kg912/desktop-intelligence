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

import { createContext, useContext, useState } from "react";
import type { ReactNode, SetStateAction } from "react";
import type { ThinkingMode } from "../../../shared/types";

// ── Types ────────────────────────────────────────────────────────
interface ModelStoreValue {
  /** The currently selected LM Studio model identifier */
  selectedModel: string;
  /** Swap the active model — consumed by a future Model Switcher UI */
  setSelectedModel: (modelId: string) => void;
  /** Whether the model reasons before answering (Section 5 of CLAUDE.md) */
  thinkingMode: ThinkingMode;
  /** Toggle between thinking and fast mode */
  setThinkingMode: (mode: ThinkingMode) => void;
  /** Context window utilisation; starts at {used:0, total:0} until model config is loaded */
  contextUsage: { used: number; total: number };
  /** Update context utilisation — called from useChat after each stream-end */
  setContextUsage: React.Dispatch<
    React.SetStateAction<{ used: number; total: number }>
  >;
  /** True while a manual context compaction is in progress */
  isCompacting: boolean;
  setIsCompacting: (v: boolean) => void;
  /** Toast shown after compaction completes; null when hidden */
  compactToast: { tokensBefore: number; tokensAfter: number; hasDocuments: boolean } | null;
  setCompactToast: (v: { tokensBefore: number; tokensAfter: number; hasDocuments: boolean } | null) => void;
  /** True while the model is being reloaded (unload → load cycle) */
  isReloading: boolean;
  setIsReloading: (v: boolean) => void;
}

// ── Context ──────────────────────────────────────────────────────
const ModelStoreContext = createContext<ModelStoreValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────
export function ModelStoreProvider({ children }: { children: ReactNode }) {
  // Intentionally empty string — App.tsx populates this via setSelectedModel
  // once it has read the saved modelId from SettingsStore (IPC round-trip).
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("thinking");
  const [contextUsage, setContextUsage] = useState<{
    used: number;
    total: number;
  }>({ used: 0, total: 0 });
  const [isCompacting,  setIsCompacting]  = useState<boolean>(false);
  const [compactToast,  setCompactToast]  = useState<{ tokensBefore: number; tokensAfter: number; hasDocuments: boolean } | null>(null);
  const [isReloading,   setIsReloading]   = useState<boolean>(false);

  return (
    <ModelStoreContext.Provider
      value={{
        selectedModel,
        setSelectedModel,
        thinkingMode,
        setThinkingMode,
        contextUsage,
        setContextUsage,
        isCompacting,
        setIsCompacting,
        compactToast,
        setCompactToast,
        isReloading,
        setIsReloading,
      }}
    >
      {children}
    </ModelStoreContext.Provider>
  );
}

// ── Hook ─────────────────────────────────────────────────────────
/**
 * Returns the current model selection state.
 * Must be called from within a <ModelStoreProvider> subtree.
 */
export function useModelStore(): ModelStoreValue {
  const ctx = useContext(ModelStoreContext);
  if (!ctx) {
    throw new Error("useModelStore must be used within <ModelStoreProvider>");
  }
  return ctx;
}
