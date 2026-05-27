import { describe, it, expect } from 'vitest'
import { countTokens, countMessagesTokens } from '../tokenUtils'

describe('tokenUtils — normal mode', () => {
  it('countTokens: works under normal tiktoken encoder', () => {
    const text = 'Hello world, this is Antigravity'
    const count = countTokens(text)
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(text.length)
  })

  it('countMessagesTokens: sums token count and adds per-message overhead', () => {
    const messages = [
      { content: 'Hello' },
      { content: { type: 'text', text: 'Nested content object' } }
    ]

    const count = countMessagesTokens(messages)
    expect(count).toBeGreaterThan(0)
  })
})
