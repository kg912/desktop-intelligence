import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// NOTE: @vitejs/plugin-react (Babel) is intentionally NOT used here.
// Vitest 4 bundles vite 8 internally (which uses oxc for transforms).
// When vite 8 detects rolldownVersion, it inserts oxc: { target: "node18" }
// into its internal config. If the Babel plugin also sets esbuild.jsx at that
// point, vite 8 warns "Both esbuild and oxc options were set" and silently
// ignores the esbuild settings — leaving JSX syntax untransformed.
//
// Environment separation:
//   • vitest 4 removed environmentMatchGlobs.
//   • We use test.projects to route .ts tests to node and .tsx to jsdom.
//   • WorkspaceVitestPlugin strips user `define` keys from the inline project's
//     viteConfig, so __DEV_MODE__ is never compile-time replaced in inline
//     projects. We work around this with a setupFiles entry (see
//     src/tests/vitest-setup.ts) that sets globalThis.__DEV_MODE__ before any
//     test module is imported.

export default defineConfig({
  // Top-level define (used by the root vite server during non-project runs
  // and as a fallback in some vitest code paths).
  define: {
    __DEV_MODE__: 'false',
  },
  resolve: {
    alias: {
      '@main':   resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    globals: true,
    // Each test file gets its own isolated module registry — critical because
    // RAGService tests inject a fake DB singleton via vi.mock, and that must
    // not leak into FileProcessorService tests that also import DatabaseService.
    isolate: true,
    // Show each test name so failures are immediately traceable.
    reporter: 'verbose',
    projects: [
      {
        // ── Node environment — main-process and pure-TS tests ──────────
        define: { __DEV_MODE__: 'false' },
        resolve: {
          alias: {
            '@main':   resolve(__dirname, 'src/main'),
            '@shared': resolve(__dirname, 'src/shared'),
          },
        },
        test: {
          include: [
            'src/main/**/__tests__/**/*.test.ts',
            // Renderer pure-function utilities (no React/DOM dependencies)
            'src/renderer/src/lib/__tests__/**/*.test.ts',
            // HITL feature tests that exercise pure Node.js logic
            'src/tests/hitl/**/*.test.ts',
          ],
          environment: 'node',
          globals: true,
          // vitest 4's WorkspaceVitestPlugin strips custom `define` keys from
          // the inline project's vite config, so the compile-time replacement
          // for __DEV_MODE__ never fires. This setup file sets the global on
          // globalThis before any test module is imported, mimicking what the
          // compile-time replacement would have done.
          setupFiles: ['src/tests/vitest-setup.ts'],
        },
      },
      {
        // ── jsdom environment — React component tests (.tsx) ───────────
        // Configure vite 8's oxc transform to handle React JSX automatically.
        ...({ oxc: { jsx: { runtime: 'automatic' } } } as Record<string, unknown>),
        define: { __DEV_MODE__: 'false' },
        resolve: {
          alias: {
            '@main':   resolve(__dirname, 'src/main'),
            '@shared': resolve(__dirname, 'src/shared'),
          },
        },
        test: {
          include: [
            'src/tests/hitl/**/*.test.tsx',
          ],
          environment: 'jsdom',
          globals: true,
        },
      },
    ],
  },
})
