/**
 * ragDiagnosticsHandlers — buildChunkExportMarkdown unit tests
 *
 * Tests for the exported pure helper that generates the markdown dump.
 * No Electron, no file-system — pure input/output.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildChunkExportMarkdown } from '../ragDiagnosticsHandlers'
import type { ChunkExportDocInfo, ChunkExportRow } from '../ragDiagnosticsHandlers'

vi.mock('electron', () => ({
  app:          { getPath: vi.fn(() => '/tmp'), getVersion: () => '0.0.0' },
  ipcMain:      { handle: vi.fn() },
  dialog:       { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => [{}]) },
}))

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDoc(overrides: Partial<ChunkExportDocInfo> = {}): ChunkExportDocInfo {
  return {
    name:            'test.pdf',
    mode:            'indexed',
    token_count:     120,
    source_char_len: 1000,
    ...overrides,
  }
}

function makeChunk(overrides: Partial<ChunkExportRow> = {}): ChunkExportRow {
  return {
    chunk_index:   0,
    section_title: null,
    char_start:    0,
    char_end:      800,
    content:       'This is chunk content.',
    ...overrides,
  }
}

// ── happy path — char offsets present ────────────────────────────────────────

describe('buildChunkExportMarkdown — char offsets present', () => {
  it('includes char range in chunk header', () => {
    const doc    = makeDoc()
    const chunks = [makeChunk({ char_start: 0, char_end: 800 })]
    const md     = buildChunkExportMarkdown(doc, 'doc-1', chunks)
    expect(md).toContain('0–800')
  })

  it('computes coveragePct correctly (800/1000 = 80.00%)', () => {
    const doc    = makeDoc({ source_char_len: 1000 })
    const chunks = [makeChunk({ char_end: 800 })]
    const md     = buildChunkExportMarkdown(doc, 'doc-1', chunks)
    expect(md).toContain('| coverage_pct | 80%')
  })

  it('clamps coveragePct to 100 when char_end exceeds source_char_len', () => {
    const doc    = makeDoc({ source_char_len: 800 })
    const chunks = [makeChunk({ char_end: 850 })]
    const md     = buildChunkExportMarkdown(doc, 'doc-1', chunks)
    expect(md).toContain('| coverage_pct | 100%')
  })

  it('includes section title in chunk header when present', () => {
    const doc    = makeDoc()
    const chunks = [makeChunk({ section_title: 'Introduction' })]
    const md     = buildChunkExportMarkdown(doc, 'doc-1', chunks)
    expect(md).toContain('§Introduction')
  })

  it('includes correct metadata in the summary table', () => {
    const doc    = makeDoc({ name: 'report.pdf', mode: 'indexed', token_count: 500 })
    const chunks = [makeChunk()]
    const md     = buildChunkExportMarkdown(doc, 'doc-42', chunks)
    expect(md).toContain('`doc-42`')
    expect(md).toContain('| mode | indexed |')
    expect(md).toContain('| token_count | 500 |')
    expect(md).toContain('| chunk_count | 1 |')
  })
})

// ── degrade path — char offsets NULL (old docs) ───────────────────────────────

describe('buildChunkExportMarkdown — char offsets NULL (pre-beta-18 docs)', () => {
  it('omits range from chunk header when char_start/char_end are null', () => {
    const doc    = makeDoc()
    const chunks = [makeChunk({ char_start: null, char_end: null })]
    const md     = buildChunkExportMarkdown(doc, 'doc-old', chunks)
    // Should not contain a numeric range like "0–800"
    expect(md).not.toMatch(/\d+–\d+/)
  })

  it('shows "n/a (re-ingest to measure)" for coverage_pct when char_end is null', () => {
    const doc    = makeDoc({ source_char_len: 1000 })
    const chunks = [makeChunk({ char_start: null, char_end: null })]
    const md     = buildChunkExportMarkdown(doc, 'doc-old', chunks)
    expect(md).toContain('n/a (re-ingest to measure)')
  })

  it('shows "n/a (re-ingest to measure)" when source_char_len is null', () => {
    const doc    = makeDoc({ source_char_len: null })
    const chunks = [makeChunk({ char_start: 0, char_end: 800 })]
    const md     = buildChunkExportMarkdown(doc, 'doc-old', chunks)
    expect(md).toContain('n/a (re-ingest to measure)')
  })

  it('does NOT crash on an empty chunks array', () => {
    const doc = makeDoc()
    expect(() => buildChunkExportMarkdown(doc, 'doc-empty', [])).not.toThrow()
    const md = buildChunkExportMarkdown(doc, 'doc-empty', [])
    expect(md).toContain('| chunk_count | 0 |')
    expect(md).toContain('n/a (re-ingest to measure)')
  })
})
