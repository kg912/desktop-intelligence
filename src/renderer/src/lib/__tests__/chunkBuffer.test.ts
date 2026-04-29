/**
 * chunkBuffer + wireMessages unit tests
 *
 * 42 tests covering every invariant of the extracted pure functions.
 * Zero React/DOM/Electron dependencies — plain Vitest + Node.
 */

import { describe, it, expect } from 'vitest'
import {
  partialTagSuffix,
  appendToBlock,
  ensureAnswerAndAppend,
  closeAnswerBlock,
  processBuffer,
  type BlockState,
  type BufferContext,
} from '../chunkBuffer'
import { buildWireMessages } from '../wireMessages'
import type { Message } from '../../components/chat/MessageBubble'
import type { MessageBlock } from '../../../../shared/types'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeId() {
  let i = 0
  return () => `id-${i++}`
}

function emptyCtx(): BufferContext {
  return { blocks: [], activeBlockId: null, inThinkBlock: false }
}

function makeMsg(overrides: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  return {
    id:          'msg-1',
    stats:       null,
    isThinking:  false,
    isStreaming:  false,
    isSearching:  false,
    error:       null,
    ...overrides,
  }
}

// ── partialTagSuffix ──────────────────────────────────────────────────────────

describe('partialTagSuffix', () => {
  it('1. empty buffer → 0', () => {
    expect(partialTagSuffix('', '<think>')).toBe(0)
  })

  it('2. buffer with no overlap → 0', () => {
    expect(partialTagSuffix('hello world', '<think>')).toBe(0)
  })

  it('3. buffer ending with the first char of <think> → 1', () => {
    expect(partialTagSuffix('hello <', '<think>')).toBe(1)
  })

  it('4. buffer ending with 4-char prefix of <think> → 4', () => {
    expect(partialTagSuffix('hello <thi', '<think>')).toBe(4)
  })

  it('5. buffer ending with the full tag minus one char → tag.length - 1', () => {
    // "<think" is 6 chars = tag.length - 1
    expect(partialTagSuffix('hello <think', '<think>')).toBe(6)
  })

  it('6. works correctly for </think> close tag', () => {
    expect(partialTagSuffix('thought</thi', '</think>')).toBe(5)
  })

  it('7. held-back text never contains the partial tag (safe slice)', () => {
    const buf = 'text<thi'
    const tag = '<think>'
    const partialLen = partialTagSuffix(buf, tag)
    const safe = buf.slice(0, buf.length - partialLen)
    // safe must not end with any prefix of tag that would confuse future processing
    expect(safe).toBe('text')
    expect(partialLen).toBe(4)
  })
})

// ── appendToBlock ─────────────────────────────────────────────────────────────

describe('appendToBlock', () => {
  it('8. appends text to a thinking block content', () => {
    const blocks: BlockState[] = [{ id: 'a', type: 'thinking', content: 'hello ' }]
    const result = appendToBlock(blocks, 'a', 'world')
    expect(result[0].content).toBe('hello world')
  })

  it('9. appends text to an answer block content', () => {
    const blocks: BlockState[] = [{ id: 'a', type: 'answer', content: 'foo ', isStreaming: true }]
    const result = appendToBlock(blocks, 'a', 'bar')
    expect(result[0].content).toBe('foo bar')
  })

  it('10. returns a new array (does not mutate input)', () => {
    const blocks: BlockState[] = [{ id: 'a', type: 'thinking', content: '' }]
    const result = appendToBlock(blocks, 'a', 'x')
    expect(result).not.toBe(blocks)
    expect(blocks[0].content).toBe('')  // original unchanged
  })

  it('11. no-ops when blockId is not found', () => {
    const blocks: BlockState[] = [{ id: 'a', type: 'thinking', content: 'hi' }]
    const result = appendToBlock(blocks, 'MISSING', 'x')
    expect(result).toBe(blocks)  // same reference — no allocation
  })

  it('12. multiple appends accumulate correctly', () => {
    let blocks: BlockState[] = [{ id: 'a', type: 'thinking', content: '' }]
    blocks = appendToBlock(blocks, 'a', 'one ')
    blocks = appendToBlock(blocks, 'a', 'two ')
    blocks = appendToBlock(blocks, 'a', 'three')
    expect(blocks[0].content).toBe('one two three')
  })
})

// ── ensureAnswerAndAppend ─────────────────────────────────────────────────────

describe('ensureAnswerAndAppend', () => {
  it('13. no active block → creates AnswerBlock, sets activeBlockId, appends text', () => {
    const genId = makeId()
    const ctx = emptyCtx()
    const result = ensureAnswerAndAppend(ctx, 'hello', genId)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].type).toBe('answer')
    expect(result.blocks[0].content).toBe('hello')
    expect(result.activeBlockId).toBe(result.blocks[0].id)
  })

  it('14. active answer block → appends to it, no second block created', () => {
    const genId = makeId()
    const ctx: BufferContext = {
      blocks:        [{ id: 'id-0', type: 'answer', content: 'hey ', isStreaming: true }],
      activeBlockId: 'id-0',
      inThinkBlock:  false,
    }
    const result = ensureAnswerAndAppend(ctx, 'there', genId)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].content).toBe('hey there')
    expect(result.activeBlockId).toBe('id-0')
  })

  it('15. active block is thinking → creates new AnswerBlock alongside it', () => {
    const genId = makeId()
    const ctx: BufferContext = {
      blocks:        [{ id: 'id-0', type: 'thinking', content: 'thought' }],
      activeBlockId: 'id-0',
      inThinkBlock:  false,
    }
    const result = ensureAnswerAndAppend(ctx, 'answer', genId)
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[1].type).toBe('answer')
    expect(result.blocks[1].content).toBe('answer')
    expect(result.activeBlockId).toBe(result.blocks[1].id)
  })

  it('16. new block has isStreaming: true', () => {
    const genId = makeId()
    const result = ensureAnswerAndAppend(emptyCtx(), 'x', genId)
    expect(result.blocks[0].isStreaming).toBe(true)
  })

  it('17. does not modify the thinking block when creating a new answer block', () => {
    const genId = makeId()
    const thinkBlock: BlockState = { id: 'id-0', type: 'thinking', content: 'thought' }
    const ctx: BufferContext = {
      blocks:        [thinkBlock],
      activeBlockId: 'id-0',
      inThinkBlock:  false,
    }
    const result = ensureAnswerAndAppend(ctx, 'answer', genId)
    expect(result.blocks[0]).toEqual(thinkBlock)  // thinking block unchanged
  })
})

// ── closeAnswerBlock ──────────────────────────────────────────────────────────

describe('closeAnswerBlock', () => {
  it('18. sets isStreaming: false on the target answer block', () => {
    const blocks: BlockState[] = [{ id: 'a', type: 'answer', content: 'hi', isStreaming: true }]
    const result = closeAnswerBlock(blocks, 'a')
    expect(result[0].isStreaming).toBe(false)
  })

  it('19. does not modify other blocks', () => {
    const blocks: BlockState[] = [
      { id: 'a', type: 'answer', content: 'a', isStreaming: true },
      { id: 'b', type: 'answer', content: 'b', isStreaming: true },
    ]
    const result = closeAnswerBlock(blocks, 'a')
    expect(result[1].isStreaming).toBe(true)  // 'b' untouched
  })

  it('20. returns a new array (immutable)', () => {
    const blocks: BlockState[] = [{ id: 'a', type: 'answer', content: 'hi', isStreaming: true }]
    const result = closeAnswerBlock(blocks, 'a')
    expect(result).not.toBe(blocks)
  })

  it('21. no-ops when blockId is not found', () => {
    const blocks: BlockState[] = [{ id: 'a', type: 'answer', content: 'hi', isStreaming: true }]
    const result = closeAnswerBlock(blocks, 'MISSING')
    expect(result).toBe(blocks)  // same reference
  })
})

// ── processBuffer — core state machine ───────────────────────────────────────

describe('processBuffer', () => {
  it('22. pure answer text → routed to answer block, remaining empty', () => {
    const genId = makeId()
    const r = processBuffer('hello world', emptyCtx(), genId)
    expect(r.remaining).toBe('')
    expect(r.ctx.blocks).toHaveLength(1)
    expect(r.ctx.blocks[0].type).toBe('answer')
    expect(r.ctx.blocks[0].content).toBe('hello world')
  })

  it('23. <think> open tag: text before → answer, text after → thinking, inThinkBlock=true', () => {
    const genId = makeId()
    const r = processBuffer('before<think>thought', emptyCtx(), genId)
    expect(r.ctx.blocks).toHaveLength(2)
    expect(r.ctx.blocks[0].type).toBe('answer')
    expect(r.ctx.blocks[0].content).toBe('before')
    expect(r.ctx.blocks[1].type).toBe('thinking')
    expect(r.ctx.blocks[1].content).toBe('thought')
    expect(r.ctx.inThinkBlock).toBe(true)
  })

  it('24. </think> close tag while inThinkBlock: thought committed, inThinkBlock=false, activeBlockId=null', () => {
    const genId = makeId()
    // Start in think mode
    const startCtx: BufferContext = {
      blocks:        [{ id: 'id-0', type: 'thinking', content: '' }],
      activeBlockId: 'id-0',
      inThinkBlock:  true,
    }
    const r = processBuffer('reasoning</think>', startCtx, genId)
    expect(r.ctx.inThinkBlock).toBe(false)
    expect(r.ctx.activeBlockId).toBeNull()
    expect(r.ctx.blocks[0].content).toBe('reasoning')
    expect(r.remaining).toBe('')
  })

  it('25. text after </think> flows into a NEW answer block', () => {
    const genId = makeId()
    const startCtx: BufferContext = {
      blocks:        [{ id: 'id-0', type: 'thinking', content: '' }],
      activeBlockId: 'id-0',
      inThinkBlock:  true,
    }
    const r = processBuffer('reasoning</think>answer text', startCtx, genId)
    const answerBlock = r.ctx.blocks.find((b) => b.type === 'answer')
    expect(answerBlock).toBeDefined()
    expect(answerBlock?.content).toBe('answer text')
  })

  it('26. partial <think at end of buffer: safe text flushed, partial held in remaining', () => {
    const genId = makeId()
    // Buffer ends with partial open tag
    const r = processBuffer('hello <thi', emptyCtx(), genId)
    expect(r.remaining).toBe('<thi')
    expect(r.ctx.blocks[0].content).toBe('hello ')
    expect(r.ctx.inThinkBlock).toBe(false)
  })

  it('27. partial </think at end of buffer while in think mode: safe text flushed, partial held', () => {
    const genId = makeId()
    const startCtx: BufferContext = {
      blocks:        [{ id: 'id-0', type: 'thinking', content: '' }],
      activeBlockId: 'id-0',
      inThinkBlock:  true,
    }
    const r = processBuffer('thought</thi', startCtx, genId)
    expect(r.remaining).toBe('</thi')
    expect(r.ctx.blocks[0].content).toBe('thought')
    expect(r.ctx.inThinkBlock).toBe(true)
  })

  it('28. mutated: false when buffer is empty', () => {
    const genId = makeId()
    const r = processBuffer('', emptyCtx(), genId)
    expect(r.mutated).toBe(false)
  })

  it('29. mutated: true when any text was routed', () => {
    const genId = makeId()
    const r = processBuffer('hi', emptyCtx(), genId)
    expect(r.mutated).toBe(true)
  })

  it('30. multiple processBuffer calls accumulate — simulates "hello <think>reasoning</think> world"', () => {
    const genId = makeId()

    // Call 1: "hello <think>"
    let ctx = emptyCtx()
    let r = processBuffer('hello <think>', ctx, genId)
    ctx = r.ctx

    // Call 2: "reasoning</think>"
    r = processBuffer(r.remaining + 'reasoning</think>', ctx, genId)
    ctx = r.ctx

    // Call 3: " world"
    r = processBuffer(r.remaining + ' world', ctx, genId)
    ctx = r.ctx

    const answerBlocks  = ctx.blocks.filter((b) => b.type === 'answer')
    const thinkBlocks   = ctx.blocks.filter((b) => b.type === 'thinking')
    expect(thinkBlocks).toHaveLength(1)
    expect(thinkBlocks[0].content).toBe('reasoning')
    expect(answerBlocks).toHaveLength(2)
    expect(answerBlocks[0].content).toBe('hello ')
    expect(answerBlocks[1].content).toBe(' world')
  })

  it('31. think tag split across two chunks: no text leaks into answer', () => {
    const genId = makeId()
    let ctx = emptyCtx()

    // Chunk 1: partial open tag
    let r = processBuffer('<thi', ctx, genId)
    ctx = r.ctx
    expect(r.remaining).toBe('<thi')
    expect(ctx.blocks).toHaveLength(0)   // nothing routed yet

    // Chunk 2: remainder completes the tag
    r = processBuffer(r.remaining + 'nk>thought', ctx, genId)
    ctx = r.ctx

    expect(ctx.blocks).toHaveLength(1)
    expect(ctx.blocks[0].type).toBe('thinking')
    expect(ctx.blocks[0].content).toBe('thought')
    expect(ctx.inThinkBlock).toBe(true)
  })

  it('32. close tag split across two chunks: thought committed, answer starts fresh', () => {
    const genId = makeId()

    // Pre-condition: we are inside a think block with some content
    const startCtx: BufferContext = {
      blocks:        [{ id: 'id-0', type: 'thinking', content: '' }],
      activeBlockId: 'id-0',
      inThinkBlock:  true,
    }

    // Chunk 1: thought text + partial close tag
    let r = processBuffer('thought</thi', startCtx, genId)
    let ctx = r.ctx
    expect(r.remaining).toBe('</thi')
    expect(ctx.blocks[0].content).toBe('thought')

    // Chunk 2: remainder completes close tag + answer text
    r = processBuffer(r.remaining + 'nk>answer', ctx, genId)
    ctx = r.ctx

    expect(ctx.inThinkBlock).toBe(false)
    const answerBlock = ctx.blocks.find((b) => b.type === 'answer')
    expect(answerBlock?.content).toBe('answer')
  })

  it('33. closes think block at FIRST </think> — documents streaming behavior differs from parseThinkBlocks', () => {
    /**
     * IMPORTANT BEHAVIORAL NOTE:
     * processBuffer uses indexOf (first match) while parseThinkBlocks uses lastIndexOf.
     *
     * During streaming, each chunk is processed as it arrives. When a model mentions
     * "</think>" inside its own thought (e.g. while explaining tag syntax), the first
     * occurrence is processed and closes the think block. This is correct for streaming
     * because the model will not write "</think>" mid-thought in a single SSE event;
     * actual reasoning content arrives token by token.
     *
     * parseThinkBlocks operates on the complete accumulated string and uses lastIndexOf
     * to handle Qwen models that mention </think> inside their reasoning. The two
     * functions have different contexts and intentionally different behaviors.
     */
    const genId = makeId()
    const ctx   = emptyCtx()

    // Model writes: <think>I know about </think> tags</think>final answer
    // The FIRST </think> (after "I know about ") closes the block.
    const r = processBuffer('<think>I know about </think> tags</think>final answer', ctx, genId)

    const thinkBlock  = r.ctx.blocks.find((b) => b.type === 'thinking')
    const answerBlock = r.ctx.blocks.find((b) => b.type === 'answer')

    // First </think> closes at "I know about " — everything after is answer
    expect(thinkBlock?.content).toBe('I know about ')
    // " tags</think>final answer" goes to answer (in answer mode, </think> is plain text)
    expect(answerBlock?.content).toBe(' tags</think>final answer')
    expect(r.ctx.inThinkBlock).toBe(false)
  })

  it('34. empty <think></think> followed by answer text — answer block receives the text', () => {
    const genId = makeId()
    const r = processBuffer('<think></think>answer', emptyCtx(), genId)

    expect(r.ctx.blocks).toHaveLength(2)
    const thinkBlock  = r.ctx.blocks[0]
    const answerBlock = r.ctx.blocks[1]

    expect(thinkBlock.type).toBe('thinking')
    expect(thinkBlock.content).toBe('')  // empty think block created

    expect(answerBlock.type).toBe('answer')
    expect(answerBlock.content).toBe('answer')
    expect(r.ctx.inThinkBlock).toBe(false)
  })
})

// ── wireMessages — buildWireMessages ─────────────────────────────────────────

describe('buildWireMessages', () => {
  const idGen = () => 'tcid-fixed'

  it('35. divider messages are filtered out', () => {
    const msgs: Message[] = [
      makeMsg({ id: 'd', role: 'divider', content: '— Thinking —' }),
      makeMsg({ id: 'u', role: 'user',    content: 'hi' }),
    ]
    const wire = buildWireMessages(msgs, idGen)
    expect(wire).toHaveLength(1)
    expect(wire[0].role).toBe('user')
  })

  it('36. plain user/assistant messages map to { role, content } wire format', () => {
    const msgs: Message[] = [
      makeMsg({ id: '1', role: 'user',      content: 'hello' }),
      makeMsg({ id: '2', role: 'assistant', content: 'world' }),
    ]
    const wire = buildWireMessages(msgs, idGen)
    expect(wire).toHaveLength(2)
    expect(wire[0]).toEqual({ role: 'user', content: 'hello' })
    expect(wire[1]).toEqual({ role: 'assistant', content: 'world' })
  })

  it('37. assistant with doneSearchBlock emits [assistant+tool_calls, tool+tool_call_id]', () => {
    const searchBlock: MessageBlock = {
      id:               's1',
      type:             'search',
      query:            'test query',
      phase:            'done',
      results:          [{ title: 'R', url: 'https://r.com' }],
      formattedContent: 'formatted result text',
    }
    const msgs: Message[] = [
      makeMsg({
        id:      'a1',
        role:    'assistant',
        content: 'answer',
        blocks:  [searchBlock],
      }),
    ]
    const wire = buildWireMessages(msgs, idGen)
    expect(wire).toHaveLength(2)
    expect(wire[0].role).toBe('assistant')
    expect(wire[0].tool_calls).toHaveLength(1)
    expect(wire[1].role).toBe('tool')
  })

  it('38. tool_call_id on assistant.tool_calls[0].id matches tool message tool_call_id', () => {
    const searchBlock: MessageBlock = {
      id:               's1',
      type:             'search',
      query:            'q',
      phase:            'done',
      formattedContent: 'result',
    }
    const msgs: Message[] = [
      makeMsg({ id: 'a1', role: 'assistant', content: 'a', blocks: [searchBlock] }),
    ]
    const wire = buildWireMessages(msgs, idGen)
    const assistantWire = wire[0]
    const toolWire      = wire[1]
    expect(assistantWire.tool_calls![0].id).toBe(toolWire.tool_call_id)
  })

  it('39. only LAST tool call gets full formattedContent — earlier get stub', () => {
    let idCounter = 0
    const localGen = () => `id-${idCounter++}`

    const makeSearch = (query: string): MessageBlock => ({
      id:               query,
      type:             'search',
      query,
      phase:            'done',
      formattedContent: `full content for ${query}`,
    })

    const msgs: Message[] = [
      makeMsg({ id: 'm1', role: 'assistant', content: 'a', blocks: [makeSearch('first')] }),
      makeMsg({ id: 'm2', role: 'user',      content: 'follow-up' }),
      makeMsg({ id: 'm3', role: 'assistant', content: 'b', blocks: [makeSearch('second')] }),
    ]

    const wire = buildWireMessages(msgs, localGen)
    // m1 → [assistant+tool_calls, tool]  (old turn → stub)
    // m2 → [plain user]
    // m3 → [assistant+tool_calls, tool]  (last tool turn → full content)
    expect(wire).toHaveLength(5)

    const firstToolResult  = wire[1].content   // stub for 'first'
    const secondToolResult = wire[4].content   // full for 'second'

    expect(firstToolResult).toBe('[Previous tool call: first]')
    expect(secondToolResult).toBe('full content for second')
  })

  it('40. legacy toolCall field handled identically to block-based path (single turn)', () => {
    const msgs: Message[] = [
      makeMsg({
        id:      'a1',
        role:    'assistant',
        content: 'answer',
        toolCall: {
          query:            'legacy query',
          results:          [{ title: 'T', url: 'https://t.com' }],
          formattedContent: 'legacy formatted',
        },
      }),
    ]
    const wire = buildWireMessages(msgs, idGen)
    expect(wire).toHaveLength(2)
    expect(wire[0].tool_calls![0].function.name).toBe('brave_web_search')
    expect(wire[0].tool_calls![0].function.arguments).toBe(
      JSON.stringify({ query: 'legacy query' }),
    )
    expect(wire[1].content).toBe('legacy formatted')
    expect(wire[1].role).toBe('tool')
  })

  it('41. empty messages array → returns empty array', () => {
    expect(buildWireMessages([], idGen)).toEqual([])
  })

  it('42. message array with only a divider → returns empty array', () => {
    const msgs: Message[] = [
      makeMsg({ id: 'd', role: 'divider', content: '— mode —' }),
    ]
    expect(buildWireMessages(msgs, idGen)).toEqual([])
  })
})
