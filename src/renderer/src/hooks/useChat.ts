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
  // every block mutation so stream-end can read it without a nested setMessages.
  const currentBlocksRef = useRef<MessageBlock[]>([]);

  // ── v2.1.1 block-sequencing refs ─────────────────────────────
  /** Id of the block currently receiving tokens (thinking or answer). null = no active block. */
  const activeBlockIdRef = useRef<string | null>(null);
  /** Raw SSE text not yet routed to a block. */
  const chunkBufferRef = useRef<string>("");
  /** True while inside an open <think> tag (waiting for </think>). */
  const inThinkBlockRef = useRef<boolean>(false);

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

  /** Patch a specific block by id on the current assistant message. */
  const updateBlockById = useCallback(
    (blockId: string, patch: Partial<MessageBlock>) => {
      const id = assistantIdRef.current;
      // Update ref mirror
      const refBlocks = [...currentBlocksRef.current];
      const refIdx = refBlocks.findIndex((b) => b.id === blockId);
      if (refIdx !== -1) {
        refBlocks[refIdx] = { ...refBlocks[refIdx], ...patch } as MessageBlock;
        currentBlocksRef.current = refBlocks;
      }
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) return prev;
        const blocks = [...(prev[idx].blocks ?? [])];
        const bIdx = blocks.findIndex((b) => b.id === blockId);
        if (bIdx === -1) return prev;
        blocks[bIdx] = { ...blocks[bIdx], ...patch } as MessageBlock;
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
    // ── Local buffer-processing helpers ─────────────────────────
    // These close over refs + stable setters only — safe inside the effect.

    /** Append text to a specific block in the ref mirror (no state update). */
    function appendToBlock(blockId: string, text: string): void {
      const blocks = [...currentBlocksRef.current];
      const idx = blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;
      const b = blocks[idx];
      if (b.type === "thinking") {
        blocks[idx] = { ...b, content: b.content + text };
      } else if (b.type === "answer") {
        blocks[idx] = { ...b, content: b.content + text, isStreaming: true };
      }
      currentBlocksRef.current = blocks;
    }

    /**
     * Route `text` to the active answer block.
     * Creates a new AnswerBlock and sets activeBlockIdRef if there isn't one.
     * Updates ref only — caller triggers the single setMessages at end of processBuffer.
     */
    function ensureAnswerAndAppend(text: string): void {
      if (activeBlockIdRef.current) {
        const existing = currentBlocksRef.current.find(
          (b) => b.id === activeBlockIdRef.current,
        );
        if (existing?.type === "answer") {
          appendToBlock(activeBlockIdRef.current, text);
          return;
        }
      }
      // No active answer block — create one
      const newId = uuid();
      currentBlocksRef.current = [
        ...currentBlocksRef.current,
        { id: newId, type: "answer", content: text, isStreaming: true } as MessageBlock,
      ];
      activeBlockIdRef.current = newId;
    }

    /** Mark an answer block as no longer streaming. Updates ref only. */
    function closeAnswerBlock(blockId: string): void {
      const blocks = [...currentBlocksRef.current];
      const idx = blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;
      const b = blocks[idx];
      if (b.type === "answer") {
        blocks[idx] = { ...b, isStreaming: false };
        currentBlocksRef.current = blocks;
      }
    }

    /** How many chars at the end of `buf` could be the start of `tag`. */
    function partialTagSuffix(buf: string, tag: string): number {
      for (let len = Math.min(tag.length - 1, buf.length); len > 0; len--) {
        if (buf.endsWith(tag.slice(0, len))) return len;
      }
      return 0;
    }

    /**
     * Flush `chunkBufferRef` by scanning for `<think>` / `</think>` boundaries.
     * Text between boundaries is routed to the correct block type via ref mutation.
     * A single `setMessages` is issued at the end when any mutation occurred.
     */
    function processBuffer(): void {
      let buf = chunkBufferRef.current;
      let mutated = false;

      while (buf.length > 0) {
        if (inThinkBlockRef.current) {
          // ── Inside a think block — look for </think> ────────────
          const closeTag = "</think>";
          const closeIdx = buf.indexOf(closeTag);
          if (closeIdx === -1) {
            // No close tag yet — hold back any partial closing tag suffix
            const partialLen = partialTagSuffix(buf, closeTag);
            const safe = buf.slice(0, buf.length - partialLen);
            if (safe && activeBlockIdRef.current) {
              appendToBlock(activeBlockIdRef.current, safe);
              mutated = true;
            }
            buf = partialLen > 0 ? buf.slice(buf.length - partialLen) : "";
            break;
          } else {
            // Close tag found — commit text before it, then exit think mode
            const before = buf.slice(0, closeIdx);
            if (before && activeBlockIdRef.current) {
              appendToBlock(activeBlockIdRef.current, before);
              mutated = true;
            }
            inThinkBlockRef.current = false;
            activeBlockIdRef.current = null; // next answer text → new AnswerBlock
            buf = buf.slice(closeIdx + closeTag.length);
            mutated = true;
          }
        } else {
          // ── In answer mode — look for <think> ──────────────────
          const openTag = "<think>";
          const openIdx = buf.indexOf(openTag);
          if (openIdx === -1) {
            // No open tag — hold back any partial opening tag suffix
            const partialLen = partialTagSuffix(buf, openTag);
            const safe = buf.slice(0, buf.length - partialLen);
            if (safe) {
              ensureAnswerAndAppend(safe);
              mutated = true;
            }
            buf = partialLen > 0 ? buf.slice(buf.length - partialLen) : "";
            break;
          } else {
            // Open tag found — commit answer text before it, then enter think mode
            const before = buf.slice(0, openIdx);
            if (before) {
              ensureAnswerAndAppend(before);
              mutated = true;
            }
            // Close any active answer block
            if (activeBlockIdRef.current) {
              closeAnswerBlock(activeBlockIdRef.current);
              activeBlockIdRef.current = null;
            }
            // Create a new ThinkingBlock
            const newThinkId = uuid();
            currentBlocksRef.current = [
              ...currentBlocksRef.current,
              { id: newThinkId, type: "thinking", content: "" } as MessageBlock,
            ];
            inThinkBlockRef.current = true;
            activeBlockIdRef.current = newThinkId;
            buf = buf.slice(openIdx + openTag.length);
            mutated = true;
          }
        }
      }

      chunkBufferRef.current = buf;

      if (mutated) {
        const id = assistantIdRef.current;
        const blocks = currentBlocksRef.current;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === id);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            blocks,
            content: streamingContentRef.current,
            isThinking: false,
            isStreaming: true,
            isSearching: false,
          };
          return updated;
        });
      }
    }

    /**
     * Push current ref state to React state.
     * Called after ref-only mutations (e.g. closeAnswerBlock) to keep state in sync
     * before an appendBlock call that reads from prev state.
     */
    function commitBlocksToState(): void {
      const id = assistantIdRef.current;
      const blocks = currentBlocksRef.current;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], blocks };
        return updated;
      });
    }

    // ── Chunk: buffer and route to the correct block type ─────────
    const unsubChunk = window.api.onChatStreamChunk((chunk: string) => {
      streamingContentRef.current += chunk;
      chunkBufferRef.current += chunk;

      if (thinkStartedAt.current === null) {
        thinkStartedAt.current = Date.now();
      }

      processBuffer();

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

    // ── Tool start: flush buffer, close active block, append search block ──
    const unsubToolStart = window.api.onChatStreamToolStart(
      ({ query, toolName }: { query: string; toolName?: string }) => {
        // Flush any buffered text before the search begins
        processBuffer();

        // Close and deactivate the currently active block
        if (activeBlockIdRef.current) {
          closeAnswerBlock(activeBlockIdRef.current);
        }
        activeBlockIdRef.current = null;
        inThinkBlockRef.current = false;
        chunkBufferRef.current = "";

        // Commit the closed-block ref state to React before appendBlock reads prev state
        commitBlocksToState();

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
      }: {
        query: string;
        toolName?: string;
        results: Array<{ title: string; url: string }>;
        formattedContent: string;
      }) => {
        updateLastBlock("search", {
          phase: "done",
          results,
          formattedContent,
          ...(toolName ? { toolName } : {}),
        } as Partial<MessageBlock>);
        patchAssistant({ isSearching: false });
      },
    );

    // ── Tool error: mark last search block as error ───────────────
    const unsubToolError = window.api.onChatStreamToolError(
      ({ query: _q, toolName: _tn, error }: { query: string; toolName?: string; error: string }) => {
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

      // Flush any remaining buffered content before finalising
      processBuffer();

      // Clear in-flight refs before any async work
      assistantIdRef.current = null;
      streamingContentRef.current = "";
      thinkStartedAt.current = null;
      activeBlockIdRef.current = null;
      chunkBufferRef.current = "";
      inThinkBlockRef.current = false;

      // Finalise blocks: mark all answer blocks isStreaming: false
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
      activeBlockIdRef.current = null;
      chunkBufferRef.current = "";
      inThinkBlockRef.current = false;
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
      activeBlockIdRef.current = null;
      chunkBufferRef.current = "";
      inThinkBlockRef.current = false;

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
          // Use the actual tool name from the block — MCP tools store their namespaced
          // name (e.g. "memory__search_nodes") here; legacy search blocks have undefined.
          const wireFuncName = doneSearchBlock.toolName ?? "brave_web_search";
          // For Brave Search reconstruct args as {query}; for MCP tools the block query
          // IS the namespaced tool name so reconstruct args as {} (content carries result).
          const wireArgs = wireFuncName === "brave_web_search"
            ? JSON.stringify({ query: doneSearchBlock.query })
            : JSON.stringify({});
          const resultsStr = isLastToolCall
            ? doneSearchBlock.formattedContent ||
              JSON.stringify(doneSearchBlock.results?.slice(0, 3) || [])
            : `[Previous tool call: ${doneSearchBlock.toolName ?? doneSearchBlock.query}]`;
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
                    name: wireFuncName,
                    arguments: wireArgs,
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
    activeBlockIdRef.current = null;
    chunkBufferRef.current = "";
    inThinkBlockRef.current = false;
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
    activeBlockIdRef.current = null;
    chunkBufferRef.current = "";
    inThinkBlockRef.current = false;
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
