// Round 5 §6: a collapsed, finished ThinkingAccordion must not read scroll geometry on mount (forced layout on every
// virtualized row mount); opening it or streaming must still update the scroll shadows as before.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ThinkingAccordion } from '../../renderer/src/components/chat/MessageBubble'

let scrollH: ReturnType<typeof vi.spyOn>
let clientH: ReturnType<typeof vi.spyOn>
let roHeight = 0

beforeEach(() => {
  roHeight = 0
  // jsdom has no ResizeObserver; report the content's height like the browser would on observe.
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      const target = { getBoundingClientRect: () => ({ height: roHeight }) } as unknown as Element
      queueMicrotask(() => this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver))
      void el
    }
    disconnect() {}
  })
  scrollH = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(400)
  clientH = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(330)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const flush = () => act(async () => { await Promise.resolve() })

describe('ThinkingAccordion — scroll shadows', () => {
  it('collapsed and not streaming: mounting reads neither scrollHeight nor clientHeight', async () => {
    render(<ThinkingAccordion content="thought" isStreaming={false} />)
    await flush()
    expect(scrollH).not.toHaveBeenCalled()
    expect(clientH).not.toHaveBeenCalled()
  })

  it('opening it updates the shadows: scrollable content at the top shows only the bottom shadow', async () => {
    roHeight = 400
    const { container } = render(<ThinkingAccordion content="thought" isStreaming={false} />)
    await flush()
    fireEvent.click(screen.getByRole('button'))
    await flush()
    expect(clientH).toHaveBeenCalled()
    const shadows = [...container.querySelectorAll<HTMLElement>('.pointer-events-none')]
    expect(shadows).toHaveLength(2)
    expect(shadows[0].style.opacity).toBe('0') // top
    expect(shadows[1].style.opacity).toBe('1') // bottom
  })

  it('streaming starting updates the shadows', async () => {
    const { rerender } = render(<ThinkingAccordion content="a" isStreaming={false} />)
    await flush()
    expect(clientH).not.toHaveBeenCalled()
    rerender(<ThinkingAccordion content="ab" isStreaming />)
    await flush()
    expect(clientH).toHaveBeenCalled()
  })
})
