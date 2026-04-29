/**
 * ModelStore — global frontend model selection and runtime state
 *
 * Split into two contexts to eliminate unnecessary re-renders during streaming:
 *
 *   ModelConfigContext  — stable, changes rarely (model selection, thinking mode).
 *                         Components that only need these fields subscribe here and
 *                         are never re-rendered by streaming state changes.
 *
 *   ModelRuntimeContext — volatile setters only; reads come from signals directly
 *                         (contextUsageSignal, isCompactingSignal, contextFillSignal).
 *
 * Backward-compatibility:
 *   useModelStore() merges both contexts and returns all 12 fields unchanged —
 *   existing callers (TopBar, Layout, SettingsModal, …) require zero changes.
 *
 * New granular hooks:
 *   useModelConfig()   — subscribes only to ModelConfigContext
 *   useModelRuntime()  — subscribes only to ModelRuntimeContext
 */

import { createContext, useContext, useState, useCallback } from "react";
import type { ReactNode } from "react";
import type { ThinkingMode } from "../../../shared/types";

// ── Runtime signals (re-exported from pure .ts sidecar) ─────────
// Defined in runtimeSignals.ts so vitest's node environment can test them
// without JSX parse errors. Re-exported here so all consumers use a single
// import path: import { contextUsageSignal, … } from '../store/ModelStore'
export { contextUsageSignal, isCompactingSignal, contextFillSignal } from './runtimeSignals'
import { contextUsageSignal, isCompactingSignal } from './runtimeSignals'

// ── Types ────────────────────────────────────────────────────────

/** Stable config that changes at most once per session. */
interface ModelConfigValue {
  /** The currently selected LM Studio model identifier */
  selectedModel: string;
  setSelectedModel: (modelId: string) => void;
  /** Whether the model reasons before answering (Section 5 of CLAUDE.md) */
  thinkingMode: ThinkingMode;
  setThinkingMode: (mode: ThinkingMode) => void;
}

/** Volatile runtime state that changes during/after streaming. */
interface ModelRuntimeValue {
  /** Write context-window utilisation — reads come from contextUsageSignal directly */
  setContextUsage: (value: { used: number; total: number } | ((prev: { used: number; total: number }) => { used: number; total: number })) => void;
  /** Write compaction state — reads come from isCompactingSignal directly */
  setIsCompacting: (v: boolean) => void;
  /** Toast shown after compaction completes; null when hidden */
  compactToast: { tokensBefore: number; tokensAfter: number; hasDocuments: boolean } | null;
  setCompactToast: (v: { tokensBefore: number; tokensAfter: number; hasDocuments: boolean } | null) => void;
  /** True while the model is being reloaded (unload → load cycle) */
  isReloading: boolean;
  setIsReloading: (v: boolean) => void;
}

/** Combined interface — structurally identical to the original ModelStoreValue. */
interface ModelStoreValue extends ModelConfigValue, ModelRuntimeValue {}

// ── Contexts ─────────────────────────────────────────────────────
const ModelConfigContext  = createContext<ModelConfigValue  | null>(null);
const ModelRuntimeContext = createContext<ModelRuntimeValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────
export function ModelStoreProvider({ children }: { children: ReactNode }) {
  // Intentionally empty string — App.tsx populates this via setSelectedModel
  // once it has read the saved modelId from SettingsStore (IPC round-trip).
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [thinkingMode,  setThinkingMode]  = useState<ThinkingMode>("thinking");

  const [compactToast, setCompactToast] = useState<{
    tokensBefore: number;
    tokensAfter: number;
    hasDocuments: boolean;
  } | null>(null);
  const [isReloading, setIsReloading] = useState<boolean>(false);

  // ── Setters that write directly to signals ───────────────────────
  // contextUsage and isCompacting have been fully migrated to signals.
  // Callers retain the same API; signals are the single source of truth.
  const setContextUsage = useCallback(
    (value: { used: number; total: number } | ((prev: { used: number; total: number }) => { used: number; total: number })) => {
      contextUsageSignal.value = typeof value === 'function'
        ? value(contextUsageSignal.value)
        : value
    },
    []
  )
  const setIsCompacting = useCallback((value: boolean) => {
    isCompactingSignal.value = value
  }, [])

  const configValue: ModelConfigValue = {
    selectedModel,
    setSelectedModel,
    thinkingMode,
    setThinkingMode,
  };

  const runtimeValue: ModelRuntimeValue = {
    setContextUsage,
    setIsCompacting,
    compactToast,
    setCompactToast,
    isReloading,
    setIsReloading,
  };

  return (
    <ModelConfigContext.Provider value={configValue}>
      <ModelRuntimeContext.Provider value={runtimeValue}>
        {children}
      </ModelRuntimeContext.Provider>
    </ModelConfigContext.Provider>
  );
}

// ── Compatibility shim ────────────────────────────────────────────
/**
 * Returns all model state fields (config + runtime) merged into one object.
 * Existing callers require zero changes. Subscribes to both contexts, so
 * it re-renders on any field change — use useModelConfig() / useModelRuntime()
 * for components that only need a subset.
 */
export function useModelStore(): ModelStoreValue {
  const config  = useContext(ModelConfigContext);
  const runtime = useContext(ModelRuntimeContext);
  if (!config || !runtime) {
    throw new Error("useModelStore must be used within <ModelStoreProvider>");
  }
  return { ...config, ...runtime };
}

// ── Granular hooks ────────────────────────────────────────────────

/**
 * Subscribe only to stable config fields: selectedModel, thinkingMode.
 * Components using this hook are never re-rendered by streaming state changes.
 */
export function useModelConfig(): ModelConfigValue {
  const ctx = useContext(ModelConfigContext);
  if (!ctx) {
    throw new Error("useModelConfig must be used within <ModelStoreProvider>");
  }
  return ctx;
}

/**
 * Subscribe only to volatile runtime setters and remaining React state:
 * setContextUsage, setIsCompacting, compactToast, isReloading.
 * For reads use contextUsageSignal / isCompactingSignal / contextFillSignal.
 */
export function useModelRuntime(): ModelRuntimeValue {
  const ctx = useContext(ModelRuntimeContext);
  if (!ctx) {
    throw new Error("useModelRuntime must be used within <ModelStoreProvider>");
  }
  return ctx;
}
