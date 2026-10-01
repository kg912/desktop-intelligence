import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ModelStoreProvider } from './store/ModelStore'
import './styles/globals.css'

async function bootstrap(): Promise<void> {
  // In Electron, window.api is injected by the preload script.
  // When running in a plain browser (Vite preview / demo), inject the mock
  // so all Phase 3 features are exercisable without the Electron runtime.
  if (!window.api) {
    const mockModule = await import('./mocks/api.mock')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // The mock covers what the demo exercises; anything newer falls back to a
    // no-op (subscriptions return an unsubscribe) so the preview still renders.
    ;(window as any).api = new Proxy(mockModule.mockApi, {
      get: (target, key) =>
        key in target ? (target as any)[key]
          : typeof key === 'string' && key.startsWith('on') ? () => () => {}
          : async () => undefined,
    })
    // Expose demo trigger — reads live module binding so it works after useChat mounts
    ;(window as any).__desktopIntelligenceDemo = (text?: string) =>
      mockModule.triggerDemo?.(text ?? 'Explain the math behind transformer self-attention')
    console.info('[DesktopIntelligence] Browser demo mode — call window.__desktopIntelligenceDemo() to start.')
  }

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <ModelStoreProvider>
        <App />
      </ModelStoreProvider>
    </React.StrictMode>
  )
}

bootstrap()
