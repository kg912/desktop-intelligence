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
import { observabilityService } from "./ObservabilityService";
import type { ObsEvent } from "./ObservabilityService";
import {
  braveSearch,
  augmentAndFormatResults,
  resolveBraveApiKey,
} from "./BraveSearchService";
import { mcpServerManager, McpDeniedError, buildApprovedToolResult, buildDeniedToolMessage } from "./McpServerManager";
import { BASE_SYSTEM_PROMPT } from "./SystemPromptService";
import { countTokens } from "./tokenUtils";
import { getCompactedSummary, clearCompactedSummary } from "./DatabaseService";

/** LM Studio OpenAI-compatible completions endpoint. Single source of truth. */
const LMS_ENDPOINT = "http://localhost:1234/v1/chat/completions";

/** NVIDIA Build OpenAI-compatible completions endpoint. */
const NVIDIA_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";

/** OpenRouter chat completions endpoint. */
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

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
export const STOP_SEQUENCES = ["<|im_end|>", "<|endoftext|>"];

/**
 * CODE_FENCE_TOOL_NAMES
 *
 * Names the model may mistakenly call as structured tool_calls when they are
 * actually code-fence execution primitives intercepted by the renderer.
 * Used by buildUnregisteredToolMessage to return a targeted corrective hint.
 */
export const CODE_FENCE_TOOL_NAMES = new Set([
  'matplotlib', 'python', 'python3', 'echarts', 'mermaid', 'svg',
])

/**
 * buildUnregisteredToolMessage
 *
 * Returns the corrective tool-result string injected into the message history
 * when the model attempts to call a tool name that is not in the session
 * registry. Pure function — no side effects, no IPC, fully unit-testable.
 *
 * Two cases:
 *  - Code-fence pseudo-tool (matplotlib, python, echarts, …): explains the
 *    model must write a code fence in its text response, not call a function.
 *  - Any other unregistered name: lists the actual registered tool names so
 *    the model can self-correct on the next iteration.
 */
export function buildUnregisteredToolMessage(
  toolName: string,
  validNames: ReadonlySet<string>,
): string {
  if (CODE_FENCE_TOOL_NAMES.has(toolName)) {
    return (
      `"${toolName}" is not a callable tool and cannot be invoked via tool_calls. ` +
      `To produce ${toolName} output, write a \`\`\`${toolName} code fence directly ` +
      `in your response text — the app intercepts and executes it natively. ` +
      `Do not attempt to call "${toolName}" as a function again.`
    )
  }
  const registered = [...validNames].join(', ') || '(none)'
  return (
    `"${toolName}" is not registered in the tool schema for this session and cannot ` +
    `be called. Do not call it again. ` +
    `Registered tools for this session: ${registered}.`
  )
}

/**
 * partialContentOrNull
 *
 * Returns the trimmed stream buffer as the `content` field of an assistant
 * message that also carries tool_calls, or null if the buffer is empty/
 * whitespace-only (the normal case for pure tool-call turns).
 *
 * Used in the native tool call path to preserve text the model streamed
 * before emitting tool_calls in the same turn — preventing the model from
 * losing memory of its own partial output and restarting from scratch on
 * the next loop iteration.
 *
 * Matches the existing mid-stream path pattern: `patchedCleaned || null`.
 * Pure function — no side effects, fully unit-testable.
 */
export function partialContentOrNull(streamBuffer: string): string | null {
  return streamBuffer.trim() || null
}

const OLLAMA_MAX_TOOL_RESULT_CHARS = 12_000
const CLOUD_MAX_TOOL_RESULT_CHARS  = 50_000

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

const TICKER_TOOL = {
  type: "function",
  function: {
    name: "get_ticker_price",
    description:
      "Get the current price and key stats for a stock ticker symbol. " +
      "Use this to retrieve exact, up-to-date price data (current price, open, high, low, " +
      "volume, % change, market cap) for any publicly traded equity. " +
      "Always prefer this over web search when the user wants a specific stock price or quote.",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "The ticker symbol, e.g. NVDA, AAPL, MSFT.",
        },
      },
      required: ["symbol"],
    },
  },
} as const;

function buildWebSearchAddendum(maxSearchRounds: number): string {
  return `
You have access to a real-time web search tool: brave_web_search.

SEARCH ONLY when the question genuinely requires it:
- Live or fast-changing data: stock prices, weather, live scores, breaking news, today's events
- The user explicitly asks you to search or look something up
- You encounter an entity (product, person, company, event) you do not recognise at all — search rather than invent

DO NOT search for:
- Anything you can answer reliably from training: concepts, history, established facts, coding, math, creative tasks
- Information that is unlikely to have changed in a meaningful way
- Topics where you have solid knowledge and the user has not asked for current data

You may call brave_web_search at most ${maxSearchRounds} time(s) per turn. After each result, re-run the sufficiency check (step 4 of the agent loop). If you have enough to answer — write the answer. If the budget is exhausted, produce the best answer from what is already in context and say so plainly.

CRITICAL — DATA INTEGRITY:
- Your answer must be grounded in what the search results actually say.
- If results contain only titles and URLs with no substantive content, say: "The search returned only links — I cannot provide current figures. Check these sources directly: [URLs]"
- Do not fill gaps with training data presented as search-derived facts.
- Numbers, prices, dates, and quotes must come from the results. If a figure is absent, say so.

After searching, cite your sources using result titles and URLs.
When you do not search, answer directly from training knowledge without mentioning the search tool.

When you have received web search results:
- Put ALL your analysis of the results inside <think>…</think>.
- Your response to the user must start with the answer directly.

HEURISTIC SEARCH STRATEGY:
 1. ENTITY PAIRING: If the query contains [Company/Entity] + [Noun], search for "[Entity] [Noun]" specifically — do not treat the noun as a generic concept.
 2. DISAMBIGUATION: If a term has dual meanings, your first query must include the entity name to disambiguate.
 3. PIVOT: If results are clearly off-topic, one follow-up query is permitted to correct course — this counts against the budget.
`.trim();
}

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
export function parseRawToolCall(
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

  // Whitespace-tolerant: Qwen3 emits `<tool_call> <function=` (space after tag).
  const match = content.match(/<tool_call>\s*([\s\S]*?)<\/tool_call>/);
  if (!match) return null;

  const inner = match[1].trim();

  // Format E: Qwen structured format
  // Handles both `<tool_call><function=name>` and `<tool_call> <function=name>`.
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
export function extractQueryFromCodeFenceToolCall(content: string): string | null {
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

/**
 * Parse DeepSeek DSML tool call format emitted inline in delta.content.
 *
 * DeepSeek V4 models (and potentially others) may bypass the structured
 * delta.tool_calls path and instead emit tool calls as text using a
 * proprietary XML-like syntax where tag delimiters are fullwidth vertical
 * bars (｜, U+FF5C) or regular pipes with surrounding spaces.
 *
 * Observed format:
 *   <｜DSML｜tool_calls>
 *     <｜DSML｜invoke name="serverName__toolName">
 *       <｜DSML｜parameter name="key" string="true">value</｜DSML｜parameter>
 *     </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * Returns an array of { id, name, argsRaw } objects ready to populate
 * pendingToolCalls, which the existing post-stream handler then executes.
 * Returns [] if no complete DSML block is found.
 */
export function parseDsmlToolCalls(
  buffer: string,
): Array<{ id: string; name: string; argsRaw: string }> {
  // Normalise: fullwidth bar ｜ (U+FF5C) → | and collapse whitespace around pipes.
  const norm = buffer
    .replace(/\uFF5C/g, "|")
    .replace(/\s*\|\s*/g, "|");

  const results: Array<{ id: string; name: string; argsRaw: string }> = [];

  // Match each <|DSML|invoke name="...">...</|DSML|invoke> block,
  // capturing the inner content for parameter extraction.
  const invokeCapture =
    /<\|DSML\|invoke\s+name="([^"]+)">(\s*[\s\S]*?)<\/\|DSML\|invoke>/gi;
  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = invokeCapture.exec(norm)) !== null) {
    const toolName = invokeMatch[1].trim();
    const innerContent = invokeMatch[2];

    // Extract <|DSML|parameter name="key">value</|DSML|parameter> entries.
    const args: Record<string, string> = {};
    const paramRe =
      /<\|DSML\|parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/\|DSML\|parameter>/gi;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRe.exec(innerContent)) !== null) {
      args[paramMatch[1].trim()] = paramMatch[2].trim();
    }

    results.push({
      id:      `call_dsml_${Date.now()}_${results.length}`,
      name:    toolName,
      argsRaw: JSON.stringify(args),
    });
  }

  return results;
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
export function detectMidStreamToolCall(
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

  // Case 2: Unclosed <tool_call> (often emitted at stream end or mid-stream before stop token).
  // Whitespace-tolerant regex to handle Qwen3's `<tool_call> <function=` format.
  const unclosedMatch = buffer.match(/<tool_call>\s*([\s\S]+)$/i);
  if (unclosedMatch) {
    const inner = unclosedMatch[1].trim();
    // Completeness heuristics — any of these indicate the tag is parseable:
    //   • ends with }          → Format D (JSON)
    //   • includes ="          → Format C (quoted key=value)
    //   • includes </parameter> → Format E (Qwen) — at least one param closed
    //   • includes <parameter=  → Format E (Qwen) — param tag opened; may be
    //     mid-stream, so we attempt parse and only fire when query is non-empty.
    const likelyClosed =
      inner.endsWith("}") ||
      inner.includes('="') ||
      inner.includes("</parameter>") ||
      inner.includes("<parameter=");

    if (likelyClosed) {
      const fakeClosed = buffer + "</tool_call>";
      const raw = parseRawToolCall(fakeClosed);
      const q = raw?.args?.["query"];
      // Guard: only intercept when query is non-empty.  An empty value means
      // the <parameter=query> tag opened but its text hasn't arrived yet —
      // wait for more chunks rather than firing a blank search.
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
/**
 * EOS tokens that some models (Qwen, DeepSeek) leak literally into the stream
 * instead of relying on the provider's stop-sequence enforcement.
 * Strip these anywhere they appear — they must never reach the renderer or persisted content.
 */
const EOS_TOKENS_RE = /<\|(?:endoftext|im_end|eot_id|end)\|>/gi;

function stripLeadingThinkClose(content: string): string {
  // Only strip the closing tag and its immediately following whitespace.
  // Do NOT trimStart() — that would eat "\n\n" chunks (paragraph/code-block
  // separators sent as whitespace-only deltas), merging all text together.
  return content
    .replace(/^<\/think>\s*/i, "")
    .replace(/^<channel\|>\s*/i, "");
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
  provider?: import("../../shared/types").BackendProvider,
): Array<{ role: string; content: string | ContentPart[] }> {
  // NVIDIA-hosted, Ollama, and OpenRouter models do not use /think or /no_think soft-prompt tokens.
  if (provider === "nvidia" || provider === "ollama" || provider === "openrouter") return messages;
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

/** Shape of a single tool call as returned by Ollama in message.tool_calls */
interface OllamaToolCall {
  type: string
  function: { name: string; arguments: Record<string, unknown> }
}

/** Shape of one NDJSON chunk from Ollama /api/chat with stream:true */
interface OllamaStreamChunk {
  message?: {
    role?:       string
    content?:    string
    thinking?:   string
    tool_calls?: OllamaToolCall[]
  }
  done:                boolean
  done_reason?:        string
  eval_count?:         number
  prompt_eval_count?:  number
  error?:              string
}

/**
 * Converts the OpenAI-wire-format messages produced by buildMessages() into
 * Ollama /api/chat native format:
 *  - tool result messages use `tool_name` instead of `tool_call_id`
 *  - assistant tool_calls have `arguments` as an object (not a JSON string)
 */
export function buildOllamaMessages(
  messages: Array<{ role: string; content: unknown }>,
): Array<Record<string, unknown>> {
  return messages.map((m, i) => {
    if (m.role === 'tool') {
      const wm = m as unknown as WireMessage
      const toolCallId = wm.tool_call_id ?? ''
      let toolName = 'unknown_tool'
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j] as unknown as WireMessage
        if (prev.role === 'assistant' && prev.tool_calls) {
          const match = prev.tool_calls.find((tc) => tc.id === toolCallId)
          if (match) { toolName = match.function.name; break }
        }
      }
      return { role: 'tool', content: m.content, tool_name: toolName }
    }
    if (m.role === 'assistant') {
      const wm = m as unknown as WireMessage
      if (wm.tool_calls && wm.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: m.content ?? '',
          tool_calls: wm.tool_calls.map((tc) => ({
            type: 'function',
            function: {
              name:      tc.function.name,
              arguments: (() => { try { return JSON.parse(tc.function.arguments) } catch { return {} } })(),
            },
          })),
        }
      }
    }
    // Convert ContentPart[] to Ollama native format: { content: string, images: string[] }
    if (Array.isArray(m.content)) {
      const parts = m.content as ContentPart[]
      const textContent = parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { type: 'text'; text: string }).text)
        .join('')
      const images = parts
        .filter((p) => p.type === 'image_url')
        .map((p) => {
          const url = (p as { type: 'image_url'; image_url: { url: string } }).image_url.url
          if (url.startsWith('data:')) {
            const commaIdx = url.indexOf(',')
            return commaIdx !== -1 ? url.slice(commaIdx + 1) : url
          }
          return url
        })
      if (images.length > 0) {
        return { role: m.role, content: textContent, images }
      }
    }
    return m as Record<string, unknown>
  })
}

/**
 * Fetches current price data for a ticker from Yahoo Finance's public JSON API.
 * Uses Electron's net.fetch — no Python, no shell, no external dependencies.
 * Returns a human-readable string suitable for injection into the model context.
 */
export async function fetchTickerPrice(symbol: string): Promise<string> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  try {
    const resp = await net.fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
      },
    });

    if (!resp.ok) {
      return `[Ticker lookup failed for ${symbol}: HTTP ${resp.status}]`;
    }

    const data = await resp.json() as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            regularMarketOpen?: number;
            regularMarketDayHigh?: number;
            regularMarketDayLow?: number;
            regularMarketVolume?: number;
            marketCap?: number;
            currency?: string;
            exchangeName?: string;
            regularMarketTime?: number;
            preMarketPrice?: number;
            postMarketPrice?: number;
          };
        }>;
        error?: { description?: string };
      };
    };

    const err = data?.chart?.error;
    if (err) return `[Ticker lookup failed for ${symbol}: ${err.description ?? "unknown error"}]`;

    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return `[No data returned for ${symbol}]`;

    const price         = meta.regularMarketPrice;
    const prev          = meta.chartPreviousClose;
    const open          = meta.regularMarketOpen;
    const high          = meta.regularMarketDayHigh;
    const low           = meta.regularMarketDayLow;
    const volume        = meta.regularMarketVolume;
    const mktCap        = meta.marketCap;
    const currency      = meta.currency ?? "USD";
    const exchange      = meta.exchangeName ?? "";
    const preMarketPrice  = (meta as Record<string, unknown>).preMarketPrice as number | undefined;
    const postMarketPrice = (meta as Record<string, unknown>).postMarketPrice as number | undefined;

    const pct = price != null && prev != null && prev !== 0
      ? (((price - prev) / prev) * 100).toFixed(2)
      : null;

    const fmt = (n?: number, decimals = 2) =>
      n != null ? n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : "N/A";

    const fmtVol = (n?: number) => {
      if (n == null) return "N/A";
      if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
      if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}M`;
      return n.toLocaleString("en-US");
    };

    const changeStr = pct != null
      ? ` (${Number(pct) >= 0 ? "+" : ""}${pct}% vs prev close)`
      : "";

    const lines = [
      `[Ticker: ${symbol.toUpperCase()} | ${exchange} | ${currency}]`,
      `Price:   ${fmt(price)}${changeStr}`,
    ];
    if (preMarketPrice != null)  lines.push(`Pre-Mkt: ${fmt(preMarketPrice)}`);
    if (postMarketPrice != null) lines.push(`Aft-Mkt: ${fmt(postMarketPrice)}`);
    lines.push(
      `Open:    ${fmt(open)}`,
      `High:    ${fmt(high)}`,
      `Low:     ${fmt(low)}`,
      `Prev:    ${fmt(prev)}`,
      `Volume:  ${fmtVol(volume)}`,
      `Mkt Cap: ${fmtVol(mktCap)}`,
    );
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Ticker lookup failed for ${symbol}: ${msg}]`;
  }
}

export class ChatService {
  private controller: AbortController | null = null;
  private obsSessionId = '';

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
    const provider = appSettings.backendProvider ?? "lmstudio";
    const isNvidia = provider === "nvidia";
    const isOllama = provider === "ollama";
    const isOpenRouter = provider === "openrouter";
    const getToolResultLimit = (): number | null => {
      if (isOllama)                return OLLAMA_MAX_TOOL_RESULT_CHARS
      if (isNvidia || isOpenRouter) return CLOUD_MAX_TOOL_RESULT_CHARS
      return null  // LM Studio: no limit
    }
    // 5i — session_start
    this.obsSessionId = observabilityService.startSession(payload.chatId ?? '', modelId, provider)

    const resolvedKey = resolveBraveApiKey();
    const braveEnabled = !!(appSettings.braveSearchEnabled && resolvedKey);

    // ── Build base messages ────────────────────────────────────────
    const _rawBuilt = this.buildMessages(payload, isNvidia || isOllama || isOpenRouter);
    // Always-on: log every message buildMessages() produced so we can see
    // exactly what goes into the wire payload, not just what came from the renderer.
    console.log(`[EOS-TRACE] buildMessages() output — ${_rawBuilt.length} message(s):`);
    _rawBuilt.forEach((m, i) => {
      const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const hasEos = EOS_TOKENS_RE.test(contentStr);
      EOS_TOKENS_RE.lastIndex = 0;
      console.log(
        `[EOS-TRACE]   [${i}] role=${m.role} chars=${contentStr.length} hasEOS=${hasEos} preview="${contentStr.slice(0, 120).replace(/\n/g, '↵')}"`,
      );
      if (hasEos) {
        // Show the 80 chars around each match so we can see context
        const matches = [...contentStr.matchAll(new RegExp(EOS_TOKENS_RE.source, 'gi'))];
        matches.forEach(match => {
          const start = Math.max(0, (match.index ?? 0) - 40);
          const end = Math.min(contentStr.length, (match.index ?? 0) + 40);
          console.warn(`[EOS-TRACE]   ⚠️  EOS at index ${match.index}: "...${contentStr.slice(start, end)}..."`);
        });
      }
    });
    const builtMessages = applyThinkingPrefix(
      _rawBuilt,
      payload.thinkingMode,
      payload.model,
      provider,
    );
    // 5b — system_prompt capture
    const _obsSysMsg = builtMessages.find((m) => m.role === 'system')
    this._obsCapture({ type: 'system_prompt', payload: { text: typeof _obsSysMsg?.content === 'string' ? _obsSysMsg.content : '' }, ts: Date.now() })
    // 5c — rag_chunks capture (from RAG/inject system messages added in handlers.ts)
    const _obsRagChunks = payload.messages
      .filter((m) => m.role === 'system' && typeof m.content === 'string' &&
        (m.content.includes('[SYSTEM DIRECTIVE: You are equipped') ||
         m.content.includes('[DOCUMENT CONTENT — READ THIS CAREFULLY')))
      .map((m) => ({ source: 'rag', content: m.content as string }))
    this._obsCapture({ type: 'rag_chunks', payload: { chunks: _obsRagChunks }, ts: Date.now() })

    if (DEBUG)
      console.log(
        `🚀 FINAL ${isNvidia ? "NVIDIA" : isOllama ? "OLLAMA" : isOpenRouter ? "OPENROUTER" : "LM STUDIO"} PAYLOAD (${builtMessages.length} messages):`,
        JSON.stringify(builtMessages, null, 2),
      );

    const isThinking = payload.thinkingMode === "thinking";

    const startTime = Date.now();
    let firstTokenAt: number | null = null;
    let totalTokens = 0; // completion tokens (for TPS calculation)
    let promptTokens = 0; // cumulative prompt size from server usage field
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
    let capturedFinishReason = 'unknown';

    const send = (channel: string, data: unknown): void => {
      if (!wc.isDestroyed()) wc.send(channel, data);
    };

    let accumulatedChunks: string[] = [];
    let lastFlushTime = Date.now();
    const FLUSH_INTERVAL = 50; // ms

    const flushChunkBuffer = (): void => {
      if (accumulatedChunks.length > 0) {
        const consolidated = accumulatedChunks.join("");
        send(IPC_CHANNELS.CHAT_STREAM_CHUNK, consolidated);
        accumulatedChunks = [];
        lastFlushTime = Date.now();
      }
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
      while (true) {
        if (DEBUG)
          console.log(
            `[Debug][ChatService][LoopStart] iteration=${searchLoopCount} MAX=${MAX_SEARCH_LOOPS} totalTokens=${totalTokens} braveEnabled=${braveEnabled}`,
          );

        // When the search limit has been reached, strip tools from the payload
        // so the model is forced to synthesize an answer. The loop exits naturally
        // when toolCallIntercepted is false (model wrote an answer, not a tool call).
        const forceFinalAnswer = searchLoopCount >= MAX_SEARCH_LOOPS;
        // When forcing a final answer, inject an explicit stop instruction so
        // aggressive tool-calling models (Qwen3.6, Gemma 4) don't try to search
        // again via text-stream fallback even though tools are stripped from the payload.
        const messagesForRequest = forceFinalAnswer
          ? [
              ...currentMessages,
              {
                role: "user" as const,
                content:
                  "[SYSTEM: You have used all permitted web searches. " +
                  "Do NOT emit any tool calls or <tool_call> tags. " +
                  "Write your complete final answer now using only the " +
                  "search results already provided above.]",
              },
            ]
          : currentMessages;
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

        // ── Provider-aware request body ──────────────────────────────────────
        const commonFields = {
          model: modelId,
          messages: messagesForRequest,
          temperature: temperature ?? (isNvidia ? 1 : 0.7),
          top_p: topP ?? 0.95,
          max_tokens: maxOutputTokens ?? 16384,
          stream: true,
        };

        // Tools payload — same logic for both providers
        // Snapshot of tool names sent to the model this iteration — used by the
        // registry screen below. Built from the same allTools array so disable/enable
        // state from McpServerManager is automatically respected.
        const validToolNames = new Set<string>()
        const toolsPayload = (() => {
          if (forceFinalAnswer) return {}; // strip tools — force synthesis pass
          const mcpTools = mcpServerManager.getToolSchemas();
          const allTools = [
            ...(braveEnabled ? [BRAVE_SEARCH_TOOL] : []),
            TICKER_TOOL,
            ...mcpTools,
          ];
          allTools.forEach((t) => validToolNames.add(t.function.name))
          if (DEBUG) {
            console.log(
              `[DEBUG] Tools sent (${allTools.length}):`,
              allTools.map((t) => t.function.name).join(", ") || "(none)",
            );
          }
          return allTools.length > 0
            ? { tools: allTools, tool_choice: "auto" }
            : {};
        })();

        let streamBody: string;
        if (isNvidia) {
          // NVIDIA Build payload — OpenAI-compatible, no LM Studio extensions.
          // thinking=true on large prompts causes 504s; only enable it when
          // the user explicitly chose thinking mode AND the prompt is not huge.
          const thinkingEnabled = payload.thinkingMode === "thinking";
          // Cap max_tokens for NVIDIA — their hosted inference has strict timeouts.
          // 16384 with thinking on a large prompt can cause 504s. Use 8192 by default.
          const nvidiaMaxTokens = Math.min(maxOutputTokens ?? 8192, 8192);
          // Recommended temps: 0.6 for thinking mode, 0.7 for non-thinking (Qwen3.5 docs)
          const nvidiaTemp = temperature ?? (thinkingEnabled ? 0.6 : 0.7);
          // Only send chat_template_kwargs for models that support it.
          // Qwen models use 'enable_thinking'; Mistral/Llama/Nemotron reject the field entirely.
          const isQwenModel = modelId.toLowerCase().includes("qwen");
          // Mistral Medium 3.5 uses reasoning_effort: 'high' | 'none' (not chat_template_kwargs)
          // Reasoning output streams in delta.reasoning (not delta.reasoning_content)
          const isMistralModel = modelId.toLowerCase().includes("mistral");
          const chatTemplateKwargs = isQwenModel
            ? { chat_template_kwargs: { enable_thinking: thinkingEnabled } }
            : {};
          // Only send reasoning_effort when thinking is ON.
          // Sending 'none' in fast mode causes slowdowns on NVIDIA's NIM endpoint
          // (confirmed regression: 28 tok/s → 3-7 tok/s). Omitting it entirely
          // restores the default fast path.
          const mistralReasoning =
            isMistralModel && thinkingEnabled
              ? { reasoning_effort: "high" }
              : {};
          streamBody = JSON.stringify({
            ...commonFields,
            temperature: nvidiaTemp,
            max_tokens: nvidiaMaxTokens,
            ...chatTemplateKwargs,
            ...mistralReasoning,
            stream_options: { include_usage: true },
            ...toolsPayload,
          });
        } else if (isOllama) {
          // ── Ollama /api/chat payload ──────────────────────────────────────────
          // Native NDJSON streaming. `think` activates chain-of-thought — response
          // carries message.thinking (separate from message.content) which the NDJSON
          // loop normalises to <think>…</think> inline. Generation params go under
          // `options`, not at the top level. Tool format is OpenAI-compatible.
          // Use messagesForRequest (not currentMessages) so the forceFinalAnswer
          // stop-search injection is included when searchLoopCount >= MAX.
          streamBody = JSON.stringify({
            model:    modelId,
            messages: buildOllamaMessages(messagesForRequest),
            stream:   true,
            think:    isThinking,
            options: {
              temperature: temperature ?? 0.7,
              top_p:       topP        ?? 0.95,
              num_predict: maxOutputTokens ?? 16384,
            },
            // When forcing a final answer, send tool_choice:'none' explicitly.
            // Ollama models (esp. Qwen3) ignore the absence of tools and still
            // emit tool_calls unless the API-level enforcement is present.
            ...(forceFinalAnswer
              ? { tool_choice: "none" }
              : toolsPayload),
          });
        } else if (isOpenRouter) {
          const thinkingEnabled = payload.thinkingMode === "thinking";
          const openRouterMaxTokens = Math.min(maxOutputTokens ?? 32768, 32768);
          const openRouterTemp = temperature ?? (thinkingEnabled ? 0.6 : 0.7);
          // Inject reasoning only when thinking is ON — omit field entirely in fast mode.
          const reasoningParam = thinkingEnabled
            ? { reasoning: { max_tokens: thinkingBudget } }
            : {};
          streamBody = JSON.stringify({
            ...commonFields,
            temperature:    openRouterTemp,
            max_tokens:     openRouterMaxTokens,
            ...reasoningParam,
            stream_options: { include_usage: true },
            ...toolsPayload,
          });
        } else {
          // LM Studio payload — unchanged from original
          const step2ThinkingField = isThinking
            ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } }
            : { thinking: { type: "disabled" } };

          streamBody = JSON.stringify({
            ...commonFields,
            repeat_penalty: repeatPenalty ?? 1.1,
            // NOTE: Do NOT send stop: STOP_SEQUENCES to LM Studio.
            // LM Studio handles EOS tokens natively per model; sending <|im_end|> /
            // <|endoftext|> as explicit stop sequences causes immediate stream
            // termination for Qwen and Gemma respectively — both emit these tokens
            // before any content, producing a 0-token empty response.
            // EOS tokens that leak into the content stream are stripped by
            // EOS_TOKENS_RE in the delta processing loop instead.
            ...step2ThinkingField,
            ...toolsPayload,
          });
        }

        const ollamaBaseUrl = (appSettings.ollamaBaseUrl ?? "https://ollama.com").replace(/\/$/, "");
        const endpoint = isNvidia
          ? NVIDIA_ENDPOINT
          : isOllama
            ? `${ollamaBaseUrl}/api/chat`
            : isOpenRouter
              ? OPENROUTER_ENDPOINT
              : LMS_ENDPOINT;
        const fetchHeaders: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (isNvidia) {
          const apiKey = appSettings.nvidiaApiKey ?? "";
          if (!apiKey)
            throw new Error(
              "NVIDIA API key is not configured. Set it in Settings → Backend.",
            );
          fetchHeaders["Authorization"] = `Bearer ${apiKey}`;
        } else if (isOllama) {
          const apiKey = appSettings.ollamaApiKey ?? "";
          if (apiKey) fetchHeaders["Authorization"] = `Bearer ${apiKey}`;
          // No error if absent — local Ollama instances don't require a key
        } else if (isOpenRouter) {
          const apiKey = appSettings.openrouterApiKey ?? "";
          if (!apiKey)
            throw new Error(
              "OpenRouter API key is not configured. Set it in Settings → Backend.",
            );
          fetchHeaders["Authorization"] = `Bearer ${apiKey}`;
        }

        if (DEBUG) {
          const bodyPreview = JSON.parse(streamBody) as Record<
            string,
            unknown
          > & { messages?: unknown[] };
          console.log(
            `[DEBUG][ChatService][Request] endpoint=${endpoint} provider=${provider} model=${modelId} loop=${searchLoopCount}`,
          );
          console.log(
            `[DEBUG][ChatService][Request] streamBody (sans messages):`,
            JSON.stringify({
              ...bodyPreview,
              messages: `[${bodyPreview.messages?.length ?? 0} messages]`,
            }),
          );
          console.log(
            `[DEBUG][ChatService][Request] message count=${currentMessages.length} last role=${currentMessages[currentMessages.length - 1]?.role}`,
          );
        }

        // 5d — messages_sent capture
        this._obsCapture({ type: 'messages_sent', payload: { messages: messagesForRequest }, ts: Date.now() })

        // Nuclear EOS sanitization — strip special tokens from the serialised
        // request body before it leaves the process. Catches any <|endoftext|>
        // (and similar) that survived buildMessages() processing, whether split
        // across chunk boundaries during streaming, stored via an older code
        // path, or present in any field (content, tool_calls args, etc.).
        // Safe: removes a known-invalid string from JSON content; result is
        // still valid JSON with shorter string values.
        const _eosBeforeNuclear = streamBody.match(EOS_TOKENS_RE);
        if (_eosBeforeNuclear) {
          // Always log — this is the production bug we are tracing.
          console.warn(
            `[EOS-TRACE] ⚠️  EOS token(s) found in streamBody BEFORE nuclear strip: ${JSON.stringify(_eosBeforeNuclear)} — loop=${searchLoopCount} provider=${provider}`,
          );
          // Scan each message in messagesForRequest to identify which one carries the token
          try {
            const _wireForTrace = JSON.parse(streamBody) as { messages?: Array<{ role: string; content: unknown; tool_calls?: unknown }> };
            (_wireForTrace.messages ?? []).forEach((wm, wi) => {
              const fields: Array<[string, string]> = [];
              if (typeof wm.content === 'string' && EOS_TOKENS_RE.test(wm.content)) {
                EOS_TOKENS_RE.lastIndex = 0;
                fields.push(['content', wm.content.slice(0, 200)]);
              }
              EOS_TOKENS_RE.lastIndex = 0;
              const tcStr = wm.tool_calls ? JSON.stringify(wm.tool_calls) : '';
              if (tcStr && EOS_TOKENS_RE.test(tcStr)) {
                EOS_TOKENS_RE.lastIndex = 0;
                fields.push(['tool_calls', tcStr.slice(0, 200)]);
              }
              EOS_TOKENS_RE.lastIndex = 0;
              if (fields.length > 0) {
                console.warn(
                  `[EOS-TRACE]   → message[${wi}] role=${wm.role} — EOS in: ${fields.map(([f, v]) => `${f}: "${v}"`).join(' | ')}`,
                );
              }
            });
          } catch (e) {
            console.warn('[EOS-TRACE]   → could not parse streamBody for per-message trace:', e);
          }
        }
        streamBody = streamBody.replace(EOS_TOKENS_RE, "");
        EOS_TOKENS_RE.lastIndex = 0;
        if (_eosBeforeNuclear) {
          console.warn(`[EOS-TRACE] ✅ Nuclear strip applied — ${_eosBeforeNuclear.length} token(s) removed.`);
        }

        const response = await net.fetch(endpoint, {
          method: "POST",
          headers: fetchHeaders,
          body: streamBody,
          signal: this.controller?.signal || signal,
        } as RequestInit);

        if (DEBUG) {
          console.log(
            `[DEBUG][ChatService][Response] HTTP ${response.status} ${response.statusText} provider=${provider}`,
          );
        }

        if (!response.ok) {
          const errText = await response.text();
          const label = isNvidia ? "NVIDIA Build" : isOllama ? "Ollama" : isOpenRouter ? "OpenRouter" : "LM Studio";
          // Always log the full error body — critical for diagnosing EOS/special-token rejections.
          console.warn(`[EOS-TRACE] OpenRouter HTTP ${response.status} error body: ${errText}`);
          // If OpenRouter rejected for special token, log which messages survived into the final streamBody.
          if (errText.includes('special token') || errText.includes('endoftext')) {
            console.warn('[EOS-TRACE] Special token rejection — dumping final streamBody message summary:');
            try {
              const _parsed = JSON.parse(streamBody) as { messages?: Array<{ role: string; content: unknown }> };
              (_parsed.messages ?? []).forEach((wm, wi) => {
                const cs = typeof wm.content === 'string' ? wm.content : JSON.stringify(wm.content);
                const hasEos = EOS_TOKENS_RE.test(cs);
                EOS_TOKENS_RE.lastIndex = 0;
                console.warn(`[EOS-TRACE]   streamBody[${wi}] role=${wm.role} chars=${cs.length} hasEOS=${hasEos} tail="${cs.slice(-120).replace(/\n/g, '↵')}"`)
              });
            } catch { /* ignore parse error */ }
          }
          if (DEBUG)
            console.log(
              `[DEBUG][ChatService][Response] ERROR body: ${errText}`,
            );
          throw new Error(`${label} ${response.status}: ${errText}`);
        }

        if (!response.body)
          throw new Error(
            `${isNvidia ? "NVIDIA Build" : isOllama ? "Ollama" : isOpenRouter ? "OpenRouter" : "LM Studio"} returned no response body`,
          );

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let loopAborted = false;
        let firstChunkProcessed = false;
        let streamBuffer = "";
        let toolCallIntercepted = false;
        let reasoningOpen = false;
        let hasNonWhitespaceContent = false;
        // true while inside a Gemma 4 MLX native <|channel>thought…<channel|> block;
        // prevents the Source A→C </think> injection from firing for mid-thought chunks.
        let inChannelThought = false;

        // Native tool call accumulator — keyed by index since models like Qwen
        // can emit multiple parallel tool calls (index 0, 1, 2...) in a single
        // response. Each slot accumulates its own id, name, and args independently.
        const pendingToolCalls: Map<
          number,
          {
            id: string;
            name: string;
            argsRaw: string;
          }
        > = new Map();

        while (true) {
          if (loopAborted) break;
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const raw of lines) {
            const line = raw.trim();

            // ── Normalise each line to deltaContent + deltaReasoning ──────────────────────────
            // Both branches produce the same two variables; all processing below is shared.
            let deltaContent   = "";
            let deltaReasoning = "";
            let ndjsonDone     = false;

            if (isOllama) {
              // ── Ollama NDJSON ─────────────────────────────────────────────────────────────
              if (!line) continue;
              let ollamaChunk: OllamaStreamChunk;
              try { ollamaChunk = JSON.parse(line); } catch { continue; }
              if (ollamaChunk.error) throw new Error(String(ollamaChunk.error));

              deltaContent   = ollamaChunk.message?.content  ?? "";
              deltaReasoning = ollamaChunk.message?.thinking ?? "";

              // Check for tool calls on EVERY chunk — Ollama may deliver them on
              // an intermediate chunk before done:true (model-dependent). We overwrite
              // the slot each time so the last, most-complete version always wins.
              // Preserving the original id prevents duplicate call_ timestamps.
              // Guard: ignore tool_calls when forcing a final answer — Qwen3 emits
              // them even when tool_choice:'none' is set, so we drop them here.
              if (ollamaChunk.message?.tool_calls?.length && !toolCallIntercepted && !forceFinalAnswer) {
                if (DEBUG)
                  console.log(
                    `[DEBUG][Ollama] tool_calls on chunk (done=${ollamaChunk.done}):`,
                    JSON.stringify(ollamaChunk.message.tool_calls),
                  );
                for (const [idx, tc] of ollamaChunk.message.tool_calls.entries()) {
                  pendingToolCalls.set(idx, {
                    id:      pendingToolCalls.get(idx)?.id ?? `call_${Date.now()}_${idx}`,
                    name:    tc.function.name,
                    argsRaw: JSON.stringify(tc.function.arguments ?? {}),
                  });
                }
              }

              if (ollamaChunk.done) {
                if (ollamaChunk.eval_count)        totalTokens  = ollamaChunk.eval_count;
                if (ollamaChunk.prompt_eval_count) promptTokens = ollamaChunk.prompt_eval_count;
                if (DEBUG)
                  console.log(
                    `[DEBUG][Ollama][DoneChunk] done_reason=${ollamaChunk.done_reason} pendingToolCalls.size=${pendingToolCalls.size} streamBuffer.length=${streamBuffer.length} message:`,
                    JSON.stringify(ollamaChunk.message),
                  );
                ndjsonDone = true;
              }

            } else {
              // ── SSE (LM Studio + NVIDIA) ──────────────────────────────────────────────────────
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
              try { parsed = JSON.parse(data); } catch { continue; }

              if (parsed.usage) {
                if (parsed.usage.prompt_tokens)     promptTokens = parsed.usage.prompt_tokens;
                if (parsed.usage.completion_tokens) totalTokens  = parsed.usage.completion_tokens;
                if (DEBUG && !parsed.choices?.length)
                  console.log(
                    `[DEBUG][ChatService][Usage] prompt_tokens=${parsed.usage.prompt_tokens} completion_tokens=${parsed.usage.completion_tokens} total_tokens=${parsed.usage.total_tokens}`,
                  );
              }

              const deltaToolCalls = parsed.choices?.[0]?.delta?.tool_calls;
              if (deltaToolCalls && deltaToolCalls.length > 0 && !toolCallIntercepted) {
                for (const tc of deltaToolCalls) {
                  const idx = (tc as { index?: number }).index ?? 0;
                  const existing = pendingToolCalls.get(idx);
                  if (!existing) {
                    pendingToolCalls.set(idx, {
                      id:      tc.id ?? `call_${Date.now()}_${idx}`,
                      name:    tc.function?.name ?? "brave_web_search",
                      argsRaw: tc.function?.arguments ?? "",
                    });
                  } else {
                    existing.argsRaw += tc.function?.arguments ?? "";
                  }
                }
              }

              deltaContent   = parsed.choices?.[0]?.delta?.content ?? "";
              deltaReasoning =
                parsed.choices?.[0]?.delta?.reasoning_content ??
                ((parsed.choices?.[0]?.delta as Record<string, unknown>)?.reasoning as string) ??
                "";
              const chunkFinishReason = parsed.choices?.[0]?.finish_reason;
              if (chunkFinishReason) capturedFinishReason = chunkFinishReason;
            }

            // ── Shared delta processing — identical for both providers ────────────────────────
            const CHAN_OPEN  = "<|channel>thought\n";
            const CHAN_CLOSE = "<channel|>";

            let delta = "";
            if (deltaReasoning) {
              delta = reasoningOpen ? deltaReasoning : "<think>" + deltaReasoning;
              reasoningOpen = true;
            } else if (deltaContent) {
              let chunk = deltaContent;
              if (chunk.includes(CHAN_OPEN)) {
                chunk = chunk.replace(CHAN_OPEN, "<think>");
                reasoningOpen    = true;
                inChannelThought = true;
              }
              if (chunk.includes(CHAN_CLOSE)) {
                chunk = chunk.replace(CHAN_CLOSE, "</think>");
                reasoningOpen    = false;
                inChannelThought = false;
              }
              if (reasoningOpen && !inChannelThought && !chunk.includes("</think>")) {
                chunk = "</think>" + chunk;
                reasoningOpen = false;
              }
              delta = chunk;
            }

            if (!delta) { if (ndjsonDone) break; continue; }

            if (DEBUG && !firstChunkProcessed)
              console.log("[DEBUG] First raw delta:", JSON.stringify(delta));

            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
              if (DEBUG)
                console.log(
                  `[DEBUG][ChatService][TTFT] First token arrived — ${firstTokenAt - startTime}ms since request start. provider=${provider} delta=${JSON.stringify(delta.slice(0, 80))}`,
                );
            }

            // Strip Qwen3 internal template tokens that occasionally leak into
            // the content stream and corrupt code blocks or fence syntax.
            const _rawForEosCheck = firstChunkProcessed ? delta : stripLeadingThinkClose(delta);
            const _eosInDelta = _rawForEosCheck.match(EOS_TOKENS_RE);
            if (_eosInDelta) {
              EOS_TOKENS_RE.lastIndex = 0;
              console.warn(
                `[EOS-TRACE] ⚠️  EOS token in stream delta: ${JSON.stringify(_eosInDelta)} — loop=${searchLoopCount} streamBuffer.length=${streamBuffer.length} bufferTail="${streamBuffer.slice(-80)}"`,
              );
            }
            EOS_TOKENS_RE.lastIndex = 0;
            const cleanedDelta = _rawForEosCheck
              .replace(/<\|mask_(?:start|end)\|>/gi, "")
              .replace(EOS_TOKENS_RE, "");
            EOS_TOKENS_RE.lastIndex = 0;
            firstChunkProcessed = true;
            if (!cleanedDelta) { if (ndjsonDone) break; continue; }

            streamBuffer += cleanedDelta;

            // 5e/5f — thinking_delta / answer_delta capture
            if (deltaReasoning) {
              this._obsCapture({ type: 'thinking_delta', payload: { text: deltaReasoning }, ts: Date.now() })
            } else if (reasoningOpen) {
              this._obsCapture({ type: 'thinking_delta', payload: { text: cleanedDelta }, ts: Date.now() })
            } else {
              this._obsCapture({ type: 'answer_delta', payload: { text: cleanedDelta }, ts: Date.now() })
            }

            // ── Mid-stream text-format tool call interception ─────────────────────────────────────
            if (!toolCallIntercepted) {
              const detected = detectMidStreamToolCall(streamBuffer);
              if (detected) {
                if (forceFinalAnswer) {
                  toolCallIntercepted = true;
                  this.abort();
                  loopAborted = true;
                  break;
                }
                const { query: midQuery, cleanedBuffer: cleanedSoFar } = detected;
                let patchedCleaned = cleanedSoFar;
                const openCount  = (patchedCleaned.match(/<think>/gi)  || []).length;
                const closeCount = (patchedCleaned.match(/<\/think>/gi) || []).length;
                if (openCount > closeCount) patchedCleaned += "\n</think>\n";

                toolCallIntercepted = true;
                console.log(`[MCP] 🔍 Brave Search (interception depth ${searchLoopCount + 1}): "${midQuery}"`);
                // 5g — tool_call capture (mid-stream fallback path)
                this._obsCapture({ type: 'tool_call', payload: { toolName: 'brave_web_search', args: { query: midQuery } }, ts: Date.now() })

                this.abort();
                loopAborted = true;
                flushChunkBuffer();

                send(IPC_CHANNELS.CHAT_STREAM_TOOL_START, { query: midQuery });

                let midStreamResult: string;
                try {
                  const results = await braveSearch(midQuery, resolvedKey!, 5);
                  midStreamResult = await augmentAndFormatResults(results);
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, {
                    query:            midQuery,
                    results:          results.slice(0, 5).map((r) => ({ title: r.title, url: r.url })),
                    formattedContent: midStreamResult,
                  });
                } catch (err) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  midStreamResult = `Web search failed: ${errMsg}. Answer from training knowledge.`;
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_ERROR, { query: midQuery, error: errMsg });
                }
                // 5h — tool_result capture (mid-stream fallback path)
                this._obsCapture({ type: 'tool_result', payload: { toolName: 'brave_web_search', result: midStreamResult }, ts: Date.now() })

                const toolCallId = `call_${Date.now()}`;
                const limit = getToolResultLimit()
                const toolContent = limit && typeof midStreamResult === 'string' && midStreamResult.length > limit
                  ? midStreamResult.slice(0, limit) + `\n\n[Result truncated at ${limit.toLocaleString()} chars to fit provider limit.]`
                  : midStreamResult
                currentMessages = [
                  ...currentMessages,
                  {
                    role: "assistant",
                    content: patchedCleaned || (null as unknown as string),
                    tool_calls: [{
                      id: toolCallId,
                      type: "function",
                      function: { name: "brave_web_search", arguments: JSON.stringify({ query: midQuery }) },
                    }],
                  } as { role: string; content: string },
                  {
                    role: "tool",
                    tool_call_id: toolCallId,
                    content: toolContent,
                  } as { role: string; content: string },
                ];

                this.controller = new AbortController();
                searchLoopCount++;
                break;
              }
            }

            // ── DSML tool call detection (DeepSeek V4 inline format) ───────────────────────
            // DeepSeek models on OpenRouter may emit tool calls directly in
            // delta.content using their DSML format rather than delta.tool_calls.
            // When a complete </｜DSML｜tool_calls> block lands in the buffer, parse
            // it into pendingToolCalls and strip it so nothing leaks to the UI.
            // The existing post-stream pendingToolCalls handler executes the calls.
            if (!toolCallIntercepted && !forceFinalAnswer) {
              const normBuf = streamBuffer
                .replace(/\uFF5C/g, "|")
                .replace(/\s*\|\s*/g, "|");
              if (normBuf.includes("</|DSML|tool_calls>")) {
                const dsmlParsed = parseDsmlToolCalls(streamBuffer);
                if (dsmlParsed.length > 0) {
                  dsmlParsed.forEach((tc, idx) => pendingToolCalls.set(idx, tc));
                  if (DEBUG)
                    console.log(
                      `[DEBUG][ChatService][DSML] Parsed ${dsmlParsed.length} DSML tool call(s):`,
                      dsmlParsed.map((t) => t.name).join(", "),
                    );
                  // Strip the DSML block from streamBuffer to prevent it reaching the UI.
                  streamBuffer = streamBuffer
                    .replace(/<\uFF5CDSML\uFF5Ctool_calls>[\s\S]*?<\/\uFF5CDSML\uFF5Ctool_calls>/g, "")
                    .replace(/<\|DSML\|tool_calls>[\s\S]*?<\/\|DSML\|tool_calls>/g, "")
                    .trim();
                }
              }
            }

            const chunkToSend = cleanedDelta.replace(/<\|tool_response>/gi, "");
            if (chunkToSend) {
              totalTokens += estimateTokens(chunkToSend);
              const hasOpenToolCallTag =
                streamBuffer.includes("<tool_call") ||
                streamBuffer.includes("<|tool_call>") ||
                // DSML: suppress rendering while a DeepSeek tool call block is accumulating
                // (before the close tag arrives). Check raw fullwidth-bar form and normalised ASCII.
                streamBuffer.includes("\uFF5CDSML\uFF5C") ||
                streamBuffer.replace(/\uFF5C/g, "|").replace(/\s*\|\s*/g, "|").includes("<|DSML|");
              if (!pendingToolCalls.size && !hasOpenToolCallTag) {
                if (chunkToSend.trim() || hasNonWhitespaceContent) {
                  hasNonWhitespaceContent = true;
                  accumulatedChunks.push(chunkToSend);
                  const now = Date.now();
                  if (now - lastFlushTime >= FLUSH_INTERVAL) {
                    flushChunkBuffer();
                  }
                }
              }
              lineBuffer += chunkToSend;
            }

            const newlineIdx = lineBuffer.indexOf("\n");
            if (newlineIdx !== -1) {
              const completedLine = lineBuffer.slice(0, newlineIdx).trim();
              lineBuffer = lineBuffer.slice(newlineIdx + 1);
              if (!reasoningOpen && completedLine.length > 0 && completedLine.length <= REPETITION_MAX_LEN) {
                if (completedLine === lastLine) {
                  consecutiveCount++;
                  if (consecutiveCount >= REPETITION_WINDOW) {
                    console.warn(
                      `[ChatService] 🔁 Repetition detected — "${completedLine}" repeated ${consecutiveCount} times. Aborting stream.`,
                    );
                    this.abort();
                    loopAborted = true;
                    break;
                  }
                } else {
                  lastLine       = completedLine;
                  consecutiveCount = 1;
                }
              }
            }

            if (ndjsonDone) break;
          }
        }
        flushChunkBuffer();
        if (DEBUG)
          console.log(
            `[Debug][ChatService][ReaderExit] loopAborted=${loopAborted} toolCallIntercepted=${toolCallIntercepted} pendingToolCalls.size=${pendingToolCalls.size} streamBuffer.length=${streamBuffer.length} totalTokens=${totalTokens}`,
          );

        // ── Native tool call handler ─────────────────────────────────────────────
        // Fires after the SSE stream ends naturally when delta.tool_calls[] was used.
        // Handles multiple parallel tool calls (Qwen emits index 0, 1, ... for each
        // query it wants to run simultaneously). Executes them sequentially, merges
        // results, and injects a valid assistant→tool[] pair into the wire payload.
        if (pendingToolCalls.size > 0 && !toolCallIntercepted && !forceFinalAnswer) {
          if (DEBUG)
            console.log(
              `[Debug][ChatService][NativeToolEnter] pendingToolCalls.size=${pendingToolCalls.size} toolNames=${[...pendingToolCalls.values()].map((t) => t.name).join(",")}`,
            );
          // Collect tool calls in index order.
          // For search tools: dedup by query string.
          // For MCP tools that have no "query" field (e.g. browser_navigate uses "url"):
          // use the tool name as the dedup key so they are never silently dropped.
          const queries: Array<{
            id: string;
            name: string;
            query: string;
            argsRaw: string;
          }> = [];
          const seenKeys = new Set<string>();
          for (const [, tc] of [...pendingToolCalls.entries()].sort(
            ([a], [b]) => a - b,
          )) {
            let query = "";
            try {
              const tcArgs = JSON.parse(tc.argsRaw);
              query =
                typeof tcArgs.query === "string"
                  ? tcArgs.query
                  : Array.isArray(tcArgs.queries)
                    ? (tcArgs.queries[0] ?? "")
                    : "";
            } catch {
              /* malformed args — proceed with empty query */
            }
            // Dedup key: use query string for search tools, tool name for others
            const dedupKey = query || tc.name;
            if (!seenKeys.has(dedupKey)) {
              seenKeys.add(dedupKey);
              queries.push({
                id: tc.id,
                name: tc.name,
                query,
                argsRaw: tc.argsRaw,
              });
            }
          }

          if (queries.length > 0) {
            toolCallIntercepted = true;
            console.log(
              `[MCP] \uD83D\uDD0D Native tool call(s): ${queries.map((q) => `"${q.query}"`).join(", ")}`,
            );

            // Build the assistant message with all tool_calls declared up front —
            // required by the OpenAI wire format before any role:tool messages.
            const assistantToolCalls = queries.map((q) => ({
              id: q.id,
              type: "function" as const,
              function: { name: q.name, arguments: q.argsRaw },
            }));
            currentMessages = [
              ...currentMessages,
              {
                role: "assistant",
                content: partialContentOrNull(streamBuffer) as unknown as string,
                tool_calls: assistantToolCalls,
              } as { role: string; content: string },
            ];

            // Execute each query, emitting its own search pill in the UI
            const allResultLinks: Array<{ title: string; url: string }> = [];
            const resultSections: string[] = [];
            for (const { id, name: toolName, query, argsRaw } of queries) {
              // ── Tool registry screen ────────────────────────────────────────────────────
              // Reject any tool call whose name is not in validToolNames (the set of tools
              // actually sent to the model this iteration). Blocked calls:
              //   - produce no UI pill (no TOOL_START / TOOL_DONE events)
              //   - produce no obsCapture event
              //   - inject a corrective role:tool message into the history so the model
              //     understands it must not retry the same unregistered call
              //   - preserve wire-format validity (every tool_call_id gets a tool result)
              if (!validToolNames.has(toolName)) {
                const correction = buildUnregisteredToolMessage(toolName, validToolNames)
                console.warn(
                  `[ChatService] ⛔ Tool registry screen blocked "${toolName}" — not in session schema. Correction fed back to model.`,
                )
                currentMessages = [
                  ...currentMessages,
                  { role: 'tool', tool_call_id: id, content: correction } as {
                    role: string
                    content: string
                  },
                ]
                continue
              }
              // ── End registry screen ─────────────────────────────────────────────────────

              // Dispatch: Ticker, Brave Search, or MCP custom tool (namespaced as serverName__toolName)
              const isTicker = toolName === "get_ticker_price";
              const isBrave = toolName === "brave_web_search";
              const mcpParts = !isBrave && !isTicker ? toolName.split("__") : null;
              const isMcp = !isBrave && !isTicker && mcpParts && mcpParts.length === 2;
              if (DEBUG)
                console.log(
                  `[Debug][ChatService][ToolDispatch] toolName=${toolName} query="${query}" isBrave=${isBrave} isMcp=${!isBrave && !!mcpParts && mcpParts.length === 2}`,
                );

              // uiLabel: what appears in the tool pill. For search tools use the query
              // string; for MCP tools use the namespaced name ("memory__search_nodes") so
              // the renderer can tell them apart from Brave searches.
              const uiLabel = isBrave ? query || toolName : toolName;
              send(IPC_CHANNELS.CHAT_STREAM_TOOL_START, {
                query: uiLabel,
                toolName,
              });
              // 5g — tool_call capture (native tool path)
              this._obsCapture({
                type: 'tool_call',
                payload: {
                  toolName,
                  args: (() => { try { return JSON.parse(argsRaw || '{}') as Record<string, unknown> } catch { return query ? { query } : {} } })(),
                },
                ts: Date.now(),
              })

              try {
                let toolResult: string;

                if (isTicker) {
                  // ── Built-in ticker price fetch via Yahoo Finance ──────────
                  const symbol = ((() => { try { return JSON.parse(argsRaw) } catch { return {} } })() as Record<string, string>).symbol ?? query;
                  const tickerResult = await fetchTickerPrice(symbol);
                  toolResult = tickerResult;

                  send(IPC_CHANNELS.CHAT_STREAM_TICKER_DONE, {
                    symbol,
                    formattedContent: tickerResult,
                  });

                  // Also emit a TOOL_DONE so the search pill renders (re-use query field as symbol)
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, {
                    query: symbol,
                    toolName,
                    results: [],
                    formattedContent: tickerResult,
                  });
                } else if (isBrave) {
                  // ── Existing Brave Search path — DO NOT MODIFY ────────────
                  const results = await braveSearch(query, resolvedKey!, 5);
                  const formatted = await augmentAndFormatResults(results);
                  const section =
                    queries.length > 1
                      ? `## Results for: "${query}"\n${formatted}`
                      : formatted;
                  resultSections.push(section);
                  const links = results
                    .slice(0, 3)
                    .map((r) => ({ title: r.title, url: r.url }));
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
                  try {
                    args = JSON.parse(argsRaw || "{}");
                  } catch {
                    /* use empty args */
                  }

                  console.log(
                    `[MCP] Calling "${toolName}" with args: ${argsRaw}`,
                  );
                  const mcpResult = await mcpServerManager.callTool(
                    serverName,
                    mcpToolName,
                    args,
                    payload.chatId ?? '',
                  );
                  toolResult = buildApprovedToolResult(mcpResult.text, mcpResult.userNote);
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, {
                    query: uiLabel,
                    toolName,
                    results: [],
                    formattedContent: mcpResult.text,
                    toolArgs: args,
                    toolImages: mcpResult.images,
                  });
                } else {
                  toolResult = `Unknown tool: ${toolName}`;
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, {
                    query: uiLabel,
                    toolName,
                    results: [],
                    formattedContent: toolResult,
                  });
                }
                // 5h — tool_result capture (native tool path)
                this._obsCapture({ type: 'tool_result', payload: { toolName, result: toolResult }, ts: Date.now() })

                const limit = getToolResultLimit()
                const toolContent = limit && typeof toolResult === 'string' && toolResult.length > limit
                  ? toolResult.slice(0, limit) + `\n\n[Result truncated at ${limit.toLocaleString()} chars to fit provider limit.]`
                  : toolResult
                currentMessages = [
                  ...currentMessages,
                  { role: "tool", tool_call_id: id, content: toolContent } as {
                    role: string;
                    content: string;
                  },
                ];
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                const isDenied = err instanceof McpDeniedError;
                const deniedContent = isDenied
                  ? buildDeniedToolMessage((err as McpDeniedError).userNote)
                  : `Tool failed: ${errMsg}. Use training knowledge.`;
                if (isDenied) {
                  // Permission denied — emit TOOL_DONE (not TOOL_ERROR) so the pill
                  // transitions out of the "searching" spinner. Without this the pill
                  // stays stuck on phase="searching" forever because TOOL_START was
                  // already emitted but no resolution event ever arrives.
                  const deniedNote = (err as McpDeniedError).userNote ?? 'Permission denied by user.';
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, {
                    query: uiLabel,
                    toolName,
                    results: [],
                    formattedContent: `[Denied] ${deniedNote}`,
                  });
                } else {
                  send(IPC_CHANNELS.CHAT_STREAM_TOOL_ERROR, {
                    query: uiLabel,
                    toolName,
                    error: errMsg,
                  });
                }
                currentMessages = [
                  ...currentMessages,
                  {
                    role: "tool",
                    tool_call_id: id,
                    content: deniedContent,
                  } as { role: string; content: string },
                ];
              }
            }

            this.controller = new AbortController();
            // Only Brave Search counts toward MAX_SEARCH_LOOPS — MCP tool calls
            // are unlimited and should never trigger the search-limit guard.
            const hadBraveCall = queries.some(
              (q) => q.name === "brave_web_search",
            );
            if (hadBraveCall) searchLoopCount++;
            if (DEBUG)
              console.log(
                `[Debug][ChatService][NativeToolExit] hadBraveCall=${hadBraveCall} searchLoopCount now=${searchLoopCount} toolCallIntercepted=${toolCallIntercepted}`,
              );
          }
        }

        if (DEBUG)
          console.log(
            `[Debug][ChatService][LoopExitCheck] toolCallIntercepted=${toolCallIntercepted} searchLoopCount=${searchLoopCount} MAX=${MAX_SEARCH_LOOPS} forceFinalAnswer=${forceFinalAnswer} willBreak=${!toolCallIntercepted}`,
          );

        if (!toolCallIntercepted) {
          // Model produced an answer — natural exit
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

        if (forceFinalAnswer && toolCallIntercepted) {
          // Tools were stripped but the model still intercepted a tool call via
          // text-stream fallback (detectMidStreamToolCall). This should not happen
          // in normal operation. Break and surface an error rather than looping forever.
          console.warn(
            "[ChatService] ⚠️ Tool call intercepted after tools were stripped — breaking to prevent infinite loop",
          );
          send(
            IPC_CHANNELS.CHAT_ERROR,
            "The model attempted to search again after the search limit was reached. Try rephrasing your question or reducing Max Search Rounds in Settings.",
          );
          const stats = this.buildStats(
            startTime,
            firstTokenAt,
            totalTokens,
            true,
            promptTokens,
          );
          send(IPC_CHANNELS.CHAT_STREAM_END, stats);
          return;
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
      flushChunkBuffer();
      this.controller = null;
      // 5i — session_end capture + flush
      this._obsCapture({
        type: 'session_end',
        payload: {
          finishReason:  capturedFinishReason,
          durationMs:    Date.now() - startTime,
          promptTokens:  promptTokens,
          outputTokens:  totalTokens,
        },
        ts: Date.now(),
      })
      await observabilityService.endSession(this.obsSessionId)
      this.obsSessionId = ''
    }

    if (DEBUG)
      console.log(
        `[Debug][ChatService][LoopExited] finalSearchLoopCount=${searchLoopCount} MAX=${MAX_SEARCH_LOOPS} totalTokens=${totalTokens} firstTokenAt=${firstTokenAt}`,
      );

    if (totalTokens === 0 && firstTokenAt === null) {
      if (DEBUG)
        console.log(
          `[Debug][ChatService][EmptyResponseGuard] FIRING — totalTokens=0 and firstTokenAt=null`,
        );
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
          tokenEstimate = (m.content as ContentPart[]).reduce(
            (partSum, part) => {
              if (part.type === "text") return partSum + countTokens(part.text);
              if (part.type === "image_url") return partSum + 1000; // ~1K tokens per image
              return partSum;
            },
            0,
          );
        } else {
          tokenEstimate = countTokens(JSON.stringify(m.content));
        }
        return sum + tokenEstimate + 4; // +4 per-message role overhead
      }, 0);
      if (DEBUG)
        console.log(
          `[DEV][ChatService] usage not emitted — computed promptTokens from wire payload: ${promptTokens}`,
        );
    }

    // answerTokens = the completion content that will actually appear in the next
    // request's context — i.e. totalTokens minus the thinking block, which
    // stripThinkBlocks removes before sending history to LM Studio.
    // lastStreamBuffer holds the final loop's full raw stream output (think + answer).
    const strippedAnswer = this.stripThinkBlocks(lastStreamBuffer);
    const answerTokens = countTokens(strippedAnswer);
    if (DEBUG)
      console.log(
        `[DEV][ChatService] answerTokens (stripped): ${answerTokens} / totalTokens: ${totalTokens}`,
      );

    const stats = this.buildStats(
      startTime,
      firstTokenAt,
      totalTokens,
      false,
      promptTokens,
      answerTokens,
    );
    if (DEBUG)
      console.log(
        `[Debug][ChatService][StreamEnd] sending CHAT_STREAM_END — ttft=${stats.ttft}ms tps=${stats.tokensPerSec} totalTokens=${stats.totalTokens} promptTokens=${stats.promptTokens} aborted=${stats.aborted}`,
      );
    send(IPC_CHANNELS.CHAT_STREAM_END, stats);
  }

  abort(): void {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    mcpServerManager.drainPendingPermissions();
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
    // Strip EOS tokens that may have been persisted before the stream-level fix
    content = content.replace(EOS_TOKENS_RE, "");

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
    isCloud = false,
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
    if (braveEnabled) systemParts.push(buildWebSearchAddendum(appSettings.maxSearchLoops ?? 4));
    if (!braveEnabled) systemParts.push(WEB_SEARCH_DISABLED_ADDENDUM);
    if (payload.systemPrompt) systemParts.push(payload.systemPrompt);

    // Gemma 4 thinking activation — Gemma does not support the `thinking:{type}`
    // payload field; instead it is activated by a <|think|> prefix in the system
    // prompt.  Detection is by model name (only route that is reliable here since
    // we don't yet have content to inspect).
    if (
      !isCloud &&
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
          {
            role: "assistant",
            content: compactedSummary,
          } as (typeof payload.messages)[0],
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
          { type: "text", text: (m.content as string).replace(EOS_TOKENS_RE, "") },
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
        // Sanitize: strip EOS tokens that may have been stored verbatim in the
        // DB before stream-level stripping was in place (or if the model leaked
        // them in a context-overflow edge case). OpenRouter rejects payloads
        // containing <|endoftext|> and similar special tokens immediately.
        const wireMsg: Record<string, unknown> = {
          role: m.role,
          content: typeof m.content === "string"
            ? m.content.replace(EOS_TOKENS_RE, "")
            : m.content,
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
      !isCloud &&
      payload.thinkingMode === "thinking" &&
      payload.model?.toLowerCase().includes("gemma") &&
      payload.model?.toLowerCase().includes("mlx")
    ) {
      msgs.push({ role: "assistant", content: "<|channel>thought\n" });
    }

    return msgs;
  }

  private _obsCapture(event: ObsEvent): void {
    if (!this.obsSessionId) return
    observabilityService.capture(this.obsSessionId, event)
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
