/**
 * Vitest setup file — runs before every test file in the node project.
 *
 * Purpose: inject compile-time constants that are normally provided by
 * Rollup/Vite `define` during the production build.
 *
 * In vitest 4 with `test.projects` inline configs, the WorkspaceVitestPlugin
 * strips user-supplied `define` keys from the vite config before the project's
 * vite server resolves (so the string-replacement transform never fires).
 * The constants are stored in `config.defines` for runtime injection, but ESM
 * bare-identifier access (`const x = __DEV_MODE__`) in strict-mode modules can
 * still throw ReferenceError before the runtime global is consulted.
 *
 * Running this as a `setupFiles` entry guarantees the global is set in the
 * worker context before any test module's static imports are resolved.
 */
;(globalThis as Record<string, unknown>).__DEV_MODE__ = false
