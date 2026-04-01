/**
 * ContextSliderService — DEPRECATED
 *
 * This service previously performed a 6,000-token budget check and, on
 * overflow, summarised the oldest 50 % of history via a blocking LM Studio
 * call before every turn.
 *
 * It has been superseded by the token-budget trimming built directly into
 * ChatService.buildMessages() which:
 *   • Reads the user's actual configured context window (from SettingsStore)
 *   • Computes a proper budget (ctx - max_output - system_tokens - overhead)
 *   • Walks messages newest→oldest and drops the minimum set needed
 *   • Never blocks on an extra LM Studio round-trip
 *
 * slideIfNeeded() is kept as a no-op stub so any callers that were not yet
 * updated compile without errors.  It will be removed in a future clean-up.
 *
 * Token counting is now in tokenUtils.ts.
 */

import type { WireMessage } from '../../shared/types'

/**
 * @deprecated No-op stub. Token-budget trimming now lives in ChatService.buildMessages().
 */
export async function slideIfNeeded(
  messages:     WireMessage[],
  _systemPrompt: string,
  _modelId:      string
): Promise<WireMessage[]> {
  return messages
}
