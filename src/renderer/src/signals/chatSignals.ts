/**
 * chatSignals — Preact Signals for the streaming chat state machine
 *
 * Fine-grained signals allow surgical re-renders:
 *  • completedMessages / streamingMessage → message-level events only
 *  • streamingBlocks → updated every rAF tick during streaming
 *  • isStreamingSignal → drives InputBar send/abort gate
 *
 * Only components that READ a specific signal re-render when it changes.
 * ChatArea subscribes to streamingBlocks for scroll only; InputBar subscribes
 * to isStreamingSignal directly — neither triggers a full tree re-render on
 * every incoming token.
 */

import { signal, computed } from '@preact/signals-react'
import type { Message } from '../components/chat/MessageBubble'
import type { MessageBlock, GenerationStats } from '../../../shared/types'

// ── Immutable history — append-only, never mutated during streaming ───────────
// Each element is a finalised Message (stream ended or user turn).
export const completedMessages = signal<Message[]>([])

// ── The single in-flight assistant turn — null when idle ─────────────────────
export const streamingMessage = signal<Message | null>(null)

// ── Blocks for the active streaming turn — updated every rAF tick ────────────
// Fine-grained: only components that read this signal re-render on token arrival.
export const streamingBlocks = signal<MessageBlock[]>([])

// ── Stats populated at stream-end — null during streaming ────────────────────
export const streamingStats = signal<GenerationStats | null>(null)

// ── isStreaming — drives InputBar send/abort state ────────────────────────────
export const isStreamingSignal = signal<boolean>(false)

// ── Derived: the full message list for ChatArea to render ─────────────────────
// Only recomputes when completedMessages or streamingMessage changes — not on
// every block update. This means the messages prop to ChatArea only updates on
// message-level events (new turn, stream end, tool call), not on every token.
export const allMessages = computed<Message[]>(() => {
  const sm = streamingMessage.value
  return sm ? [...completedMessages.value, sm] : completedMessages.value
})
