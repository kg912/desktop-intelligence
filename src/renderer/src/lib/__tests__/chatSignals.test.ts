import { describe, it, expect, beforeEach } from 'vitest'
import {
  completedMessages,
  streamingMessage,
  streamingBlocks,
  streamingStats,
  isStreamingSignal,
  allMessages
} from '../../signals/chatSignals'

describe('chatSignals', () => {
  beforeEach(() => {
    // Reset signals to default values before each test
    completedMessages.value = []
    streamingMessage.value = null
    streamingBlocks.value = []
    streamingStats.value = null
    isStreamingSignal.value = false
  })

  it('has correct default signal values', () => {
    expect(completedMessages.value).toEqual([])
    expect(streamingMessage.value).toBeNull()
    expect(streamingBlocks.value).toEqual([])
    expect(streamingStats.value).toBeNull()
    expect(isStreamingSignal.value).toBe(false)
  })

  it('updates signal values correctly when mutated', () => {
    isStreamingSignal.value = true
    expect(isStreamingSignal.value).toBe(true)

    const mockMsg = { id: '1', role: 'user', content: 'test msg' } as any
    streamingMessage.value = mockMsg
    expect(streamingMessage.value).toBe(mockMsg)

    const mockBlock = { type: 'text', content: 'chunk' } as any
    streamingBlocks.value = [mockBlock]
    expect(streamingBlocks.value).toEqual([mockBlock])

    const stats = { durationMs: 100, tps: 10 } as any
    streamingStats.value = stats
    expect(streamingStats.value).toBe(stats)
  })

  describe('computed: allMessages', () => {
    it('returns only completedMessages when streamingMessage is null', () => {
      const mockHistory = [
        { id: '1', role: 'user', content: 'hello' },
        { id: '2', role: 'assistant', content: 'hi' },
      ] as any[]
      completedMessages.value = mockHistory

      expect(allMessages.value).toEqual(mockHistory)
    })

    it('appends streamingMessage to completedMessages when streamingMessage is present', () => {
      const mockHistory = [
        { id: '1', role: 'user', content: 'hello' },
      ] as any[]
      completedMessages.value = mockHistory

      const activeStream = { id: '2', role: 'assistant', content: 'typing...' } as any
      streamingMessage.value = activeStream

      expect(allMessages.value).toHaveLength(2)
      expect(allMessages.value[0]).toEqual(mockHistory[0])
      expect(allMessages.value[1]).toEqual(activeStream)
    })
  })
})
