import { describe, it, expect } from 'vitest'

describe('tokenUtils — fallback mode', () => {
  it('countTokens: uses BPE character-ratio fallback when tiktoken require fails', async () => {
    const tiktokenPath = require.resolve('tiktoken')
    require.cache[tiktokenPath] = {
      id: tiktokenPath,
      filename: tiktokenPath,
      loaded: true,
      exports: {
        get_encoding: () => {
          throw new Error('Mock tiktoken get_encoding failure')
        }
      }
    } as any

    const { countTokens } = await import('../tokenUtils')
    const text = 'Hello world, this is Antigravity' // 32 characters
    const count = countTokens(text)
    expect(count).toBe(Math.ceil(text.length / 3.6))

    // Cleanup to prevent leaking into other tests
    delete require.cache[tiktokenPath]
  })
})
