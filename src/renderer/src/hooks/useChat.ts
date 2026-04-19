/**
 * useChat — streaming chat state machine + SQLite persistence
 *
 * State transitions per assistant turn:
 *   idle → thinking → streaming → done
 *                               ↳ (aborted → done)
 *
 * v2.1.0: Append-only block architecture.
 *   Each assistant turn builds a `blocks` array instead of mutating a flat
 *   `content` string. Search notifications, thinking content, and answer text
 *   each become their own typed block appended in arrival order.
 *   Nothing is ever retracted — CHAT_STREAM_RETRACT is gone.
 *
 * ── IS_MOCK detection ────────────────────────────────────────────
 * In Electron with contextIsolation:true the global `electron` object
 * is NOT injected into window, so `'electron' in window` is always
 * false even in the real app.  The reliable signal is the Chromium
 * user-agent string which Electron always appends 'Electron/x.y.z' to.
 * In a plain browser (Vite preview) that substring is absent, so we
 * fall back to the in-memory mock that main.tsx already injected.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useModelStore } from "../store/ModelStore";
import { v4 as uuid } from "uuid";
import type {
  Message,
  MessageAttachment,
} from "../components/chat/MessageBubble";
import type {
  Chat,
  GenerationStats,
  MessageBlock,
  ProcessedAttachment,
  WireMessage,
} from "../../../shared/types";

// ── Environment detection ────────────────────────────────────────
const IS_BROWSER_MOCK = !navigator.userAgent.includes("Electron");

const DEBUG =
  (import.meta as Record<string, unknown> & { env?: { DEV_MODE?: boolean } })
    .env?.DEV_MODE === true;

// ── Empty assistant placeholder ──────────────────────────────────
function makeAssistant(): Message {
  return {
    id: uuid(),
    role: "assistant",
    content: "",
    stats: null,
    isThinking: true,
    isStreaming: false,
    isSearching: false,
    error: null,
    blocks: [],
  };
}

// ── Hook options ─────────────────────────────────────────────────
interface UseChatOptions {
  chatId?: string | null;
  onChatCreated?: (chat: Chat) => void;
}

export function useChat({ chatId = null, onChatCreated }: UseChatOptions = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const { selectedModel, thinkingMode, setContextUsage } = useModelStore();

  const assistantIdRef = useRef<string | null>(null);

  // Think-block timeout guard
  const thinkStartedAt = useRef<number | null>(null);

  const currentChatIdRef = useRef<string | null>(chatId);

  // Accumulates raw streamed answer text for DB persistence at stream-end.
  const streamingContentRef = useRef<string>("");

  // Mirrors the current assistant message's blocks array — updated in sync with
  // every appendBlock / updateLastBlock call so stream-end can read it without
  // a nested setMessages (which would be a React anti-pattern).
  const currentBlocksRef = useRef<MessageBlock[]>([]);

  // Tracks the thinking mode used for the previous turn (divider insertion).
  const prevThinkingModeRef = useRef<"thinking" | "fast">("fast");

  useEffect(() => {
    currentChatIdRef.current = chatId;
  }, [chatId]);

  // ── Block helpers ─────────────────────────────────────────────

  /** Append a new block to the current assistant message's blocks array. */
  const appendBlock = useCallback((block: MessageBlock) => {
    const id = assistantIdRef.current;
    currentBlocksRef.current = [...currentBlocksRef.current, block];
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = {
        ...updated[idx],
        blocks: [...(updated[idx].blocks ?? []), block],
      };
      return updated;
    });
  }, []);

  /** Patch the last block of a given type on the current assistant message. */
  const updateLastBlock = useCallback(
    (type: MessageBlock["type"], patch: Partial<MessageBlock>) => {
      const id = assistantIdRef.current;
      // Update the ref mirror
      const refBlocks = [...currentBlocksRef.current];
      let lastRefIdx = -1;
      for (let i = refBlocks.length - 1; i >= 0; i--) {
        if (refBlocks[i].type === type) { lastRefIdx = i; break; }
      }
      if (lastRefIdx !== -1) {
        refBlocks[lastRefIdx] = { ...refBlocks[lastRefIdx], ...patch } as MessageBlock;
        currentBlocksRef.current = refBlocks;
      }

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) return prev;
        const blocks = [...(prev[idx].blocks ?? [])];
        let lastIdx = -1;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].type === type) {
            lastIdx = i;
            break;
          }
        }
        if (lastIdx === -1) return prev;
        blocks[lastIdx] = { ...blocks[lastIdx], ...patch } as MessageBlock;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], blocks };
        return updated;
      });
    },
    [],
  );

  /** Patch the current assistant message's top-level fields (legacy / isThinking etc.) */
  const patchAssistant = useCallback((patch: Partial<Message>) => {
    const id = assistantIdRef.current;
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], ...patch };
      return updated;
    });
  }, []);

  // ── Register demo trigger only in browser/mock mode ───────────
  useEffect(() => {
    if (!IS_BROWSER_MOCK) return;
    import("../mocks/api.mock").then(({ registerDemoTrigger }) => {
      registerDemoTrigger((text: string) => sendMessage(text));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Subscribe to streaming events from main ───────────────────
  useEffect(() => {
    // ── Chunk: append to the last answer block (create if needed) ─
    const unsubChunk = window.api.onChatStreamChunk((chunk: string) => {
      streamingContentRef.current += chunk;

      if (thinkStartedAt.current === null) {
        thinkStartedAt.current = Date.now();
      }

      // Update currentBlocksRef mirror in sync with state
      const refBlocks = currentBlocksRef.current;
      let lastRefAnswerIdx = -1;
      for (let i = refBlocks.length - 1; i >= 0; i--) {
        if (refBlocks[i].type === "answer") { lastRefAnswerIdx = i; break; }
      }
      if (lastRefAnswerIdx === -1) {
        const newBlock: MessageBlock = { id: uuid(), type: "answer", content: chunk, isStreaming: true };
        currentBlocksRef.current = [...refBlocks, newBlock];
      } else {
        const nb = [...refBlocks];
        const ex = nb[lastRefAnswerIdx] as Extract<MessageBlock, { type: "answer" }>;
        nb[lastRefAnswerIdx] = { ...ex, content: ex.content + chunk, isStreaming: true };
        currentBlocksRef.current = nb;
      }

      const id = assistantIdRef.current;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) return prev;
        // Use currentBlocksRef directly since it was just updated above
        const blocks = currentBlocksRef.current;

        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          blocks,
          content: streamingContentRef.current, // kept for legacy DB persistence
          isThinking: false,
          isStreaming: true,
          isSearching: false,
        };
        return updated;
      });

      // Safety net: force-abort if think block unclosed for >180 s
      if (
        thinkStartedAt.current !== null &&
        streamingContentRef.current.includes("<think>") &&
        !streamingContentRef.current.includes("</think>") &&
        Date.now() - thinkStartedAt.current > 180_000
      ) {
        console.warn("[useChat] ⏱ Think block timeout — forcing stream end");
        window.api.abortChat();
      }
    });

    // ── Tool start: append a new search block ─────────────────────
    const unsubToolStart = window.api.onChatStreamToolStart(
      ({ query }: { query: string }) => {
        appendBlock({
          id: uuid(),
          type: "search",
          query,
          phase: "searching",
        });
        patchAssistant({ isSearching: true, isThinking: false });
      },
    );

    // ── Tool done: update last search block with results ──────────
    const unsubToolDone = window.api.onChatStreamToolDone(
      ({
        query,
        results,
        formattedContent,
      }: {
        query: string;
        results: Array<{ title: string; url: string }>;
        formattedContent: string;
      }) => {
        updateLastBlock("search", {
          phase: "done",
          results,
          formattedContent,
        } as Partial<MessageBlock>);
        patchAssistant({ isSearching: false });
      },
    );

    // ── Tool error: mark last search block as error ───────────────
    const unsubToolError = window.api.onChatStreamToolError(
      ({ query: _q, error }: { query: string; error: string }) => {
        updateLastBlock("search", {
          phase: "error",
          error,
        } as Partial<MessageBlock>);
        patchAssistant({ isSearching: false });
      },
    );

    // ── Stream end ────────────────────────────────────────────────
    const unsubEnd = window.api.onChatStreamEnd((stats: GenerationStats) => {
      const assistantMsgId = assistantIdRef.current;
      const assistantContent = streamingContentRef.current;
      const activeChatId = currentChatIdRef.current;

      if (DEBUG) {
        console.log(
          "[DEBUG useChat streamEnd] contentLen:",
          assistantContent.length,
          "| hasThinkOpen:",
          assistantContent.includes("<think>"),
          "| hasThinkClose:",
          assistantContent.includes("</think>"),
          "| lastCloseIdx:",
          assistantContent.lastIndexOf("</think>"),
          "| first200:",
          assistantContent.slice(0, 200),
        );
        console.log("[DEV][useChat] stream-end stats:", JSON.stringify(stats));
      }

      // Clear in-flight refs before any async work
      assistantIdRef.current = null;
      streamingContentRef.current = "";
      thinkStartedAt.current = null;
      // Finalise blocks: mark last answer block isStreaming: false in both ref and state
      const finalizedBlocks = currentBlocksRef.current.map((b) =>
        b.type === "answer" ? { ...b, isStreaming: false } : b,
      ) as MessageBlock[];
      currentBlocksRef.current = finalizedBlocks;

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === assistantMsgId);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          blocks: finalizedBlocks,
          isThinking: false,
          isStreaming: false,
          isSearching: false,
          stats,
        };
        return updated;
      });
      setIsStreaming(false);

      // Context utilisation bar — preserve exact existing logic
      if (stats.promptTokens) {
        window.api
          .getModelConfig()
          .then((config) => {
            if (DEBUG)
              console.log(
                "[DEV][useChat] setContextUsage ->",
                stats.promptTokens,
                "+",
                stats.answerTokens ?? stats.totalTokens,
                "/",
                config.contextLength,
              );
            setContextUsage({
              used:
                stats.promptTokens! +
                (stats.answerTokens ?? stats.totalTokens ?? 0),
              total: config.contextLength,
            });
          })
          .catch(() => {
            /* non-fatal */
          });
      } else if (DEBUG) {
        console.log(
          "[DEV][useChat] promptTokens missing/falsy — skipping setContextUsage. stats:",
          JSON.stringify(stats),
        );
      }

      // Persist assistant message to SQLite
      if (activeChatId && assistantMsgId && assistantContent) {
        // Read from the ref mirror — avoids a nested setMessages anti-pattern.
        const finalBlocks = currentBlocksRef.current;
        const blocksJson = finalBlocks.length
          ? JSON.stringify(finalBlocks)
          : null;
        // Derive legacy toolCallJson from the last done search block for backward compat
        const doneBlock = finalBlocks
          .slice()
          .reverse()
          .find(
            (b): b is Extract<MessageBlock, { type: "search" }> =>
              b.type === "search" && b.phase === "done",
          );
        const toolCallJson = doneBlock
          ? JSON.stringify({
              query: doneBlock.query,
              results: doneBlock.results ?? [],
              formattedContent: doneBlock.formattedContent ?? "",
            })
          : null;

        window.api
          .saveMessage(
            activeChatId,
            assistantMsgId,
            "assistant",
            assistantContent,
            undefined,
            toolCallJson,
            blocksJson,
          )
          .catch((err) => console.warn("[DB] save assistant msg failed:", err));
      }
    });

    const unsubErr = window.api.onChatError((msg: string) => {
      const id = assistantIdRef.current;
      assistantIdRef.current = null;
      streamingContentRef.current = "";
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          isThinking: false,
          isStreaming: false,
          isSearching: false,
          error: msg,
        };
        return updated;
      });
      setIsStreaming(false);
    });

    return () => {
      unsubChunk();
      unsubToolStart();
      unsubToolDone();
      unsubToolError();
      unsubEnd();
      unsubErr();
    };
  }, [appendBlock, updateLastBlock, patchAssistant]);

  // ── Send a message ────────────────────────────────────────────
  const sendMessage = useCallback(
    async (
      text: string,
      attachments?: ProcessedAttachment[],
      overrideChatId?: string,
    ) => {
      if (isStreaming) return;

      thinkStartedAt.current = null;

      const msgAttachments: MessageAttachment[] | undefined =
        attachments && attachments.length > 0
          ? attachments.map((a) => ({ name: a.name, type: a.kind }))
          : undefined;

      const userMsg: Message = {
        id: uuid(),
        role: "user",
        content: text,
        stats: null,
        isThinking: false,
        isStreaming: false,
        isSearching: false,
        error: null,
        attachments: msgAttachments,
      };

      const assistantMsg = makeAssistant();
      assistantIdRef.current = assistantMsg.id;
      streamingContentRef.current = "";
      currentBlocksRef.current = [];

      const modeChanged = prevThinkingModeRef.current !== thinkingMode;
      prevThinkingModeRef.current = thinkingMode;

      setMessages((prev) => {
        const dividers: Message[] =
          modeChanged && prev.length > 0
            ? [
                {
                  id: uuid(),
                  role: "divider",
                  content:
                    thinkingMode === "thinking"
                      ? "— Switched to Thinking Mode —"
                      : "— Switched to Fast Mode —",
                  stats: null,
                  isThinking: false,
                  isStreaming: false,
                  isSearching: false,
                  error: null,
                },
              ]
            : [];
        return [...prev, ...dividers, userMsg, assistantMsg];
      });
      setIsStreaming(true);

      let activeChatId = overrideChatId ?? currentChatIdRef.current;

      if (overrideChatId && !currentChatIdRef.current) {
        currentChatIdRef.current = overrideChatId;
        console.log(`[Chat] Using pre-created chat id=${overrideChatId}`);
      } else if (!activeChatId) {
        const newId = uuid();
        const title = text.slice(0, 80).trim() || "New Chat";
        try {
          const chat = await window.api.newChat(newId, title);
          currentChatIdRef.current = chat.id;
          activeChatId = chat.id;
          console.log(
            `[Chat] Created new chat row: id=${chat.id}, title="${chat.title}"`,
          );
          onChatCreated?.(chat);
        } catch (err) {
          console.warn("[DB] newChat failed:", err);
        }
      }

      const attachmentsJson = msgAttachments
        ? JSON.stringify(msgAttachments)
        : null;

      if (activeChatId) {
        window.api
          .saveMessage(activeChatId, userMsg.id, "user", text, attachmentsJson)
          .catch((err) => console.warn("[DB] save user msg failed:", err));
      }

      // Build wire messages from history.
      // For messages with blocks, derive tool call wire format from search blocks.
      // For legacy messages (no blocks), use existing toolCall field.
      const allMsgsForWire = [...messages, userMsg].filter(
        (m) => m.role !== "divider",
      );

      // Find last message with a tool call (block or legacy) for context-amnesia fix
      const lastToolCallIndex = allMsgsForWire.reduce((last, m, i) => {
        const hasBlockSearch = m.blocks?.some(
          (b) => b.type === "search" && b.phase === "done",
        );
        return hasBlockSearch || m.toolCall ? i : last;
      }, -1);

      const wire: WireMessage[] = allMsgsForWire.flatMap((m, i) => {
        // ── v2.1 block-based path ─────────────────────────────────
        const doneSearchBlock = m.blocks
          ?.slice()
          .reverse()
          .find(
            (b): b is Extract<MessageBlock, { type: "search" }> =>
              b.type === "search" && b.phase === "done",
          );

        if (doneSearchBlock) {
          const isLastToolCall = i === lastToolCallIndex;
          const resultsStr = isLastToolCall
            ? doneSearchBlock.formattedContent ||
              JSON.stringify(doneSearchBlock.results?.slice(0, 3) || [])
            : `[Previous search: ${doneSearchBlock.query}]`;
          const toolCallId = `call_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          return [
            {
              role: m.role as "user" | "assistant",
              content: m.content,
              tool_calls: [
                {
                  id: toolCallId,
                  type: "function",
                  function: {
                    name: "brave_web_search",
                    arguments: JSON.stringify({
                      query: doneSearchBlock.query,
                    }),
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: toolCallId,
              content: resultsStr,
            },
          ] as WireMessage[];
        }

        // ── Legacy toolCall path ──────────────────────────────────
        if (m.toolCall) {
          const isLastToolCall = i === lastToolCallIndex;
          const resultsStr = isLastToolCall
            ? m.toolCall.formattedContent ||
              JSON.stringify(m.toolCall.results?.slice(0, 3) || [])
            : `[Previous search: ${m.toolCall.query}]`;
          const toolCallId = `call_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          return [
            {
              role: m.role as "user" | "assistant",
              content: m.content,
              tool_calls: [
                {
                  id: toolCallId,
                  type: "function",
                  function: {
                    name: "brave_web_search",
                    arguments: JSON.stringify({ query: m.toolCall.query }),
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: toolCallId,
              content: resultsStr,
            },
          ] as WireMessage[];
        }

        return [
          {
            role: m.role as "user" | "assistant",
            content: m.content,
          },
        ] as WireMessage[];
      });

      try {
        await window.api.sendChatMessage({
          messages: wire,
          attachments: attachments?.length ? attachments : undefined,
          chatId: activeChatId ?? undefined,
          model: selectedModel,
          thinkingMode,
        });
      } catch (err) {
        patchAssistant({
          isThinking: false,
          isStreaming: false,
          isSearching: false,
          error: err instanceof Error ? err.message : String(err),
        });
        setIsStreaming(false);
        assistantIdRef.current = null;
        streamingContentRef.current = "";
      }
    },
    [
      isStreaming,
      messages,
      appendBlock,
      updateLastBlock,
      patchAssistant,
      onChatCreated,
      selectedModel,
      thinkingMode,
    ],
  );

  // ── Abort ─────────────────────────────────────────────────────
  const abort = useCallback(() => {
    window.api.abortChat();
  }, []);

  // ── Load messages ─────────────────────────────────────────────
  const loadMessages = useCallback((msgs: Message[]) => {
    setMessages(msgs);
    setIsStreaming(false);
    assistantIdRef.current = null;
    streamingContentRef.current = "";
    currentBlocksRef.current = [];
  }, []);

  // ── Clear conversation ────────────────────────────────────────
  const clearMessages = useCallback(() => {
    if (isStreaming) window.api.abortChat();
    setMessages([]);
    setIsStreaming(false);
    setContextUsage({ used: 0, total: 0 });
    assistantIdRef.current = null;
    streamingContentRef.current = "";
    currentBlocksRef.current = [];
    currentChatIdRef.current = null;
  }, [isStreaming]);

  return {
    messages,
    isStreaming,
    isSearching: false, // kept for API compatibility; block arch tracks this per-message
    sendMessage,
    abort,
    loadMessages,
    clearMessages,
  };
}
