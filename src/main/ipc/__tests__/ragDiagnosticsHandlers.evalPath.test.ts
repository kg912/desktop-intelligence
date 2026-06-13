/**
 * ragDiagnosticsHandlers — resolveEvalFilePath unit tests
 *
 * The helper is a pure function (existsFn injectable) so it can be tested
 * without any file-system or Electron dependency.
 */

import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import { resolveEvalFilePath } from '../ragDiagnosticsHandlers'

vi.mock('electron', () => ({
  app:         { getPath: vi.fn(() => '/tmp'), getVersion: () => '0.0.0' },
  ipcMain:     { handle: vi.fn() },
  dialog:      { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => [{}]) },
}))

// ── Absolute path tests ───────────────────────────────────────────────────────

describe('resolveEvalFilePath — absolute paths', () => {
  it('returns the path as-is when it exists', () => {
    const p = '/Users/karan/evals/my.jsonl'
    const result = resolveEvalFilePath(p, [], () => true)
    expect(result).toEqual({ kind: 'ok', resolved: p })
  })

  it('returns error with the absolute path listed when it does not exist', () => {
    const p = '/Users/karan/evals/missing.jsonl'
    const result = resolveEvalFilePath(p, [], () => false)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.checked).toHaveLength(1)
      expect(result.checked[0]).toBe(p)
    }
  })
})

// ── Relative path tests ───────────────────────────────────────────────────────

describe('resolveEvalFilePath — relative paths', () => {
  it('resolves against the first root that contains the file', () => {
    const root1 = '/root1'
    const root2 = '/root2'
    const rel   = 'evals/eval.jsonl'

    // Only root2 contains the file
    const existsFn = (p: string): boolean => p === path.resolve(root2, rel)

    const result = resolveEvalFilePath(rel, [root1, root2], existsFn)
    expect(result).toEqual({ kind: 'ok', resolved: path.resolve(root2, rel) })
  })

  it('returns error listing ALL checked absolute paths when nothing found', () => {
    const root1 = '/userData'
    const root2 = '/cwd'
    const rel   = 'evals/missing.jsonl'

    const result = resolveEvalFilePath(rel, [root1, root2], () => false)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.checked).toHaveLength(2)
      expect(result.checked[0]).toBe(path.resolve(root1, rel))
      expect(result.checked[1]).toBe(path.resolve(root2, rel))
    }
  })

  it('tries roots in order — first match wins, remaining roots are not tried', () => {
    const root1 = '/userData'
    const root2 = '/cwd'
    const rel   = 'eval.jsonl'

    const visited: string[] = []
    const existsFn = (p: string): boolean => {
      visited.push(p)
      return p === path.resolve(root1, rel)
    }

    const result = resolveEvalFilePath(rel, [root1, root2], existsFn)
    expect(result.kind).toBe('ok')
    // root2 should never have been checked
    expect(visited).not.toContain(path.resolve(root2, rel))
  })

  it('empty candidateRoots → error with empty checked list', () => {
    const result = resolveEvalFilePath('eval.jsonl', [], () => false)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.checked).toHaveLength(0)
    }
  })
})
