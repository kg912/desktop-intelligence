/**
 * Pure helpers for handlers.ts — extracted so they can be unit-tested
 * (handlers.ts itself registers ipcMain handlers and has no tests).
 */
import type { ConnectionState, DaemonState } from '../../shared/types'
import type { AppSettings } from '../services/SettingsStore'
import { normalizeWebSearchSettings, EXA_TYPES } from '../../shared/webSearch'
import type { WebSearchSettingsPayload } from '../../shared/webSearch'

/** Synthetic always-ready connection state for a cloud provider. */
export function cloudModelState(
  s: Pick<AppSettings, 'nvidiaModel' | 'ollamaModel' | 'openrouterModel'>,
  bp: string,
): ConnectionState {
  const [id, owned_by] =
    bp === 'nvidia' ? [s.nvidiaModel ?? 'mistralai/mistral-medium-3.5-128b', 'nvidia'] :
    bp === 'ollama' ? [s.ollamaModel ?? 'ollama', 'ollama'] :
    [s.openrouterModel ?? 'anthropic/claude-sonnet-4', 'openrouter']
  return {
    status:         'ready',
    modelInfo:      { id, object: 'model', created: 0, owned_by },
    lastChecked:    Date.now(),
    error:          null,
    pollIntervalMs: 0,
  }
}

/** Synthetic 'ready' daemon state for backends whose daemon is not in use. */
export const daemonReady = (): DaemonState => ({ phase: 'ready', error: null, stderr: null })

/** Arguments after `lms load`. --gpu max offloads all layers to GPU. */
export const buildLmsLoadArgs = (modelId: string, gpuOffload: boolean | undefined, ctx: number): string[] =>
  [modelId, ...(gpuOffload ? ['--gpu', 'max'] : []), '--context-length', String(ctx)]

/**
 * Drops keys whose value is undefined (keeps null, 0, '' and false).
 * writeSettings() erases a key given undefined, so settings patches go through this.
 */
export function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

const EOS_RE = /<\|(?:endoftext|im_end|eot_id|end)\|>/gi

/** Strips EOS special tokens from string content; unchanged messages keep their reference. */
export function stripEosFromMessages<T extends { content: unknown }>(msgs: T[]): T[] {
  return msgs.map((m) => {
    if (typeof m.content !== 'string') return m
    const content = m.content.replace(EOS_RE, '')
    return content === m.content ? m : { ...m, content }
  })
}

/** Settings > Web Search as the renderer sees it: saved values with defaults (old files have no Exa fields). */
export function webSearchSettingsPayload(s: AppSettings): WebSearchSettingsPayload {
  const ws = normalizeWebSearchSettings(s)
  return {
    braveEnabled:               s.braveSearchEnabled         ?? false,
    braveApiKey:                s.braveSearchApiKey          ?? '',
    maxSearchLoops:             s.maxSearchLoops             ?? 4,
    keepSearchResultsInContext: s.keepSearchResultsInContext ?? false,
    webSearchProvider:          ws.provider,
    exaApiKey:                  s.exaApiKey                  ?? '',
    exaSearchType:              ws.exaSearchType,
    exaContentMode:             ws.exaContentMode,
    exaMaxCharacters:           ws.exaMaxCharacters,
    exaNumResults:              ws.exaNumResults,
    exaFreshness:               ws.exaFreshness,
  }
}

/**
 * A save from the renderer, validated in the main process: unknown provider / type / mode /
 * freshness values are dropped (the saved value stays), numbers are clamped to their ranges,
 * and undefined fields are left out (writeSettings would erase them).
 */
export function sanitizeWebSearchPatch(patch: Partial<WebSearchSettingsPayload>): Partial<AppSettings> {
  const clamped = normalizeWebSearchSettings(patch)
  const valid = <T>(v: unknown, ok: boolean, value: T): T | undefined => (v !== undefined && ok ? value : undefined)
  return definedOnly({
    braveSearchEnabled:         typeof patch.braveEnabled === 'boolean' ? patch.braveEnabled : undefined,
    braveSearchApiKey:          typeof patch.braveApiKey === 'string' ? patch.braveApiKey : undefined,
    maxSearchLoops:             typeof patch.maxSearchLoops === 'number' && Number.isFinite(patch.maxSearchLoops)
      ? Math.min(8, Math.max(1, Math.round(patch.maxSearchLoops))) : undefined,
    keepSearchResultsInContext: typeof patch.keepSearchResultsInContext === 'boolean' ? patch.keepSearchResultsInContext : undefined,
    webSearchProvider:          valid(patch.webSearchProvider, patch.webSearchProvider === 'brave' || patch.webSearchProvider === 'exa', clamped.provider),
    exaApiKey:                  typeof patch.exaApiKey === 'string' ? patch.exaApiKey : undefined,
    exaSearchType:              valid(patch.exaSearchType, EXA_TYPES.includes(patch.exaSearchType as never), clamped.exaSearchType),
    exaContentMode:             valid(patch.exaContentMode, patch.exaContentMode === 'highlights' || patch.exaContentMode === 'text', clamped.exaContentMode),
    exaMaxCharacters:           valid(patch.exaMaxCharacters, typeof patch.exaMaxCharacters === 'number' && Number.isFinite(patch.exaMaxCharacters), clamped.exaMaxCharacters),
    exaNumResults:              valid(patch.exaNumResults, typeof patch.exaNumResults === 'number' && Number.isFinite(patch.exaNumResults), clamped.exaNumResults),
    exaFreshness:               valid(patch.exaFreshness, ['default', '24h', 'always'].includes(patch.exaFreshness as string), clamped.exaFreshness),
  })
}
