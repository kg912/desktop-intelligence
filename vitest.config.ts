import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  // Inject compile-time constants that Rollup define would normally provide.
  // Without this, test files that import main-process modules using __DEV_MODE__
  // throw ReferenceError because Vitest doesn't run the Rollup define pass.
  define: {
    __DEV_MODE__: 'false',
  },
  test: {
    environment: 'node',
    include: [
      'src/main/**/__tests__/**/*.test.ts',
      // Renderer pure-function utilities (no React/DOM dependencies)
      'src/renderer/src/lib/__tests__/**/*.test.ts',
    ],
    globals: true,
    // Each test file gets its own isolated module registry — critical because
    // RAGService tests inject a fake DB singleton via vi.mock, and that must
    // not leak into FileProcessorService tests that also import DatabaseService.
    isolate: true,
    // Show each test name so failures are immediately traceable.
    reporter: 'verbose',
  },
  resolve: {
    alias: {
      '@main':   resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
})
