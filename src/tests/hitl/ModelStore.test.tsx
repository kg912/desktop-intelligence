import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  ModelStoreProvider,
  useModelStore,
  useModelConfig,
  useModelRuntime,
  contextUsageSignal,
  isCompactingSignal,
} from '../../renderer/src/store/ModelStore'

function TestConsumer() {
  const store = useModelStore()
  return (
    <div>
      <span data-testid="model">{store.selectedModel}</span>
      <span data-testid="thinking">{store.thinkingMode}</span>
      <span data-testid="toast">{store.compactToast ? 'has-toast' : 'no-toast'}</span>
      <span data-testid="reloading">{store.isReloading ? 'yes' : 'no'}</span>
      <button onClick={() => store.setSelectedModel('my-model')}>SetModel</button>
      <button onClick={() => store.setThinkingMode('fast')}>SetThinking</button>
      <button onClick={() => store.setContextUsage({ used: 50, total: 100 })}>SetUsage</button>
      <button onClick={() => store.setIsCompacting(true)}>SetCompacting</button>
      <button onClick={() => store.setCompactToast({ tokensBefore: 200, tokensAfter: 100, hasDocuments: true })}>SetToast</button>
      <button onClick={() => store.setIsReloading(true)}>SetReloading</button>
    </div>
  )
}

function ConfigConsumer() {
  const config = useModelConfig()
  return (
    <div>
      <span data-testid="cfg-model">{config.selectedModel}</span>
      <span data-testid="cfg-thinking">{config.thinkingMode}</span>
    </div>
  )
}

function RuntimeConsumer() {
  const runtime = useModelRuntime()
  return (
    <div>
      <span data-testid="rt-toast">{runtime.compactToast ? 'yes' : 'no'}</span>
      <span data-testid="rt-reloading">{runtime.isReloading ? 'yes' : 'no'}</span>
    </div>
  )
}

describe('ModelStore', () => {
  it('throws an error if useModelStore is rendered outside ModelStoreProvider', () => {
    const origError = console.error
    console.error = vi.fn()
    expect(() => render(<TestConsumer />)).toThrow(
      'useModelStore must be used within <ModelStoreProvider>'
    )
    console.error = origError
  })

  it('throws an error if useModelConfig is rendered outside ModelStoreProvider', () => {
    const origError = console.error
    console.error = vi.fn()
    expect(() => render(<ConfigConsumer />)).toThrow(
      'useModelConfig must be used within <ModelStoreProvider>'
    )
    console.error = origError
  })

  it('throws an error if useModelRuntime is rendered outside ModelStoreProvider', () => {
    const origError = console.error
    console.error = vi.fn()
    expect(() => render(<RuntimeConsumer />)).toThrow(
      'useModelRuntime must be used within <ModelStoreProvider>'
    )
    console.error = origError
  })

  it('supplements default values and handles setters correctly', () => {
    render(
      <ModelStoreProvider>
        <TestConsumer />
      </ModelStoreProvider>
    )

    // Verify default values
    expect(screen.getByTestId('model').textContent).toBe('')
    expect(screen.getByTestId('thinking').textContent).toBe('thinking')
    expect(screen.getByTestId('toast').textContent).toBe('no-toast')
    expect(screen.getByTestId('reloading').textContent).toBe('no')

    // Click to change model
    fireEvent.click(screen.getByText('SetModel'))
    expect(screen.getByTestId('model').textContent).toBe('my-model')

    // Click to change thinking mode
    fireEvent.click(screen.getByText('SetThinking'))
    expect(screen.getByTestId('thinking').textContent).toBe('fast')

    // Click to set context usage signal
    fireEvent.click(screen.getByText('SetUsage'))
    expect(contextUsageSignal.value).toEqual({ used: 50, total: 100 })

    // Click to set compacting signal
    fireEvent.click(screen.getByText('SetCompacting'))
    expect(isCompactingSignal.value).toBe(true)

    // Click to set compact toast
    fireEvent.click(screen.getByText('SetToast'))
    expect(screen.getByTestId('toast').textContent).toBe('has-toast')

    // Click to set reloading
    fireEvent.click(screen.getByText('SetReloading'))
    expect(screen.getByTestId('reloading').textContent).toBe('yes')
  })

  it('granular config and runtime hooks read partial contexts correctly', () => {
    render(
      <ModelStoreProvider>
        <ConfigConsumer />
        <RuntimeConsumer />
      </ModelStoreProvider>
    )

    expect(screen.getByTestId('cfg-model').textContent).toBe('')
    expect(screen.getByTestId('cfg-thinking').textContent).toBe('thinking')
    expect(screen.getByTestId('rt-toast').textContent).toBe('no')
    expect(screen.getByTestId('rt-reloading').textContent).toBe('no')
  })
})
