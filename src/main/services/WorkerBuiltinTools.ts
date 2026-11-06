import { webSearchWorkerTools } from './search/webSearchTools'
import type { WorkerSearchContext } from './search/webSearchTools'
import { TICKER_TOOL, fetchTickerPrice } from './ChatService'
import type { LMStudioTool } from './McpServerManager'

// Electron-side tools offered to multi-agent workers (server "builtin"). Lives
// here, not in search/, because ChatService already imports that code.
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
  /** Ticker always (no key needed); web search only when isWebSearchReady(). */
  getToolSchemas(): LMStudioTool[] {
    return [...webSearchWorkerTools.getToolSchemas(), TICKER_WORKER_TOOL]
  },
  /** Plain text only: no renderer events (CHAT_STREAM_TICKER_DONE is single-chat UI). */
  async call(toolName: string, args: Record<string, unknown>, ctx?: WorkerSearchContext): Promise<string> {
    if (toolName !== 'get_ticker_price') return webSearchWorkerTools.call(toolName, args, ctx)
    const symbol = args.symbol
    if (typeof symbol !== 'string' || !symbol.trim()) throw new Error('get_ticker_price needs a non-empty string symbol')
    return await fetchTickerPrice(symbol)
  },
}
