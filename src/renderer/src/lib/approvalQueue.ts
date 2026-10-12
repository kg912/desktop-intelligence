// Per-agent permission queues for a multi-agent run (specs/multi-agent-ui-improvements.md, Goal 3).
// The requests array (Layout's mcpPermissionRequests) is the single source of truth, in arrival
// order; everything here is derived from it, so the list, focus view and graph cannot disagree.

import type { McpToolPermissionRequest } from '../../../shared/types'

/** agentId → that agent's pending requests, oldest first (FIFO). Only requests of `runId`. */
export function approvalQueues(requests: McpToolPermissionRequest[], runId: string): Map<string, McpToolPermissionRequest[]> {
  const queues = new Map<string, McpToolPermissionRequest[]>()
  for (const r of requests) {
    if (r.agent?.runId !== runId) continue
    const queue = queues.get(r.agent.agentId)
    if (queue) queue.push(r)
    else queues.set(r.agent.agentId, [r])
  }
  return queues
}

/** "brave__web_search" → "web_search"; built-ins and plain names are unchanged. */
export const bareTool = (toolName: string): string => (toolName.includes('__') ? toolName.split('__').slice(1).join('__') : toolName)

export interface InboxSummary {
  total: number
  agents: number
  /** The tool with the most waiting calls (ties → the one that asked first); bulk trust targets it. */
  topTool: { serverName: string; toolName: string; count: number } | null
}

export function inboxSummary(queues: Map<string, McpToolPermissionRequest[]>): InboxSummary {
  const counts = new Map<string, { serverName: string; toolName: string; count: number }>()
  let total = 0
  for (const queue of queues.values()) {
    for (const r of queue) {
      total++
      const key = `${r.serverName}\u0000${r.toolName}`
      const entry = counts.get(key) ?? { serverName: r.serverName, toolName: r.toolName, count: 0 }
      entry.count++
      counts.set(key, entry)
    }
  }
  let topTool: InboxSummary['topTool'] = null
  for (const entry of counts.values()) if (!topTool || entry.count > topTool.count) topTool = entry
  return { total, agents: queues.size, topTool }
}

/**
 * The next (dir 1) or previous (dir −1) agent in plan order with a waiting call, after `current`,
 * wrapping around. With no current agent, the first (or last) one.
 */
export function nextWaiting(order: string[], queues: Map<string, McpToolPermissionRequest[]>, current: string | null, dir: 1 | -1 = 1): string | null {
  const waiting = order.filter((id) => (queues.get(id)?.length ?? 0) > 0)
  if (waiting.length === 0) return null
  const at = current ? order.indexOf(current) : -1
  if (at < 0) return dir === 1 ? waiting[0] : waiting[waiting.length - 1]
  const after = dir === 1 ? waiting.find((id) => order.indexOf(id) > at) : [...waiting].reverse().find((id) => order.indexOf(id) < at)
  return after ?? (dir === 1 ? waiting[0] : waiting[waiting.length - 1])
}

/** One-line argument summary: `q: "Kratos insider selling"` · `url: https://…`. */
export function argsSummary(args: Record<string, unknown>): string {
  return Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' && /^https?:\/\//.test(v) ? v : JSON.stringify(v)}`).join(' · ')
}
