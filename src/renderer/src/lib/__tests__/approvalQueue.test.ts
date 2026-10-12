import { describe, it, expect } from 'vitest'
import { approvalQueues, argsSummary, inboxSummary, nextWaiting } from '../approvalQueue'
import type { McpToolPermissionRequest } from '../../../../shared/types'

const req = (requestId: string, agentId: string, toolName = 'brave__web_search', runId = 'run-1'): McpToolPermissionRequest => ({
  serverName: toolName.split('__')[0], toolName, args: {}, requestId, chatId: 'c', agent: { runId, agentId, role: 'R', model: 'm' },
})

describe('approvalQueues', () => {
  it('per-agent FIFO in arrival order, interleaved arrivals split by agent', () => {
    const q = approvalQueues([req('a1', '1.1'), req('b1', '1.2'), req('a2', '1.1'), req('b2', '1.2'), req('a3', '1.1')], 'run-1')
    expect([...q.keys()]).toEqual(['1.1', '1.2'])
    expect(q.get('1.1')!.map((r) => r.requestId)).toEqual(['a1', 'a2', 'a3'])
    expect(q.get('1.2')!.map((r) => r.requestId)).toEqual(['b1', 'b2'])
  })
  it('resolving the head leaves the next one at the head', () => {
    const all = [req('a1', '1.1'), req('a2', '1.1')]
    expect(approvalQueues(all.filter((r) => r.requestId !== 'a1'), 'run-1').get('1.1')![0].requestId).toBe('a2')
  })
  it('ignores other runs and non-agent requests', () => {
    const plain = { ...req('x', '1.1'), agent: undefined }
    expect(approvalQueues([req('o', '1.1', 'b__t', 'run-2'), plain], 'run-1').size).toBe(0)
  })
})

describe('inboxSummary', () => {
  it('counts calls and agents; the most-requested tool is the bulk-trust target', () => {
    const q = approvalQueues([req('1', '1.1', 'fetch__get'), req('2', '1.1'), req('3', '1.2'), req('4', '1.3'), req('5', '1.3', 'fetch__get')], 'run-1')
    expect(inboxSummary(q)).toEqual({ total: 5, agents: 3, topTool: { serverName: 'brave', toolName: 'brave__web_search', count: 3 } })
  })
  it('empty', () => {
    expect(inboxSummary(new Map())).toEqual({ total: 0, agents: 0, topTool: null })
  })
})

describe('nextWaiting', () => {
  const order = ['1.1', '1.2', '1.3', '1.4']
  const q = approvalQueues([req('a', '1.2'), req('b', '1.4')], 'run-1')
  it('moves forward and back in plan order, wrapping', () => {
    expect(nextWaiting(order, q, null)).toBe('1.2')
    expect(nextWaiting(order, q, '1.2')).toBe('1.4')
    expect(nextWaiting(order, q, '1.4')).toBe('1.2')
    expect(nextWaiting(order, q, '1.3', -1)).toBe('1.2')
    expect(nextWaiting(order, q, '1.2', -1)).toBe('1.4')
    expect(nextWaiting(order, q, null, -1)).toBe('1.4')
  })
  it('none waiting', () => {
    expect(nextWaiting(order, new Map(), '1.1')).toBeNull()
  })
})

describe('argsSummary', () => {
  it('key: value pairs, URLs unquoted', () => {
    expect(argsSummary({ q: 'Kratos 2026', url: 'https://x.com/a', n: 3 })).toBe('q: "Kratos 2026" · url: https://x.com/a · n: 3')
  })
})
