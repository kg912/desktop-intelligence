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
    ;(window as any).api = mockModule.mockApi
    // Expose demo trigger — reads live module binding so it works after useChat mounts
    ;(window as any).__qwenDemo = (text?: string) =>
      mockModule.triggerDemo?.(text ?? 'Explain the math behind transformer self-attention')
    console.info('[QwenStudio] Browser demo mode — call window.__qwenDemo() to start.')
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
