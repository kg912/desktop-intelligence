import { describe, it, expect } from 'vitest'
import { LruMap } from '../lruMap'

describe('LruMap', () => {
  it('evicts the least recently used entry past the cap', () => {
    const m = new LruMap<string, number>(2)
    m.set('a', 1).set('b', 2)
    expect(m.get('a')).toBe(1) // a is now most recent
    m.set('c', 3)
    expect([...m.keys()]).toEqual(['a', 'c'])
    m.set('a', 4) // overwrite refreshes, does not grow
    expect(m.size).toBe(2)
    expect(m.get('b')).toBeUndefined()
  })
})
