import { braveWorkerTools } from './BraveSearchService'
import { TICKER_TOOL, fetchTickerPrice } from './ChatService'
import type { LMStudioTool } from './McpServerManager'

// Electron-side tools offered to multi-agent workers (server "builtin"). Lives
// here, not in BraveSearchService, because ChatService already imports that file.
// The ticker schema is ChatService's, renamed, so the two paths cannot drift.

const TICKER_WORKER_TOOL: LMStudioTool = {
  type: 'function',
  function: {
    name: 'builtin__get_ticker_price',
    description: TICKER_TOOL.function.description,
    parameters: { ...TICKER_TOOL.function.parameters, required: [...TICKER_TOOL.function.parameters.required] },
  },
}

export const workerBuiltinTools = {
  /** Ticker always (no key needed); Brave only when enabled and keyed. */
  getToolSchemas(): LMStudioTool[] {
    return [...braveWorkerTools.getToolSchemas(), TICKER_WORKER_TOOL]
  },
  /** Plain text only: no renderer events (CHAT_STREAM_TICKER_DONE is single-chat UI). */
  async call(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (toolName !== 'get_ticker_price') return braveWorkerTools.call(toolName, args)
    const symbol = args.symbol
    if (typeof symbol !== 'string' || !symbol.trim()) throw new Error('get_ticker_price needs a non-empty string symbol')
    return await fetchTickerPrice(symbol)
  },
}
