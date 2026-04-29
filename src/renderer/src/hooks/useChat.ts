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
 * v2.1.1: Block sequencing via chunk-buffer scan.
 *   `chunkBufferRef` accumulates raw SSE text. `processBuffer()` scans for
 *   `<think>` / `</think>` boundaries and routes tokens to the correct block
 *   type. `activeBlockIdRef` tracks which specific block is currently receiving
 *   tokens so post-search ThinkingBlocks are distinct from pre-search ones.
 *
 * v2.3.0 (Phase 1): Buffer state machine extracted to chunkBuffer.ts + wireMessages.ts
 *   for unit testability. Streaming state migrated from monolithic useState to
 *   @preact/signals-react for surgical per-component reactivity — streamingBlocks
 *   updates every rAF tick without triggering React re-renders; ChatArea scroll
 *   and InputBar send-gate subscribe to signals directly.
 *
 * ── IS_MOCK detection ────────────────────────────────────────────
 * In Electron with contextIsolation:true the global `electron` object
 * is NOT injected into window, so `'electron' in window` is always
 * false even in the real app.  The reliable signal is the Chromium
 * user-agent string which Electron always appends 'Electron/x.y.z' to.
 * In a plain browser (Vite preview) that substring is absent, so we
 * fall back to the in-memory mock that main.tsx already injected.
 */

import { useCallback, useEffect, useRef } from "react";
import { useSignals } from "@preact/signals-react/runtime";
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
} from "../../../shared/types";
import {
  processBuffer as processBufferPure,
  closeAnswerBlock as closeAnswerBlockPure,
  type BlockState,
  type BufferContext,
} from "../lib/chunkBuffer";
import { buildWireMessages } from "../lib/wireMessages";
import {
  completedMessages,
  streamingMessage,
  streamingBlocks,
  isStreamingSignal,
  allMessages,
} from "../signals/chatSignals";

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
  // Enable signal subscriptions — the calling component re-renders when any
  // signal read inside this hook changes.
  useSignals();

  const { selectedModel, thinkingMode, setContextUsage } = useModelStore();

  const assistantIdRef = useRef<string | null>(null);

  // Think-block timeout guard
  const thinkStartedAt = useRef<number | null>(null);

  const currentChatIdRef = useRef<string | null>(chatId);

  // Accumulates raw streamed answer text for DB persistence at stream-end.
  const streamingContentRef = useRef<string>("");

  // Mirrors the current assistant message's blocks array — updated in sync with
  // every block mutation so stream-end can read it without a setMessages round-trip.
  const currentBlocksRef = useRef<MessageBlock[]>([]);

  // ── v2.1.1 block-sequencing refs ─────────────────────────────
  /** Id of the block currently receiving tokens (thinking or answer). null = no active block. */
  const activeBlockIdRef = useRef<string | null>(null);
  /** Raw SSE text not yet routed to a block. */
  const chunkBufferRef = useRef<string>("");
  /** True while inside an open <think> tag (waiting for </think>). */
  const inThinkBlockRef = useRef<boolean>(false);

  // ── rAF throttle for streaming state updates ─────────────────
  // processBuffer() mutates refs on every token but schedules at most ONE
  // signal write per animation frame via pendingRafRef. This caps per-token
  // signal updates at ~60/s without losing any tokens (refs hold latest state).
  const pendingRafRef = useRef<number | null>(null);

  // ── Cheap think-block open/close tracking ────────────────────
  const hasSeenOpenThinkRef  = useRef<boolean>(false);
  const hasSeenCloseThinkRef = useRef<boolean>(false);

  // Tracks the thinking mode used for the previous turn (divider insertion).
  const prevThinkingModeRef = useRef<"thinking" | "fast">("fast");

  useEffect(() => {
    currentChatIdRef.current = chatId;
  }, [chatId]);

  // ── Signal-based block helpers ────────────────────────────────
  // These helpers update currentBlocksRef (the ref mirror) AND write to
  // streamingMessage.value so the rendering component sees the change.
  // They replace the old setMessages(findIndex...) pattern.

  /** Append a new block to the current assistant turn. */
  const appendBlock = useCallback((block: MessageBlock) => {
    currentBlocksRef.current = [...currentBlocksRef.current, block];
    streamingBlocks.value = currentBlocksRef.current;
    const cur = streamingMessage.value;
    if (cur) {
      streamingMessage.value = {
        ...cur,
        blocks: currentBlocksRef.current,
      };
    }
  }, []);

  /** Patch the last block of a given type on the current assistant turn. */
  const updateLastBlock = useCallback(
    (type: MessageBlock["type"], patch: Partial<MessageBlock>) => {
      const refBlocks = [...currentBlocksRef.current];
      let lastIdx = -1;
      for (let i = refBlocks.length - 1; i >= 0; i--) {
        if (refBlocks[i].type === type) { lastIdx = i; break; }
      }
      if (lastIdx !== -1) {
        refBlocks[lastIdx] = { ...refBlocks[lastIdx], ...patch } as MessageBlock;
        currentBlocksRef.current = refBlocks;
      }
      streamingBlocks.value = currentBlocksRef.current;
      const cur = streamingMessage.value;
      if (cur) {
        streamingMessage.value = { ...cur, blocks: currentBlocksRef.current };
      }
    },
    [],
  );

  /** Patch a specific block by id on the current assistant turn. */
  const updateBlockById = useCallback(
    (blockId: string, patch: Partial<MessageBlock>) => {
      const refBlocks = [...currentBlocksRef.current];
      const idx = refBlocks.findIndex((b) => b.id === blockId);
      if (idx !== -1) {
        refBlocks[idx] = { ...refBlocks[idx], ...patch } as MessageBlock;
        currentBlocksRef.current = refBlocks;
      }
      streamingBlocks.value = currentBlocksRef.current;
      const cur = streamingMessage.value;
      if (cur) {
        streamingMessage.value = { ...cur, blocks: currentBlocksRef.current };
      }
    },
    [],
  );

  /** Patch the current assistant message's top-level fields (isThinking, isSearching, etc.) */
  const patchAssistant = useCallback((patch: Partial<Message>) => {
    const cur = streamingMessage.value;
    if (cur) {
      streamingMessage.value = { ...cur, ...patch };
    }
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
    // ── Buffer-processing wrapper ────────────────────────────────
    // Delegates to the pure processBufferPure() from chunkBuffer.ts.
    // Writes returned values back to refs and schedules the signal flush.

    function processBuffer(): void {
      const prevInThink = inThinkBlockRef.current;
      const result = processBufferPure(
        chunkBufferRef.current,
        {
          blocks:        currentBlocksRef.current as BlockState[],
          activeBlockId: activeBlockIdRef.current,
          inThinkBlock:  prevInThink,
        } satisfies BufferContext,
        () => uuid(),
      );

      currentBlocksRef.current = result.ctx.blocks as MessageBlock[];
      activeBlockIdRef.current  = result.ctx.activeBlockId;
      inThinkBlockRef.current   = result.ctx.inThinkBlock;
      chunkBufferRef.current    = result.remaining;

      // Maintain seen-tag flags (used by the timeout guard below)
      if (result.ctx.blocks.some((b) => b.type === "thinking")) {
        hasSeenOpenThinkRef.current = true;
      }
      if (prevInThink && !result.ctx.inThinkBlock) {
        hasSeenCloseThinkRef.current = true;
      }

      if (result.mutated) {
        scheduleStateFlush();
      }
    }

    /**
     * scheduleStateFlush — write current ref state to signals at most once per
     * animation frame. Multiple processBuffer() calls within one frame share one
     * rAF; the callback reads the latest ref values so no tokens are lost.
     *
     * Writes streamingBlocks for components subscribing to per-token updates
     * (e.g. ChatArea scroll via useSignalEffect), and also updates
     * streamingMessage so allMessages recomputes and the rendering tree refreshes.
     */
    function scheduleStateFlush(): void {
      if (pendingRafRef.current !== null) return; // already scheduled
      pendingRafRef.current = requestAnimationFrame(() => {
        pendingRafRef.current = null;
        const blocks = currentBlocksRef.current;
        streamingBlocks.value = blocks;
        const cur = streamingMessage.value;
        if (cur) {
          streamingMessage.value = {
            ...cur,
            blocks,
            content:     streamingContentRef.current,
            isThinking:  false,
            isStreaming:  true,
            isSearching:  false,
          };
        }
      });
    }

    /**
     * Flush current ref state to signals immediately (no rAF).
     * Called before appendBlock so block-list mutations are visible when the
     * signal update for the new block fires.
     */
    function commitBlocksToState(): void {
      streamingBlocks.value = currentBlocksRef.current;
      const cur = streamingMessage.value;
      if (cur) {
        streamingMessage.value = { ...cur, blocks: currentBlocksRef.current };
      }
    }

    // ── Chunk: buffer and route to the correct block type ─────────
    const unsubChunk = window.api.onChatStreamChunk((chunk: string) => {
      streamingContentRef.current += chunk;
      chunkBufferRef.current += chunk;

      if (thinkStartedAt.current === null) {
        thinkStartedAt.current = Date.now();
      }

      if (DEBUG) console.log(`[Debug][useChat][ChunkReceived] chunkLen=${chunk.length} totalBuffered=${chunkBufferRef.current.length} chunk="${chunk.slice(0,40)}"`);
      processBuffer();

      // Safety net: force-abort if think block unclosed for >180 s
      if (
        thinkStartedAt.current !== null &&
        hasSeenOpenThinkRef.current &&
        !hasSeenCloseThinkRef.current &&
        Date.now() - thinkStartedAt.current > 180_000
      ) {
        console.warn("[useChat] ⏱ Think block timeout — forcing stream end");
        window.api.abortChat();
      }
    });

    // ── Tool start: flush buffer, close active block, append search block ──
    const unsubToolStart = window.api.onChatStreamToolStart(
      ({ query, toolName }: { query: string; toolName?: string }) => {
        // Flush any buffered text before the search begins
        processBuffer();

        // Close and deactivate the currently active block (pure — updates ref)
        if (activeBlockIdRef.current) {
          const closed = closeAnswerBlockPure(
            currentBlocksRef.current as BlockState[],
            activeBlockIdRef.current,
          );
          currentBlocksRef.current = closed as MessageBlock[];
        }
        activeBlockIdRef.current = null;
        inThinkBlockRef.current  = false;
        chunkBufferRef.current   = "";

        // Commit closed-block ref state to signals before appendBlock fires
        commitBlocksToState();

        if (DEBUG) console.log(`[Debug][useChat][ToolStart] query="${query}" toolName=${toolName ?? 'brave_web_search'}`);
        appendBlock({ id: uuid(), type: "search", query, toolName, phase: "searching" });
        patchAssistant({ isSearching: true, isThinking: false });
      },
    );

    // ── Tool done: update last search block with results ──────────
    const unsubToolDone = window.api.onChatStreamToolDone(
      ({
        query,
        toolName,
        results,
        formattedContent,
        toolArgs,
        toolImages,
      }: {
        query: string;
        toolName?: string;
        results: Array<{ title: string; url: string }>;
        formattedContent: string;
        toolArgs?: Record<string, unknown>;
        toolImages?: Array<{ mimeType: string; data: string }>;
      }) => {
        if (DEBUG) console.log(`[Debug][useChat][ToolDone] query="${query}" toolName=${toolName ?? 'brave_web_search'} resultsCount=${results.length} formattedLen=${formattedContent.length}`);
        updateLastBlock("search", {
          phase: "done",
          results,
          formattedContent,
          ...(toolName   ? { toolName }   : {}),
          ...(toolArgs   ? { toolArgs }   : {}),
          ...(toolImages ? { toolImages } : {}),
        } as Partial<MessageBlock>);
        patchAssistant({ isSearching: false });
      },
    );

    // ── Tool error: mark last search block as error ───────────────
    const unsubToolError = window.api.onChatStreamToolError(
      ({ query: _q, toolName: _tn, error }: { query: string; toolName?: string; error: string }) => {
        if (DEBUG) console.log(`[Debug][useChat][ToolError] query="${_q}" toolName=${_tn ?? 'unknown'} error="${error}"`);
        updateLastBlock("search", {
          phase: "error",
          error,
        } as Partial<MessageBlock>);
        patchAssistant({ isSearching: false });
      },
    );

    // ── Stream end ────────────────────────────────────────────────
    const unsubEnd = window.api.onChatStreamEnd((stats: GenerationStats) => {
      const assistantMsgId   = assistantIdRef.current;
      const assistantContent = streamingContentRef.current;
      const activeChatId     = currentChatIdRef.current;

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

      if (DEBUG) console.log(`[Debug][useChat][StreamEnd] contentLen=${assistantContent.length} blocks=${currentBlocksRef.current.length} stats=${JSON.stringify(stats)}`);
      // Flush any remaining buffered content before finalising
      processBuffer();

      // Clear in-flight refs before any async work
      assistantIdRef.current        = null;
      streamingContentRef.current   = "";
      thinkStartedAt.current        = null;
      activeBlockIdRef.current      = null;
      chunkBufferRef.current        = "";
      inThinkBlockRef.current       = false;
      hasSeenOpenThinkRef.current   = false;
      hasSeenCloseThinkRef.current  = false;
      if (pendingRafRef.current !== null) {
        cancelAnimationFrame(pendingRafRef.current);
        pendingRafRef.current = null;
      }

      // Finalise blocks: mark all answer blocks isStreaming: false
      const finalizedBlocks = currentBlocksRef.current.map((b) =>
        b.type === "answer" ? { ...b, isStreaming: false } : b,
      ) as MessageBlock[];
      currentBlocksRef.current = finalizedBlocks;

      // Move the streaming message into the completed list
      const cur = streamingMessage.value;
      const finalizedMsg: Message = {
        ...(cur ?? makeAssistant()),
        id:          assistantMsgId ?? (cur?.id ?? uuid()),
        blocks:      finalizedBlocks,
        isThinking:  false,
        isStreaming:  false,
        isSearching:  false,
        stats,
      };
      completedMessages.value = [...completedMessages.value, finalizedMsg];
      streamingMessage.value  = null;
      streamingBlocks.value   = [];
      isStreamingSignal.value = false;

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
        const blocksJson = finalizedBlocks.length
          ? JSON.stringify(finalizedBlocks)
          : null;
        const doneBlock = finalizedBlocks
          .slice()
          .reverse()
          .find(
            (b): b is Extract<MessageBlock, { type: "search" }> =>
              b.type === "search" && b.phase === "done",
          );
        const toolCallJson = doneBlock
          ? JSON.stringify({
              query:            doneBlock.query,
              results:          doneBlock.results ?? [],
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
      if (DEBUG) console.log(`[Debug][useChat][ChatError] msg="${msg}"`);
      const assistantMsgId = assistantIdRef.current;
      assistantIdRef.current        = null;
      streamingContentRef.current   = "";
      activeBlockIdRef.current      = null;
      chunkBufferRef.current        = "";
      inThinkBlockRef.current       = false;
      hasSeenOpenThinkRef.current   = false;
      hasSeenCloseThinkRef.current  = false;
      if (pendingRafRef.current !== null) {
        cancelAnimationFrame(pendingRafRef.current);
        pendingRafRef.current = null;
      }
      const cur = streamingMessage.value;
      const errorMsg: Message = {
        ...(cur ?? makeAssistant()),
        id:          assistantMsgId ?? (cur?.id ?? uuid()),
        isThinking:  false,
        isStreaming:  false,
        isSearching:  false,
        error:       msg,
      };
      completedMessages.value = [...completedMessages.value, errorMsg];
      streamingMessage.value  = null;
      streamingBlocks.value   = [];
      isStreamingSignal.value = false;
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
      if (isStreamingSignal.value) return;

      thinkStartedAt.current = null;

      const msgAttachments: MessageAttachment[] | undefined =
        attachments && attachments.length > 0
          ? attachments.map((a) => ({ name: a.name, type: a.kind }))
          : undefined;

      const userMsg: Message = {
        id:          uuid(),
        role:        "user",
        content:     text,
        stats:       null,
        isThinking:  false,
        isStreaming:  false,
        isSearching:  false,
        error:       null,
        attachments: msgAttachments,
      };

      const assistantMsg = makeAssistant();
      assistantIdRef.current        = assistantMsg.id;
      streamingContentRef.current   = "";
      currentBlocksRef.current      = [];
      activeBlockIdRef.current      = null;
      chunkBufferRef.current        = "";
      inThinkBlockRef.current       = false;
      hasSeenOpenThinkRef.current   = false;
      hasSeenCloseThinkRef.current  = false;
      if (pendingRafRef.current !== null) {
        cancelAnimationFrame(pendingRafRef.current);
        pendingRafRef.current = null;
      }

      const modeChanged = prevThinkingModeRef.current !== thinkingMode;
      prevThinkingModeRef.current = thinkingMode;

      // Snapshot pre-send history for wire building (before we mutate signals)
      const prevHistory = allMessages.value;

      const dividers: Message[] =
        modeChanged && prevHistory.length > 0
          ? [
              {
                id:          uuid(),
                role:        "divider",
                content:
                  thinkingMode === "thinking"
                    ? "— Switched to Thinking Mode —"
                    : "— Switched to Fast Mode —",
                stats:       null,
                isThinking:  false,
                isStreaming:  false,
                isSearching:  false,
                error:       null,
              },
            ]
          : [];

      // Update signals: push user message (and optional divider) to history,
      // set the in-flight assistant placeholder.
      completedMessages.value = [...completedMessages.value, ...dividers, userMsg];
      streamingMessage.value  = assistantMsg;
      streamingBlocks.value   = [];
      isStreamingSignal.value = true;

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

      // Build wire messages from pre-send history + current user message.
      const wire = buildWireMessages([...prevHistory, ...dividers, userMsg]);

      try {
        await window.api.sendChatMessage({
          messages:     wire,
          attachments:  attachments?.length ? attachments : undefined,
          chatId:       activeChatId ?? undefined,
          model:        selectedModel,
          thinkingMode,
        });
      } catch (err) {
        patchAssistant({
          isThinking:  false,
          isStreaming:  false,
          isSearching:  false,
          error: err instanceof Error ? err.message : String(err),
        });
        // Move the error assistant to completed
        const cur = streamingMessage.value;
        if (cur) {
          completedMessages.value = [...completedMessages.value, { ...cur, error: err instanceof Error ? err.message : String(err), isThinking: false, isStreaming: false, isSearching: false }];
        }
        streamingMessage.value  = null;
        streamingBlocks.value   = [];
        isStreamingSignal.value = false;
        assistantIdRef.current        = null;
        streamingContentRef.current   = "";
      }
    },
    [
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
    completedMessages.value = msgs;
    streamingMessage.value  = null;
    streamingBlocks.value   = [];
    isStreamingSignal.value = false;
    assistantIdRef.current        = null;
    streamingContentRef.current   = "";
    currentBlocksRef.current      = [];
    activeBlockIdRef.current      = null;
    chunkBufferRef.current        = "";
    inThinkBlockRef.current       = false;
  }, []);

  // ── Clear conversation ────────────────────────────────────────
  const clearMessages = useCallback(() => {
    if (isStreamingSignal.value) window.api.abortChat();
    completedMessages.value = [];
    streamingMessage.value  = null;
    streamingBlocks.value   = [];
    isStreamingSignal.value = false;
    setContextUsage({ used: 0, total: 0 });
    assistantIdRef.current        = null;
    streamingContentRef.current   = "";
    currentBlocksRef.current      = [];
    activeBlockIdRef.current      = null;
    chunkBufferRef.current        = "";
    inThinkBlockRef.current       = false;
    hasSeenOpenThinkRef.current   = false;
    hasSeenCloseThinkRef.current  = false;
    if (pendingRafRef.current !== null) {
      cancelAnimationFrame(pendingRafRef.current);
      pendingRafRef.current = null;
    }
    currentChatIdRef.current = null;
  }, [setContextUsage]);

  // ── Derive return values from signals ─────────────────────────
  // Reading signal.value here subscribes the calling component to changes
  // (via useSignals() above). allMessages is a computed that only recomputes
  // on message-level events, not on every streaming token.
  const messages   = allMessages.value;
  const isStreaming = isStreamingSignal.value;

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
