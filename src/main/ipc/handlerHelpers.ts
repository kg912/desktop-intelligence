/**
 * Pure helpers for handlers.ts — extracted so they can be unit-tested
 * (handlers.ts itself registers ipcMain handlers and has no tests).
 */
import type { ConnectionState, DaemonState } from '../../shared/types'
import type { AppSettings } from '../services/SettingsStore'

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
