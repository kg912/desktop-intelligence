/**
 * ChatService — Main process
 *
 * Streams completions from LM Studio's OpenAI-compatible SSE endpoint.
 * Uses Electron's net.fetch (Chromium-backed, bypasses CSP/CORS issues)
 * with an AbortController for clean cancellation.
 *
 * Responsibilities:
 *  - SSE parsing and chunk forwarding via webContents.send
 *  - TTFT / tokens-per-sec / total-time telemetry
 *  - Abort support (user stop or app quit)
 */

import { net } from "electron";
import type { WebContents } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import type {
  GenerationStats,
  ChatSendPayload,
  WireMessage,
} from "../../shared/types";
import { readSettings } from "./SettingsStore";
import {
  braveSearch,
  augmentAndFormatResults,
  resolveBraveApiKey,
} from "./BraveSearchService";
import { mcpServerManager } from "./McpServerManager";
import { BASE_SYSTEM_PROMPT } from "./SystemPromptService";
import { countTokens } from "./tokenUtils";
import { getCompactedSummary, clearCompactedSummary } from "./DatabaseService";

/** LM Studio OpenAI-compatible completions endpoint. Single source of truth. */
const LMS_ENDPOINT = "http://localhost:1234/v1/chat/completions";

// Debug logging — only active in dev builds (npm run package:dev sets DEV_MODE=true).
// __DEV_MODE__ is a compile-time constant injected by Rollup define — see globals.d.ts.
const DEBUG = __DEV_MODE__;

// TARGET_MODEL_ID removed — the model is now supplied dynamically via the IPC
// payload (ChatSendPayload.model) and passed as the modelId argument to send().
// The DEFAULT_MODEL_ID fallback lives in shared/types.ts.

/**
 * Stop sequences — official EOS tokens for Qwen/MLX chat templates.
 * LM Studio may not always inject these automatically; including them
 * prevents tokens being generated past the natural end-of-turn marker.
 * The repetition detector handles actual runaway loops independently.
 */
export const STOP_SEQUENCES = [
  "<|im_end|>",
  "<|endoftext|>",
];

/**
 * Repetition detector state.
 * Tracks the last N trimmed non-empty lines seen in the stream.
 * If the same line appears REPETITION_THRESHOLD times consecutively,
 * the stream is aborted and an error is sent to the renderer.
 */
const REPETITION_WINDOW = 3; // consecutive identical lines to trigger abort
const REPETITION_MAX_LEN = 200; // only track lines up to this length (ignore long prose)

const BRAVE_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "brave_web_search",
    description:
      "Search the web for CURRENT or REAL-TIME information only. " +
      "Use ONLY for: live data (prices, weather, scores), recent news/events, " +
      "or when the user explicitly asks to search. " +
      "Do NOT use for general knowledge, concepts, history, coding, math, or creative tasks.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Specific, concise search query for current/real-time information.",
        },
        count: {
          type: "number",
          description: "Number of results (1-10, default 5).",
        },
      },
      required: ["query"],
    },
  },
} as const;

const WEB_SEARCH_SYSTEM_ADDENDUM = `
You have access to a real-time web search tool: brave_web_search. Use it selectively and only when it genuinely adds value.

USE the search tool when:
- The user explicitly asks you to search, look something up, or find current information
- The question requires data that changes frequently: stock prices, weather, live scores, election results, current news, product availability, today's events
- You need to verify a specific fact that may have changed since your training
- The user asks about something you don't know or aren't confident about — search rather than guess
- If you are not confident you know what something is (a product, company, paper, person, or event), search for it rather than guessing. Never invent an explanation for something you don't recognise.

DO NOT use the search tool for:
- Stable conceptual/theoretical knowledge (math, physics, established CS theory, history)
- Creative writing, coding help where you don't need current docs, math, analysis
- Historical facts that do not change
- Casual conversation

IMPORTANT EXCEPTION: Even if you think you know something, SEARCH if:
- It is a specific versioned product, library, framework, or course (content changes with releases)
- It is a company's current offering, pricing, or status
- It is a person's current role, recent work, or latest statements
When in doubt about whether your knowledge is current enough, search.

SELF-HONESTY RULE: Before answering from training knowledge, ask yourself: "Could this information have changed in the last year?" If yes, search first. Do not answer and then search when challenged — search proactively.

CRITICAL — DATA INTEGRITY (read this carefully):
- Your answer must be built ONLY from facts explicitly present in the search result snippets or page content provided to you.
- If the tool result contains only titles and URLs with no substantive content, you MUST say exactly: "The search returned only links without content — I cannot provide current figures. Check these sources directly: [URLs]"
  Do NOT fill the gap with training data. Do NOT speculate. Do NOT present training knowledge as if it came from the search.
- Numbers, prices, percentages, dates, and quotes must come verbatim from the search results. If a specific figure is not in the results, say it is not available in the results.
- This rule overrides your instinct to be helpful with a complete answer. An honest "I don't have that data" is better than a confident hallucination.

After searching, cite your sources using the result titles and URLs.
When you do not search, answer directly from your training knowledge without mentioning the search tool.

When you have received web search results:
- Put ALL your analysis of the results inside <think>…</think>.
- Your response to the user must start with the answer directly — never with "Step 1: Analyse…" or similar.
- Keep your thinking block brief — the search results provide the key facts.

SEARCH EFFICIENCY & BUDGET: Prioritize finding the most direct and efficient path to a comprehensive answer. Use the minimum number of searches necessary; do not perform redundant or unnecessary calls. You are granted an absolute hard limit of 5 search calls per response for deep investigations. Once you have sufficient, verifiable data to satisfy the user's intent, terminate searching immediately and proceed to your answer.

HEURISTIC SEARCH STRATEGY:
 1. ENTITY PAIRING: If the user query contains [Company/Entity] + [Technical Term/Noun], 
     do not assume the noun is a general concept. Prioritize searching for "[Entity] [Noun] product launch", 
     "[Entity] [Noun] announcement", or "[Entity] [Noun] news".
 2. DISAMBIGUATION: If a term has dual meanings (e.g., "Ising" as a physics model vs. a brand), 
     your first query MUST attempt to disambiguate by including the entity name in the search string.
 3. SEMANTIC PROBING: If a search returns results that seem disconnected from the user's 
     intent, pivot your second query from "Definition" to "Recent News/Releases" regarding that term.
`.trim();

const WEB_SEARCH_DISABLED_ADDENDUM = `
Web search is currently disabled. You do not have access to real-time information.

If the user asks you to search the web or asks about current events or recent information:
1. Tell the user that web search is disabled and can be enabled in Settings → MCP & Tools.
2. Answer as best you can from your training knowledge, clearly noting your knowledge cutoff.
3. Suggest that the user can paste relevant content directly into the chat for you to analyse.

Never pretend to have searched when you have not.
`.trim();

/**
 * Attempts to parse a raw tool call from content text.
 * Fallback for models that emit tool calls as text rather than structured tool_calls.
 *
 * Handles all observed formats:
 *   Format A — XML arg_key/arg_value:
 *     <tool_call>brave_web_search<arg_key>query</arg_key><arg_value>...</arg_value></tool_call>
 *   Format B — unquoted key=value:
 *     <tool_call>brave_web_search query=the query here count=5</tool_call>
 *   Format C — quoted key="value":
 *     <tool_call>brave_web_search query="the query here"</tool_call>
 *   Format D — JSON object after tool name:
 *     <tool_call>brave_web_search {"query": "the query"}</tool_call>
 *
 * Returns null if no recognisable tool call is found.
 */
function parseRawToolCall(
  content: string,
): { name: string; args: Record<string, string> } | null {
  // Format F: pipe-delimited format used by Gemma 4 and similar models
  // <|tool_call>call:brave_web_search{queries:["...","..."]}<tool_call|>
  const pipeMatch = content.match(/<\|tool_call>([\s\S]*?)<tool_call\|>/);
  if (pipeMatch) {
    const inner = pipeMatch[1].trim();
    // Strip the "call:" prefix to get the function name
    const callMatch = inner.match(/^call:(\w+)(.*)$/s);
    if (callMatch) {
      const name = callMatch[1].trim();
      const rawArgs = callMatch[2].trim();

      // Gemma 4 uses LM Studio tokenizer delimiters instead of standard JSON quotes:
      //   <|"> = opening string delimiter
      //   <|"|> = closing string delimiter
      // Normalise both to standard double quotes before attempting JSON.parse.
      const argsStr = rawArgs
        .replace(/<\|"\|>/g, '"') // closing delimiter first (longer pattern)
        .replace(/<\|"/g, '"'); // opening delimiter second

      try {
        const parsed = JSON.parse(argsStr);
        if (typeof parsed === "object" && parsed !== null) {
          const args: Record<string, string> = {};
          // Normalise: "queries" array → take first element as "query"
          if (Array.isArray(parsed.queries) && parsed.queries.length > 0) {
            args["query"] = String(parsed.queries[0]);
          } else if (typeof parsed.query === "string") {
            args["query"] = parsed.query;
          }
          // Pass through any other string fields
          for (const [k, v] of Object.entries(parsed)) {
            if (k !== "queries" && k !== "query") args[k] = String(v);
          }
          if (args["query"]) return { name, args };
        }
      } catch {
        /* not valid JSON — fall through */
      }
    }
  }

  const match = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (!match) return null;

  const inner = match[1].trim();

  // Format E: Qwen structured format
  const funcMatch = inner.match(
    /<function=([^>]+)>([\s\S]*?)(?:<\/function>|$)/,
  );
  if (funcMatch) {
    const name = funcMatch[1].trim();
    const argsContent = funcMatch[2];
    const args: Record<string, string> = {};
    const paramRegex = /<parameter=([^>]+)>([\s\S]*?)(?:<\/parameter>|$)/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRegex.exec(argsContent)) !== null) {
      args[pm[1].trim()] = pm[2].trim();
    }
    if (Object.keys(args).length > 0) return { name, args };
  }

  const nameMatch = inner.match(/^(\w+)/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const rest = inner.slice(name.length).trim();

  const args: Record<string, string> = {};
  let m: RegExpExecArray | null;

  // Format A: XML arg_key/arg_value tags
  const xmlPattern =
    /<arg_key>(.*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
  while ((m = xmlPattern.exec(rest)) !== null) {
    args[m[1]] = m[2].trim();
  }
  if (Object.keys(args).length > 0) return { name, args };

  // Format C: quoted key="value" pairs (before unquoted to avoid partial match)
  const quotedPattern = /(\w+)="([^"]*)"/g;
  while ((m = quotedPattern.exec(rest)) !== null) {
    args[m[1]] = m[2];
  }
  if (Object.keys(args).length > 0) return { name, args };

  // Format B: unquoted key=value pairs
  const unquotedPattern = /(\w+)=([^=\s"]+(?:\s+(?!\w+=)[^=\s"]+)*)/g;
  while ((m = unquotedPattern.exec(rest)) !== null) {
    args[m[1]] = m[2].trim();
  }
  if (Object.keys(args).length > 0) return { name, args };

  // Format D: JSON object
  try {
    const parsed = JSON.parse(rest);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      for (const [k, v] of Object.entries(parsed)) {
        args[k] = String(v);
      }
      if (Object.keys(args).length > 0) return { name, args };
    }
  } catch {
    /* not JSON */
  }

  return { name, args };
}

/**
 * Extracts a search query from code-fence tool calls or bare JSON arrays.
 *
 * Handles:
 *   - ```BRAVE_WEB_SEARCH\n[{"query":"..."}, ...]\n```
 *   - ```brave_web_search\n{"query":"..."}\n```
 *   - Bare JSON array in content: [{"query":"..."}, ...]
 *
 * Returns the first query string found, or null.
 */
function extractQueryFromCodeFenceToolCall(content: string): string | null {
  // Match fenced code blocks with tool-related language tags
  const fencePattern =
    /```(?:brave_web_search|BRAVE_WEB_SEARCH|tool_call|TOOL_CALL)\n([\s\S]*?)```/i;
  const fenceMatch = content.match(fencePattern);
  const raw = fenceMatch ? fenceMatch[1].trim() : content.trim();

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0];
      if (
        typeof first === "object" &&
        first !== null &&
        typeof first.query === "string"
      ) {
        return first.query;
      }
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).query === "string"
    ) {
      return (parsed as Record<string, string>).query;
    }
  } catch {
    /* not JSON */
  }

  return null;
}

// FALLBACK ONLY: handles models that ignore the tools array and
// emit tool call syntax as raw text. With LM Studio native tool
// calling active this path should rarely fire. Do not remove —
// it guards against regressions on unknown models.
/**
 * Mid-stream tool call detection logic.
 * Handles extracting tool queries from incomplete or incorrectly formatted tags during SSE stream decoding.
 * Returns the detected query and the cleaned buffer to retract.
 */
function detectMidStreamToolCall(
  buffer: string,
): { query: string; cleanedBuffer: string } | null {
  // Case 1: Closed <tool_call> tag (e.g. standard fallback)
  if (buffer.includes("</tool_call>")) {
    const raw = parseRawToolCall(buffer);
    const q = raw?.args?.["query"];
    if (q) {
      return {
        query: q,
        cleanedBuffer: buffer
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
          .trim(),
      };
    }
  }

  // Case 2: Unclosed <tool_call> (often emitted at stream end or mid-stream before stop token)
  const unclosedMatch = buffer.match(/<tool_call>([\s\S]+)$/i);
  if (unclosedMatch) {
    const inner = unclosedMatch[1].trim();
    // It's likely a complete JSON object if it ends with } or a completed format C string ="..." or a completed Qwen parameter tag
    if (
      inner.endsWith("}") ||
      inner.includes('="') ||
      inner.includes("</parameter>")
    ) {
      const fakeClosed = buffer + "</tool_call>";
      const raw = parseRawToolCall(fakeClosed);
      const q = raw?.args?.["query"];
      if (q) {
        return {
          query: q,
          cleanedBuffer: buffer.replace(/<tool_call>[\s\S]*$/i, "").trim(),
        };
      }
    }
  }

  // Case 5: Closed pipe-delimited tag <|tool_call>...<tool_call|>
  if (buffer.includes("<tool_call|>")) {
    const raw = parseRawToolCall(buffer);
    const q = raw?.args?.["query"];
    if (q) {
      return {
        query: q,
        cleanedBuffer: buffer
          .replace(/<\|tool_call>[\s\S]*?<tool_call\|>/gi, "")
          .trim(),
      };
    }
  }

  // Case 6: Unclosed pipe-delimited tag — stream ended before <tool_call|>
  const unclosedPipeMatch = buffer.match(/<\|tool_call>([\s\S]+)$/i);
  if (unclosedPipeMatch) {
    const inner = unclosedPipeMatch[1].trim();
    // Looks complete if it ends with ] or } (JSON closed)
    if (inner.endsWith("]") || inner.endsWith("}")) {
      const fakeClosed = buffer + "<tool_call|>";
      const raw = parseRawToolCall(fakeClosed);
      const q = raw?.args?.["query"];
      if (q) {
        return {
          query: q,
          cleanedBuffer: buffer.replace(/<\|tool_call>[\s\S]*$/i, "").trim(),
        };
      }
    }
  }

  // Case 3: Closed code fence (```brave_web_search)
  const fenceQuery = extractQueryFromCodeFenceToolCall(buffer);
  if (fenceQuery) {
    return {
      query: fenceQuery,
      cleanedBuffer: buffer
        .replace(
          /```(?:brave_web_search|BRAVE_WEB_SEARCH|tool_call|TOOL_CALL)[\s\S]*?```/gi,
          "",
        )
        .trim(),
    };
  }

  // Case 4: Unclosed code fence
  const unclosedFenceMatch = buffer.match(
    /```(?:brave_web_search|BRAVE_WEB_SEARCH|tool_call|TOOL_CALL)\n([\s\S]+)$/i,
  );
  if (unclosedFenceMatch) {
    const inner = unclosedFenceMatch[1].trim();
    if (inner.endsWith("}") || inner.endsWith("]")) {
      const fakeClosed = buffer + "\n```";
      const fq = extractQueryFromCodeFenceToolCall(fakeClosed);
      if (fq) {
        return {
          query: fq,
          cleanedBuffer: buffer
            .replace(
              /```(?:brave_web_search|BRAVE_WEB_SEARCH|tool_call|TOOL_CALL)[\s\S]*$/i,
              "",
            )
            .trim(),
        };
      }
    }
  }

  return null;
}

/**
 * Strips a leading orphaned </think> tag from content.
 * Safe to apply to every chunk — only removes a tag at the very start.
 * Handles both Qwen3 </think> and Gemma 4 <channel|> orphaned close tags.
 */
function stripLeadingThinkClose(content: string): string {
  // Only strip the closing tag and its immediately following whitespace.
  // Do NOT trimStart() — that would eat "\n\n" chunks (paragraph/code-block
  // separators sent as whitespace-only deltas), merging all text together.
  return content.replace(/^<\/think>\s*/i, "").replace(/^<channel\|>\s*/i, "");
}

// Vision content parts (OpenAI-compatible multimodal format)
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

// Rough token estimator — Qwen tokenizer averages ~3.6 chars/token for English.
// Good enough for the telemetry display; we don't need exact counts here.
const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6);

/**
 * Replaces matplotlib/python code fences in old assistant history messages
 * with a compact stub describing what the chart was.
 *
 * Motivation: the code blocks in old turns are not needed by the model on
 * the next turn — only the fact that a chart was generated matters.  Stubbing
 * them saves a significant number of tokens without losing conversational context.
 *
 * Exported for unit testing.
 */
export function stubMatplotlibBlocks(content: string): string {
  return content.replace(
    /```(?:python|matplotlib)\n([\s\S]*?)```/gi,
    (_match, code: string) => {
      // Extract a human-readable caption from the code
      const titleMatch = code.match(
        /plt\.(?:title|suptitle)\(\s*['"]([^'"]+)['"]/,
      );
      const xlabelMatch = code.match(/plt\.xlabel\(\s*['"]([^'"]+)['"]/);
      const varMatch = code.match(/^(\w+)\s*=/m);
      const caption =
        titleMatch?.[1] ??
        xlabelMatch?.[1] ??
        (varMatch ? `chart of ${varMatch[1]}` : "chart");
      return `[Previously generated matplotlib chart: "${caption}"]`;
    },
  );
}

// ── Exported helpers (also used by unit tests) ───────────────────

/**
 * Prepends the Qwen3 soft-prompt prefix (/no_think or /think) to the last
 * user message so the MLX inference backend reliably enables or suppresses
 * the model's reasoning chain.
 *
 * Rules:
 *  • Only the LAST user message is modified — earlier turns are left intact.
 *  • For multimodal messages (ContentPart[]), the prefix is prepended to the
 *    first text part so image_url parts are not disturbed.
 *  • When there are no user messages the input is returned unchanged.
 *
 * Exported for unit testing — the logic is pure (no side effects, no I/O).
 */
export function applyThinkingPrefix(
  messages: Array<{ role: string; content: string | ContentPart[] }>,
  thinkingMode: import("../../shared/types").ThinkingMode | undefined,
  model?: string,
): Array<{ role: string; content: string | ContentPart[] }> {
  // Gemma models do not recognise /think or /no_think — they are Qwen/MLX-specific
  // soft-prompt tokens. Injecting them into Gemma messages causes them to be echoed
  // verbatim inside the <think> block, polluting the thought accordion with junk text.
  if (model?.toLowerCase().includes("gemma")) return messages;

  const isFast = thinkingMode !== "thinking";
  const prefix = isFast ? "/no_think\n" : "/think\n";
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");

  if (lastUserIdx === -1) return messages;

  const result = [...messages];
  const msg = result[lastUserIdx];

  if (typeof msg.content === "string") {
    result[lastUserIdx] = { ...msg, content: prefix + msg.content };
  } else if (Array.isArray(msg.content)) {
    const parts = [...msg.content] as ContentPart[];
    const textIdx = parts.findIndex((p) => p.type === "text");
    if (textIdx !== -1) {
      const tp = parts[textIdx] as { type: "text"; text: string };
      parts[textIdx] = { type: "text", text: prefix + tp.text };
      result[lastUserIdx] = { ...msg, content: parts };
    }
  }

  return result;
}

export class ChatService {
  private controller: AbortController | null = null;

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  async send(
    payload: ChatSendPayload,
    modelId: string,
    wc: WebContents,
  ): Promise<void> {
    // Cancel any in-flight request before starting a new one
    this.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;

    // ── Read MCP settings ──────────────────────────────────────────
    const appSettings = readSettings();
    const resolvedKey = resolveBraveApiKey();
    const braveEnabled = !!(appSettings.braveSearchEnabled && resolvedKey);

    // ── Build base messages ────────────────────────────────────────
    const builtMessages = applyThinkingPrefix(
      this.buildMessages(payload),
      payload.thinkingMode,
      payload.model,
    );
    console.log(
      "🚀 FINAL LM STUDIO PAYLOAD:",
      JSON.stringify(builtMessages, null, 2),
    );

    const isThinking = payload.thinkingMode === "thinking";

    const startTime = Date.now();
    let firstTokenAt: number | null = null;
    let totalTokens = 0;      // completion tokens (for TPS calculation)
    let promptTokens = 0;     // cumulative prompt size from server usage field
    let buffer = "";
    let searchLoopCount = 0;
    const MAX_SEARCH_LOOPS = appSettings.maxSearchLoops ?? 4;
    console.log(
      `[ChatService] Max search loops: ${MAX_SEARCH_LOOPS} (read from settings)`,
    );

    // Repetition detector state
    let lineBuffer = "";
    let lastLine = "";
    let consecutiveCount = 0;

    const send = (channel: string, data: unknown): void => {
      if (!wc.isDestroyed()) wc.send(channel, data);
    };

    let currentMessages = [...builtMessages];

    // Accumulates the full raw stream output across all search loops.
    // Used after the loop to compute answerTokens (stripped of thinking blocks).
    let lastStreamBuffer = "";

    try {
      // ── Streaming request ────────────────────────────────────────────────────────
      // Single path for all models: native tool calling via delta.tool_calls[].
      // The model autonomously decides whether to search and what query to use.
      // Text-stream fallback (detectMidStreamToolCall) catches models that emit
      // tool call syntax as raw text instead of the structured channel.
      while (searchLoopCount < MAX_SEARCH_LOOPS) {
        const { temperature, topP, maxOutputTokens, repeatPenalty } =
          readSettings();

        // Reset repetition detector for each new streaming request —
        // </think> appears as a completed line at the end of every thinking
        // block, so its count accumulates across search loops and incorrectly
        // triggers an abort on the 3rd loop iteration.
        lastLine = "";
        consecutiveCount = 0;

        // budget_tokens caps the thinking portion only — must leave room for the answer.
        // Setting it equal to max_tokens leaves zero budget for the actual response,
        // causing LM Studio to terminate the stream before the model writes an answer.
        // Reserve 25% of max_tokens for the answer (minimum 2048), thinking gets 75%.
        const effectiveMax = maxOutputTokens ?? 16384;
        const thinkingBudget = Math.max(1024, Math.floor(effectiveMax * 0.75));

        const step2ThinkingField = isThinking
          ? {
              thinking: {
                type: "enabled",
                budget_tokens: thinkingBudget,
              },
            }
          : { thinking: { type: "disabled" } };
        const streamBody = JSON.stringify({
          model: modelId,
          messages: currentMessages,
          temperature: temperature ?? 0.7,
          top_p: topP ?? 0.95,
          max_tokens: maxOutputTokens ?? 16384,
          repeat_penalty: repeatPenalty ?? 1.1,
          stop: STOP_SEQUENCES,
          ...step2ThinkingField,
          ...(() => {
            const mcpTools = mcpServerManager.getToolSchemas();
            const allTools = [
              ...(braveEnabled ? [BRAVE_SEARCH_TOOL] : []),
              ...mcpTools,
            ];
            return allTools.length > 0 ? { tools: allTools, tool_choice: "auto" } : {};
          })(),
          stream: true,
        });

        const response = await net.fetch(LMS_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: streamBody,
          signal: this.controller?.signal || signal,
        } as RequestInit);

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`LM Studio ${response.status}: ${errText}`);
        }

        if (!response.body)
          throw new Error("LM Studio returned no response body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let loopAborted = false;
        let firstChunkProcessed = false;
        let streamBuffer = "";
        let toolCallIntercepted = false;
        let reasoningOpen = false;
        // true while inside a Gemma 4 MLX native <|channel>thought…<channel|> block;
        // prevents the Source A→C </think> injection from firing for mid-thought chunks.
        let inChannelThought = false;

        // Native tool call accumulator — keyed by index since models like Qwen
        // can emit multiple parallel tool calls (index 0, 1, 2...) in a single
        // response. Each slot accumulates its own id, name, and args independently.
        const pendingToolCalls: Map<number, {
          id: string;
          name: string;
          argsRaw: string;
        }> = new Map();

        while (true) {
          if (loopAborted) break;
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;

            const data = line.slice(5).trim();
            if (data === "[DONE]") break;

            let parsed: {
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  tool_calls?: Array<{
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string;
              }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
              };
            };
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            // Capture server-authoritative token counts when LM Studio sends them
            // (typically on the final chunk alongside finish_reason).
            // prompt_tokens = total context sent in this request (all messages + system).
            // completion_tokens = tokens generated in this response.
            // These are kept SEPARATE from totalTokens which drives TPS calculation.
            if (parsed.usage) {
              if (parsed.usage.prompt_tokens)     promptTokens = parsed.usage.prompt_tokens;
              if (parsed.usage.completion_tokens) totalTokens  = parsed.usage.completion_tokens;
            }

            const deltaContent = parsed.choices?.[0]?.delta?.content ?? "";
            const deltaReasoning =
              parsed.choices?.[0]?.delta?.reasoning_content ?? "";

            // ── Native channel token normalisation constants ───────────────
            const CHAN_OPEN  = "<|channel>thought\n";
            const CHAN_CLOSE = "<channel|>";

            // ── Native tool call accumulation ──────────────────────────────
            // LM Studio streams function name + arguments across multiple delta events,
            // potentially across multiple parallel tool call indices in the same response.
            const deltaToolCalls = parsed.choices?.[0]?.delta?.tool_calls;
            if (deltaToolCalls && deltaToolCalls.length > 0 && !toolCallIntercepted) {
              for (const tc of deltaToolCalls) {
                const idx = (tc as { index?: number }).index ?? 0;
                const existing = pendingToolCalls.get(idx);
                if (!existing) {
                  pendingToolCalls.set(idx, {
                    id: tc.id ?? `call_${Date.now()}_${idx}`,
                    name: tc.function?.name ?? "brave_web_search",
                    argsRaw: tc.function?.arguments ?? "",
                  });
                } else {
                  existing.argsRaw += tc.function?.arguments ?? "";
                }
              }
            }

            // LM Studio 0.4.9+ routes Gemma 4 thinking tokens into reasoning_content rather
            // than content. Wrap them in <think>...</think> so the existing parseThinkBlocks
            // pipeline handles them identically to Qwen3 — no other code needs to change.
            // Qwen3/GLM never emit reasoning_content, so this branch never fires for them.
            // Route thinking tokens from all three sources into <think>…</think> so
            // parseThinkBlocks handles every model identically downstream.
            //
            // Sources:
            //  A) reasoning_content delta   — Gemma GGUF, Qwen MLX (LM Studio 0.4.9+)
            //  B) Native Gemma channel tags — Gemma 4 MLX emits these inline in content
            //       when activated via assistant prefill: <|channel>thought\n…<channel|>
            //  C) Plain content             — Qwen3/GLM and all non-thinking models
            let delta = "";
            if (deltaReasoning) {
              // Source A: reasoning_content
              delta = reasoningOpen ? deltaReasoning : "<think>" + deltaReasoning;
              reasoningOpen = true;
            } else if (deltaContent) {
              let chunk = deltaContent;

              // Source B: rewrite native Gemma channel tokens before anything else.
              // A single SSE chunk can contain the open tag, close tag, both, or neither.
              if (chunk.includes(CHAN_OPEN)) {
                chunk = chunk.replace(CHAN_OPEN, "<think>");
                reasoningOpen = true;
                inChannelThought = true;
              }
              if (chunk.includes(CHAN_CLOSE)) {
                chunk = chunk.replace(CHAN_CLOSE, "</think>");
                reasoningOpen = false;
                inChannelThought = false;
              }

              // Source A→C transition: reasoning_content stopped, content resumed.
              // reasoningOpen is still true from the last deltaReasoning chunk — inject
              // </think> before the first answer token.
              // Guard: inChannelThought prevents this from firing for Source B
              // mid-thought chunks where reasoningOpen is true but we're still inside
              // the channel block and have not yet seen CHAN_CLOSE.
              if (reasoningOpen && !inChannelThought && !chunk.includes("</think>")) {
                chunk = "</think>" + chunk;
                reasoningOpen = false;
              }

              delta = chunk;
            }

            if (!delta) continue;

            // 4a — first raw SSE delta diagnostic
            if (DEBUG && !firstChunkProcessed) {
              console.log(
                "[DEBUG] First raw SSE delta:",
                JSON.stringify(delta),
              );
            }

            if (firstTokenAt === null) firstTokenAt = Date.now();

            const cleanedDelta = firstChunkProcessed
              ? delta
              : stripLeadingThinkClose(delta);
            firstChunkProcessed = true;
            if (!cleanedDelta) continue;

            streamBuffer += cleanedDelta;

            if (!toolCallIntercepted) {
              const detected = detectMidStreamToolCall(streamBuffer);
              if (detected) {
                const { query: midQuery, cleanedBuffer: cleanedSoFar } =
                  detected;
                let patchedCleaned = cleanedSoFar;
                const openCount = (patchedCleaned.match(/<think>/gi) || [])
                  .length;
                const closeCount = (patchedCleaned.match(/<\/think>/gi) || [])
                  .length;
                if (openCount > closeCount) {
                  patchedCleaned += "\n</think>\n";
                }

                toolCallIntercepted = true;
                console.log(
                  `[MCP] \uD83D\uDD0D Brave Search (interception depth ${searchLoopCount + 1}): "${midQuery}"`,
                );

                this.abort();
                loopAborted = true;

                // Notify renderer to start a new search block (no retract needed —
                // block architecture is append-only).
                send(IPC_CHANNELS.CHAT_STREAM_TOOL_START, { query: midQuery });

                let midStreamResult: string;
                try {
                  const results = await braveSearch(midQuery, resolvedKey!, 5);
                  midStreamResult = await augmentAndFormatResults(results);
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, {
                    query: midQuery,
                    results: results.slice(0, 5).map((r) => ({
                      title: r.title,
                      url: r.url,
                    })),
                    formattedContent: midStreamResult,
                  });
                } catch (err) {
                  const errMsg =
                    err instanceof Error ? err.message : String(err);
                  midStreamResult = `Web search failed: ${errMsg}. Answer from training knowledge.`;
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_ERROR, {
                    query: midQuery,
                    error: errMsg,
                  });
                }

                const toolCallId = `call_${Date.now()}`;
                currentMessages = [
                  ...currentMessages,
                  {
                    role: "assistant",
                    content: patchedCleaned || (null as unknown as string),
                    tool_calls: [
                      {
                        id: toolCallId,
                        type: "function",
                        function: {
                          name: "brave_web_search",
                          arguments: JSON.stringify({ query: midQuery }),
                        },
                      },
                    ],
                  } as { role: string; content: string },
                  {
                    role: "tool",
                    tool_call_id: toolCallId,
                    content: midStreamResult,
                  } as { role: string; content: string },
                ];

                this.controller = new AbortController();

                searchLoopCount++;
                break; // Break out of `for const raw`
              }
            }

            const chunkToSend = cleanedDelta.replace(/<\|tool_response>/gi, "");

            if (chunkToSend) {
              totalTokens += estimateTokens(chunkToSend);
              // Do NOT forward chunks while a native tool call is being accumulated.
              // pendingToolCalls is non-empty once the first delta.tool_calls event fires;
              // while it has entries the model is deciding to search, not producing an answer.
              if (!pendingToolCalls.size) {
                send(IPC_CHANNELS.CHAT_STREAM_CHUNK, chunkToSend);
              }
              lineBuffer += chunkToSend;
            }
            const newlineIdx = lineBuffer.indexOf("\n");
            if (newlineIdx !== -1) {
              const completedLine = lineBuffer.slice(0, newlineIdx).trim();
              lineBuffer = lineBuffer.slice(newlineIdx + 1);

              if (
                !reasoningOpen &&
                completedLine.length > 0 &&
                completedLine.length <= REPETITION_MAX_LEN
              ) {
                if (completedLine === lastLine) {
                  consecutiveCount++;
                  if (consecutiveCount >= REPETITION_WINDOW) {
                    console.warn(
                      `[ChatService] \uD83D\uDD01 Repetition detected \u2014 "${completedLine}" ` +
                        `repeated ${consecutiveCount} times. Aborting stream.`,
                    );
                    this.abort();
                    loopAborted = true;
                    break;
                  }
                } else {
                  lastLine = completedLine;
                  consecutiveCount = 1;
                }
              }
            }
          }
        }

        // ── Native tool call handler ─────────────────────────────────────────────
        // Fires after the SSE stream ends naturally when delta.tool_calls[] was used.
        // Handles multiple parallel tool calls (Qwen emits index 0, 1, ... for each
        // query it wants to run simultaneously). Executes them sequentially, merges
        // results, and injects a valid assistant→tool[] pair into the wire payload.
        if (pendingToolCalls.size > 0 && !toolCallIntercepted) {
          // Collect tool calls in index order.
          // For search tools: dedup by query string.
          // For MCP tools that have no "query" field (e.g. browser_navigate uses "url"):
          // use the tool name as the dedup key so they are never silently dropped.
          const queries: Array<{ id: string; name: string; query: string; argsRaw: string }> = [];
          const seenKeys = new Set<string>();
          for (const [, tc] of [...pendingToolCalls.entries()].sort(([a], [b]) => a - b)) {
            let query = "";
            try {
              const tcArgs = JSON.parse(tc.argsRaw);
              query = typeof tcArgs.query === "string" ? tcArgs.query
                : Array.isArray(tcArgs.queries) ? (tcArgs.queries[0] ?? "") : "";
            } catch { /* malformed args — proceed with empty query */ }
            // Dedup key: use query string for search tools, tool name for others
            const dedupKey = query || tc.name;
            if (!seenKeys.has(dedupKey)) {
              seenKeys.add(dedupKey);
              queries.push({ id: tc.id, name: tc.name, query, argsRaw: tc.argsRaw });
            }
          }

          if (queries.length > 0) {
            toolCallIntercepted = true;
            console.log(`[MCP] \uD83D\uDD0D Native tool call(s): ${queries.map(q => `"${q.query}"`).join(", ")}`);

            // Build the assistant message with all tool_calls declared up front —
            // required by the OpenAI wire format before any role:tool messages.
            const assistantToolCalls = queries.map(q => ({
              id: q.id,
              type: "function" as const,
              function: { name: q.name, arguments: q.argsRaw },
            }));
            currentMessages = [
              ...currentMessages,
              {
                role: "assistant",
                content: null as unknown as string,
                tool_calls: assistantToolCalls,
              } as { role: string; content: string },
            ];

            // Execute each query, emitting its own search pill in the UI
            const allResultLinks: Array<{ title: string; url: string }> = [];
            const resultSections: string[] = [];
            for (const { id, name: toolName, query, argsRaw } of queries) {
              // Dispatch: Brave Search vs. MCP custom tool (namespaced as serverName__toolName)
              const isBrave = toolName === "brave_web_search";
              const mcpParts = !isBrave ? toolName.split("__") : null;
              const isMcp    = !isBrave && mcpParts && mcpParts.length === 2;

              // uiLabel: what appears in the tool pill. For search tools use the query
              // string; for MCP tools use the namespaced name ("memory__search_nodes") so
              // the renderer can tell them apart from Brave searches.
              const uiLabel = isBrave ? (query || toolName) : toolName;
              send(IPC_CHANNELS.CHAT_STREAM_TOOL_START, { query: uiLabel, toolName });

              try {
                let toolResult: string;

                if (isBrave) {
                  // ── Existing Brave Search path — DO NOT MODIFY ────────────
                  const results = await braveSearch(query, resolvedKey!, 5);
                  const formatted = await augmentAndFormatResults(results);
                  const section = queries.length > 1
                    ? `## Results for: "${query}"\n${formatted}`
                    : formatted;
                  resultSections.push(section);
                  const links = results.slice(0, 3).map(r => ({ title: r.title, url: r.url }));
                  allResultLinks.push(...links);
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, {
                    query: uiLabel,
                    toolName,
                    results: links,
                    formattedContent: section,
                  });
                  toolResult = section;

                } else if (isMcp && mcpParts) {
                  // ── MCP custom tool dispatch ──────────────────────────────
                  const [serverName, mcpToolName] = mcpParts;
                  let args: Record<string, unknown> = {};
                  try { args = JSON.parse(argsRaw || "{}"); } catch { /* use empty args */ }

                  console.log(`[MCP] Calling "${toolName}" with args: ${argsRaw}`);
                  toolResult = await mcpServerManager.callTool(serverName, mcpToolName, args);
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, {
                    query: uiLabel,
                    toolName,
                    results: [],
                    formattedContent: toolResult,
                  });

                } else {
                  toolResult = `Unknown tool: ${toolName}`;
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, {
                    query: uiLabel, toolName, results: [], formattedContent: toolResult,
                  });
                }

                currentMessages = [
                  ...currentMessages,
                  { role: "tool", tool_call_id: id, content: toolResult } as { role: string; content: string },
                ];

              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                send(IPC_CHANNELS.CHAT_STREAM_TOOL_ERROR, { query: uiLabel, toolName, error: errMsg });
                currentMessages = [
                  ...currentMessages,
                  { role: "tool", tool_call_id: id, content: `Tool failed: ${errMsg}. Use training knowledge.` } as { role: string; content: string },
                ];
              }
            }

            this.controller = new AbortController();
            // Only Brave Search counts toward MAX_SEARCH_LOOPS — MCP tool calls
            // are unlimited and should never trigger the search-limit guard.
            const hadBraveCall = queries.some(q => q.name === "brave_web_search");
            if (hadBraveCall) searchLoopCount++;
          }
        }

        // Exit outer loop if stream finished naturally or repetition aborted it
        if (!toolCallIntercepted) {
          // 4b — full accumulated stream content diagnostic
          if (DEBUG) {
            console.log(
              "[DEBUG] Full stream content at end (length:",
              streamBuffer.length,
              "):",
            );
            console.log("[DEBUG]", streamBuffer.slice(0, 500));
          }
          lastStreamBuffer = streamBuffer;
          break;
        }
      }
    } catch (err) {
      const isAbort = (err as Error).name === "AbortError";
      if (!isAbort) {
        send(IPC_CHANNELS.CHAT_ERROR, (err as Error).message);
      }
      const stats: GenerationStats = this.buildStats(
        startTime,
        firstTokenAt,
        totalTokens,
        true,
        promptTokens,
      );
      send(IPC_CHANNELS.CHAT_STREAM_END, stats);
      return;
    } finally {
      this.controller = null;
    }

    // Search-limit guard: if the while loop was exhausted by MAX_SEARCH_LOOPS and
    // no tokens were streamed, the model kept attempting searches without producing
    // an answer. Surface a clear error rather than letting it silently hallucinate.
    if (searchLoopCount >= MAX_SEARCH_LOOPS && totalTokens === 0) {
      console.warn(
        "[ChatService] ⚠️  Search limit reached — model attempted search again after limit",
      );
      send(
        IPC_CHANNELS.CHAT_ERROR,
        "The search tool was called multiple times without producing an answer. " +
          "Try rephrasing your question or disabling web search in Settings → MCP & Tools.",
      );
      const stats = this.buildStats(startTime, firstTokenAt, 0, true, promptTokens);
      send(IPC_CHANNELS.CHAT_STREAM_END, stats);
      return;
    }

    if (totalTokens === 0 && firstTokenAt === null) {
      console.warn(
        "[ChatService] ⚠️  Empty response from LM Studio — possible context overflow or stop-sequence collision",
      );
      send(
        IPC_CHANNELS.CHAT_ERROR,
        "The model returned an empty response. This usually means the conversation context is too long. " +
          "Try starting a new chat, or switch to Fast mode for lighter queries.",
      );
    }

    // Fallback: if LM Studio didn't emit a usage field (common with Gemma GGUF),
    // count tokens in the wire payload we actually sent. This gives the context bar
    // an accurate prompt-size figure without relying on the server to report it.
    if (promptTokens === 0) {
      promptTokens = currentMessages.reduce((sum, m) => {
        let tokenEstimate: number;
        if (typeof m.content === "string") {
          tokenEstimate = countTokens(m.content);
        } else if (Array.isArray(m.content)) {
          // Multipart content (vision) — count text parts normally,
          // substitute a fixed 1000-token estimate per image to avoid
          // stringifying base64 data URLs (which are 600K+ chars and
          // produce wildly inflated token counts).
          tokenEstimate = (m.content as ContentPart[]).reduce((partSum, part) => {
            if (part.type === "text") return partSum + countTokens(part.text);
            if (part.type === "image_url") return partSum + 1000; // ~1K tokens per image
            return partSum;
          }, 0);
        } else {
          tokenEstimate = countTokens(JSON.stringify(m.content));
        }
        return sum + tokenEstimate + 4; // +4 per-message role overhead
      }, 0);
      if (DEBUG) console.log(`[DEV][ChatService] usage not emitted — computed promptTokens from wire payload: ${promptTokens}`);
    }

    // answerTokens = the completion content that will actually appear in the next
    // request's context — i.e. totalTokens minus the thinking block, which
    // stripThinkBlocks removes before sending history to LM Studio.
    // lastStreamBuffer holds the final loop's full raw stream output (think + answer).
    const strippedAnswer = this.stripThinkBlocks(lastStreamBuffer);
    const answerTokens = countTokens(strippedAnswer);
    if (DEBUG) console.log(`[DEV][ChatService] answerTokens (stripped): ${answerTokens} / totalTokens: ${totalTokens}`);

    const stats = this.buildStats(startTime, firstTokenAt, totalTokens, false, promptTokens, answerTokens);
    send(IPC_CHANNELS.CHAT_STREAM_END, stats);
  }

  abort(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  // Strip <think>…</think> blocks from assistant history messages before
  // sending to LM Studio.  Past reasoning chains are useless to the model on
  // the next turn — only the final answers matter — but they consume thousands
  // of tokens.  Using lastIndexOf matches our renderer logic (Qwen sometimes
  // mentions </think> inside the thought, so we split at the LAST occurrence).
  private stripThinkBlocks(content: string): string {
    // Strip Qwen3-style <think>…</think> blocks
    const open = "<think>";
    const close = "</think>";
    let result = content;
    const start = result.indexOf(open);
    if (start !== -1) {
      const end = result.lastIndexOf(close);
      if (end === -1) result = result.slice(0, start).trim();
      else
        result = (
          result.slice(0, start) + result.slice(end + close.length)
        ).trim();
    }

    // Strip Gemma 4-style <|channel>thought\n…<channel|> blocks
    const gOpen = "<|channel>thought\n";
    const gClose = "<channel|>";
    const gStart = result.indexOf(gOpen);
    if (gStart !== -1) {
      const gEnd = result.lastIndexOf(gClose);
      if (gEnd === -1) result = result.slice(0, gStart).trim();
      else
        result = (
          result.slice(0, gStart) + result.slice(gEnd + gClose.length)
        ).trim();
    }

    return result;
  }

  private cleanAssistantHistory(content: string): string {
    // Strips any [System Note: ...] prefixes injected by orchestration loops
    return content.replace(/\[System Note:[\s\S]*?\]/gi, "").trim();
  }

  // LM Studio vision content part shapes
  private buildMessages(
    payload: ChatSendPayload,
  ): Array<{ role: string; content: string | ContentPart[] }> {
    const msgs: Array<{ role: string; content: string | ContentPart[] }> = [];

    // ── System prompt: explicit + document injections ────────────
    // Read brave settings so we can inject the correct web-search addendum
    const appSettings = readSettings();
    const resolvedKey = resolveBraveApiKey();
    const braveEnabled = !!(appSettings.braveSearchEnabled && resolvedKey);

    // Inject current date so models use the right year in search queries and
    // time-sensitive reasoning — training cutoff is no longer the reference.
    const _now = new Date();
    const DATE_INJECTION = `Current date and time: ${_now.toLocaleDateString(
      "en-US",
      {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      },
    )}, ${_now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}.`;

    const systemParts: string[] = [BASE_SYSTEM_PROMPT, DATE_INJECTION];
    if (braveEnabled) systemParts.push(WEB_SEARCH_SYSTEM_ADDENDUM);
    if (!braveEnabled) systemParts.push(WEB_SEARCH_DISABLED_ADDENDUM);
    if (payload.systemPrompt) systemParts.push(payload.systemPrompt);

    // Gemma 4 thinking activation — Gemma does not support the `thinking:{type}`
    // payload field; instead it is activated by a <|think|> prefix in the system
    // prompt.  Detection is by model name (only route that is reliable here since
    // we don't yet have content to inspect).
    if (
      payload.thinkingMode === "thinking" &&
      payload.model?.toLowerCase().includes("gemma")
    ) {
      systemParts[0] = "<|think|>\n" + systemParts[0];
    }

    if (systemParts.length > 0) {
      msgs.push({ role: "system", content: systemParts.join("\n\n") });
    }

    // ── Compacted summary injection ───────────────────────────────
    // When the user has run "Compact", a summary row is stored in
    // chats.compacted_summary.  On the FIRST request after compaction we
    // replace the full message history with just [summary + last user msg]
    // so LM Studio receives a lean context.  We then immediately clear the
    // summary so subsequent messages resume using the full real history.
    // The visible UI messages are NOT touched — this only affects the wire payload.
    if (payload.chatId) {
      const compactedSummary = getCompactedSummary(payload.chatId);
      if (compactedSummary) {
        clearCompactedSummary(payload.chatId);
        // Keep only the current user message (always the last in the array)
        const lastUserMsg = [...payload.messages]
          .reverse()
          .find((m) => (m.role as string) === "user");
        const compactedMsgs: typeof payload.messages = [
          { role: "assistant", content: compactedSummary } as typeof payload.messages[0],
          ...(lastUserMsg ? [lastUserMsg] : []),
        ];
        // Splice directly into msgs (system already pushed) and return early
        for (const m of compactedMsgs) {
          msgs.push({ role: m.role, content: m.content as string });
        }
        console.log(
          `[ChatService] 🗜 Using compacted summary (${compactedSummary.length} chars) ` +
          `for chatId=${payload.chatId} — cleared for next request`,
        );
        return msgs;
      }
    }

    // ── Token-budget trim ─────────────────────────────────────────
    // Replaces the old HISTORY_WINDOW = 20 message-count heuristic.
    //
    // Budget = context_window - max_output_tokens - system_tokens - overhead
    //
    // We walk messages newest→oldest, accumulate token estimates, and drop
    // messages that would push us over budget.  This guarantees the payload
    // always fits regardless of individual message sizes (e.g. long answers,
    // large code blocks, or matplotlib responses).
    const isThinkingMode = payload.thinkingMode === "thinking";
    const maxOutputTokens = isThinkingMode ? 32768 : 16384;
    const contextLength = appSettings.contextLength ?? 32768;
    const systemTokenCount = countTokens(systemParts.join("\n\n"));
    const OVERHEAD = 512; // role formatting, stop tokens, misc.
    const historyBudget = Math.max(
      2000,
      contextLength - maxOutputTokens - systemTokenCount - OVERHEAD,
    );

    const allMsgs = payload.messages.filter(
      (m) => (m.role as string) !== "divider",
    );

    // Stub matplotlib code in old turns (beyond the 2 most recent pairs).
    // The code itself is not needed by the model on the next turn; the stub
    // caption preserves conversational context at a fraction of the token cost.
    const RECENT_PAIRS = 2;
    const recentBoundary = Math.max(0, allMsgs.length - RECENT_PAIRS * 2);

    const lastUserIdx = allMsgs.map((m) => m.role).lastIndexOf("user");
    const lastAssistantIdx = allMsgs
      .map((m) => m.role)
      .lastIndexOf("assistant");

    const processedMsgs = allMsgs.map((m, i) => {
      if (m.role === "tool" && i < lastUserIdx) {
        if (!appSettings.keepSearchResultsInContext) {
          return { ...m, content: "[Previous Search Results for query]" };
        }
        // keepSearchResultsInContext is ON — preserve full content
        return m;
      }

      // Topic-anchoring fix: truncate assistant messages from previous search turns.
      // Without this, a 400–700 token answer from the previous turn sitting just before
      // the new question causes the model to anchor to the old topic when deciding
      // whether and what to search. We keep only the first 150 chars as a coherence
      // stub; the full content of the MOST RECENT assistant message is preserved.
      const wm = m as unknown as WireMessage;
      if (
        m.role === "assistant" &&
        wm.tool_calls &&
        wm.tool_calls.length > 0 &&
        i < lastAssistantIdx
      ) {
        const contentStr = typeof m.content === "string" ? m.content : "";
        const stub =
          contentStr.length > 150
            ? contentStr.slice(0, 150).trimEnd() +
              "… [previous answer truncated]"
            : contentStr;
        return { ...m, content: stub };
      }

      if (m.role !== "assistant") return m;

      const stripped = this.cleanAssistantHistory(
        this.stripThinkBlocks(m.content as string),
      );
      const content =
        i < recentBoundary ? stubMatplotlibBlocks(stripped) : stripped;
      return { ...m, content: content || "" };
    });

    // Walk newest→oldest, keep messages within the budget.
    let tokenSum = 0;
    const kept: typeof processedMsgs = [];
    for (let i = processedMsgs.length - 1; i >= 0; i--) {
      const m = processedMsgs[i];
      const contentStr =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const t = countTokens(contentStr) + 4; // +4 per-message role overhead
      if (tokenSum + t > historyBudget && kept.length > 0) {
        console.log(
          `[ChatService] ✂️ Budget trim: dropped messages 0–${i} ` +
            `(budget=${historyBudget}, accumulated=${tokenSum}, ctx=${contextLength})`,
        );
        break;
      }
      tokenSum += t;
      kept.unshift(m);
    }

    // ── Image attachments go on the last user message ────────────
    const images = (payload.attachments ?? []).filter(
      (a) => a.kind === "image" && a.dataUrl,
    );
    const lastIdx = kept.length - 1;

    for (let i = 0; i < kept.length; i++) {
      const m = kept[i];
      const wm = m as unknown as WireMessage;

      if (images.length > 0 && m.role === "user" && i === lastIdx) {
        // Vision message — build multipart content, but still preserve any
        // tool_calls / tool_call_id that might be on this message.
        const parts: ContentPart[] = [
          { type: "text", text: m.content as string },
        ];
        for (const img of images) {
          parts.push({ type: "image_url", image_url: { url: img.dataUrl! } });
        }
        const wireMsg: Record<string, unknown> = {
          role: m.role,
          content: parts,
        };
        if (wm.tool_calls) wireMsg.tool_calls = wm.tool_calls;
        if (wm.tool_call_id) wireMsg.tool_call_id = wm.tool_call_id;
        msgs.push(wireMsg as { role: string; content: string | ContentPart[] });
      } else {
        // Standard message — preserve tool_calls and tool_call_id so LM Studio
        // sees a valid assistant→tool message pair.  Plain destructuring
        // ({ role, content }) silently drops these fields, producing an
        // invalid tool message whose tool_call_id references a non-existent
        // tool_calls entry on the preceding assistant message.
        const wireMsg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (wm.tool_calls) wireMsg.tool_calls = wm.tool_calls;
        if (wm.tool_call_id) wireMsg.tool_call_id = wm.tool_call_id;
        msgs.push(wireMsg as { role: string; content: string | ContentPart[] });
      }
    }

    // Gemma MLX thinking activation via assistant prefill.
    // The <|think|> system prompt prefix activates thinking on GGUF builds but
    // is ignored by the MLX runtime — replies are instant with no reasoning.
    // Prefilling the assistant turn with the native thought channel opener forces
    // the MLX sampler to continue generating inside the thought block before it
    // can produce an answer.
    // Guard: model ID must contain both "gemma" AND "mlx" — GGUF variants do not
    // contain "mlx" in their LM Studio model ID and must not receive this prefill
    // since they already activate thinking via reasoning_content correctly.
    if (
      payload.thinkingMode === "thinking" &&
      payload.model?.toLowerCase().includes("gemma") &&
      payload.model?.toLowerCase().includes("mlx")
    ) {
      msgs.push({ role: "assistant", content: "<|channel>thought\n" });
    }

    return msgs;
  }

  private buildStats(
    startTime: number,
    firstTokenAt: number | null,
    totalTokens: number,
    aborted: boolean,
    promptTokens = 0,
    answerTokens = 0,
  ): GenerationStats {
    const totalMs = Date.now() - startTime;
    const ttft = firstTokenAt !== null ? firstTokenAt - startTime : totalMs;
    const elapsed = Math.max(totalMs / 1000, 0.001);

    return {
      ttft,
      tokensPerSec: Math.round((totalTokens / elapsed) * 10) / 10,
      totalMs,
      totalTokens,
      promptTokens: promptTokens || undefined,
      answerTokens: answerTokens || undefined,
      aborted,
    };
  }
}

export const chatService = new ChatService();
