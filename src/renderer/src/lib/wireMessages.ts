/**
 * wireMessages — pure wire-payload assembly extracted from useChat.ts
 *
 * Zero React imports. Converts the renderer's Message[] into the flat
 * WireMessage[] array that is sent over IPC to LM Studio.
 *
 * Extracted as a pure function so it can be unit-tested without a React
 * environment or mock API.
 */

import type { WireMessage, MessageBlock } from '../../../shared/types'
import type { Message } from '../components/chat/MessageBubble'

/**
 * Converts the renderer's message history into LM-Studio-compatible wire messages.
 *
 * Rules:
 *  - 'divider' messages are filtered out (they are UI-only markers).
 *  - Messages with a done search block emit two wire messages:
 *      1. assistant turn with tool_calls[]
 *      2. tool turn with the search result content
 *  - For the LAST tool-call turn: full formattedContent is sent.
 *    For older turns: a short stub is sent to save context tokens.
 *  - Legacy message.toolCall field is handled identically to the block path.
 *
 * @param messages      The renderer's message array (may include dividers)
 * @param genToolCallId Optional id generator — default uses Date.now()+random.
 *                      Pass a deterministic generator in tests.
 */
export function buildWireMessages(
  messages:       Message[],
  genToolCallId?: () => string,
): WireMessage[] {
  const makeId =
    genToolCallId ??
    (() => `call_${Date.now()}_${Math.random().toString(36).substring(7)}`);

  const filtered = messages.filter((m) => m.role !== 'divider');

  // Locate the last message that has a tool-call result (block or legacy).
  // Earlier tool calls receive a stub to avoid re-polluting context.
  const lastToolCallIndex = filtered.reduce((last, m, i) => {
    const hasBlockSearch = m.blocks?.some(
      (b) => b.type === 'search' && b.phase === 'done',
    );
    return hasBlockSearch || m.toolCall ? i : last;
  }, -1);

  return filtered.flatMap((m, i): WireMessage[] => {
    // ── v2.1 block-based path ────────────────────────────────────────────────
    const doneSearchBlock = m.blocks
      ?.slice()
      .reverse()
      .find(
        (b): b is Extract<MessageBlock, { type: 'search' }> =>
          b.type === 'search' && b.phase === 'done',
      );

    if (doneSearchBlock) {
      const isLast      = i === lastToolCallIndex;
      const funcName    = doneSearchBlock.toolName ?? 'brave_web_search';
      const funcArgs    =
        funcName === 'brave_web_search'
          ? JSON.stringify({ query: doneSearchBlock.query })
          : JSON.stringify({});
      const resultText  = isLast
        ? doneSearchBlock.formattedContent ||
          JSON.stringify(doneSearchBlock.results?.slice(0, 3) ?? [])
        : `[Previous tool call: ${doneSearchBlock.toolName ?? doneSearchBlock.query}]`;
      const id = makeId();

      return [
        {
          role:       m.role as 'user' | 'assistant',
          content:    m.content,
          tool_calls: [{ id, type: 'function', function: { name: funcName, arguments: funcArgs } }],
        },
        {
          role:         'tool',
          tool_call_id: id,
          content:      resultText,
        },
      ];
    }

    // ── Legacy toolCall field path ────────────────────────────────────────────
    if (m.toolCall) {
      const isLast     = i === lastToolCallIndex;
      const resultText = isLast
        ? m.toolCall.formattedContent ||
          JSON.stringify(m.toolCall.results?.slice(0, 3) ?? [])
        : `[Previous search: ${m.toolCall.query}]`;
      const id = makeId();

      return [
        {
          role:       m.role as 'user' | 'assistant',
          content:    m.content,
          tool_calls: [
            {
              id,
              type:     'function',
              function: {
                name:      'brave_web_search',
                arguments: JSON.stringify({ query: m.toolCall.query }),
              },
            },
          ],
        },
        {
          role:         'tool',
          tool_call_id: id,
          content:      resultText,
        },
      ];
    }

    // ── Plain message ─────────────────────────────────────────────────────────
    return [{ role: m.role as 'user' | 'assistant', content: m.content }];
  });
}
