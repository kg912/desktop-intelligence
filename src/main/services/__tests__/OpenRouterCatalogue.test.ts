import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clearOpenRouterCatalogueCache, getOpenRouterCatalogue, parseCatalogue } from '../OpenRouterCatalogue'

const raw = {
  data: [
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', context_length: 131072, supported_parameters: ['tools', 'temperature', 'reasoning'], pricing: { prompt: '0.00000013', completion: '0.0000004' } },
    { id: 'x/no-tools', context_length: 8192, supported_parameters: ['temperature'], pricing: { prompt: 'free', completion: '-1' } },
    { name: 'no id' },
  ],
}

describe('OpenRouter catalogue', () => {
  beforeEach(() => clearOpenRouterCatalogueCache())

  it('parses context length, tool and reasoning support and per-token prices; invalid prices become null', () => {
    expect(parseCatalogue(raw)).toEqual([
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', contextLength: 131072, promptPrice: 1.3e-7, completionPrice: 4e-7, supportsTools: true, supportsReasoning: true },
      { id: 'x/no-tools', name: 'x/no-tools', contextLength: 8192, promptPrice: null, completionPrice: null, supportsTools: false, supportsReasoning: false },
    ])
  })

  it('caches per key and surfaces HTTP errors', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 }))
    await getOpenRouterCatalogue('k1', fetchFn as unknown as typeof fetch)
    await getOpenRouterCatalogue('k1', fetchFn as unknown as typeof fetch)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await getOpenRouterCatalogue('k2', fetchFn as unknown as typeof fetch)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const failing = vi.fn(async () => new Response('nope', { status: 401 }))
    await expect(getOpenRouterCatalogue('k3', failing as unknown as typeof fetch)).rejects.toThrow('HTTP 401')
  })
})
