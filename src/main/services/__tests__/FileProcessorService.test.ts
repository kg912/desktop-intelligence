/**
 * FileProcessorService unit tests
 *
 * The single most important regression to prevent: the `inject` field on the
 * returned ProcessedAttachment must contain the actual extracted document text,
 * NOT the old placeholder string "stored in the vector database" that caused
 * the model to hallucinate document content for months.
 *
 * Tests also verify:
 *   • filePath validation (throws loudly on empty string)
 *   • inject is truncated to 12 000 chars for large documents
 *   • inject is null (not a placeholder string) when text cannot be extracted
 *   • Images return a base64 dataUrl and null inject
 *   • ingestDocument is called with the correct chatId
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mutable state shared between mock factories and individual tests ──────────
// Using module-level let so individual tests can override per-case.

let mockPdfText  = 'default mock pdf extracted text'
let mockFileData = Buffer.from('mock file bytes')

// ── Module mocks (hoisted by vitest before any imports) ───────────────────────

// pdf-parse v2: named export PDFParse (must be a class — used with `new`)
vi.mock('pdf-parse', () => ({
  PDFParse: class MockPDFParse {
    constructor(_opts: unknown) {}
    async getText() { return { text: mockPdfText } }
  },
}))

// fs — only readFileSync is used by FileProcessorService
vi.mock('fs', () => ({
  readFileSync: vi.fn((_path: string, encoding?: string) => {
    if (encoding === 'utf-8' || encoding === 'utf8') {
      return mockPdfText // plain-text files
    }
    return mockFileData  // binary (PDF / image)
  }),
}))

// RAGService — ingestDocument must not touch a real DB in these tests
const mockIngestDocument = vi.fn().mockResolvedValue(undefined)
vi.mock('../RAGService', () => ({ ingestDocument: mockIngestDocument }))

// electron — not imported by FileProcessorService directly, but guard
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }))

// path module is real — no mock needed
import { processFile } from '../FileProcessorService'

// ── Helpers ───────────────────────────────────────────────────────────────────

const docPayload = (overrides: Partial<Parameters<typeof processFile>[0]> = {}) => ({
  filePath: '/home/user/lecture.pdf',
  fileName: 'lecture.pdf',
  mimeType: 'application/pdf',
  size:     1024,
  chatId:   'chat-test',
  ...overrides,
})

const imgPayload = (overrides: Partial<Parameters<typeof processFile>[0]> = {}) => ({
  filePath: '/home/user/photo.jpg',
  fileName: 'photo.jpg',
  mimeType: 'image/jpeg',
  size:     512,
  ...overrides,
})

// ── Suite: filePath validation ────────────────────────────────────────────────

describe('filePath validation', () => {
  it('throws with a FATAL message when filePath is an empty string', async () => {
    await expect(
      processFile(docPayload({ filePath: '' }))
    ).rejects.toThrow(/FATAL/)
  })

  it('error message includes the file name for easy debugging', async () => {
    await expect(
      processFile(docPayload({ filePath: '', fileName: 'missing.pdf' }))
    ).rejects.toThrow(/missing\.pdf/)
  })
})

// ── Suite: PDF document inject field ─────────────────────────────────────────

describe('PDF inject field', () => {
  beforeEach(() => {
    mockPdfText = 'This is a university homework assignment about Bayes classifiers.'
    mockIngestDocument.mockClear()
  })

  it('returns kind="document" for PDF files', async () => {
    const result = await processFile(docPayload())
    expect(result.kind).toBe('document')
  })

  it('inject contains the actual extracted PDF text', async () => {
    const result = await processFile(docPayload())
    expect(result.inject).toContain('This is a university homework assignment about Bayes classifiers.')
  })

  it('inject starts with the [Document: filename] header', async () => {
    const result = await processFile(docPayload({ fileName: 'sheet.pdf' }))
    expect(result.inject).toMatch(/^\[Document: sheet\.pdf\]/)
  })

  it('inject does NOT contain the old "vector database" placeholder text', async () => {
    const result = await processFile(docPayload())
    expect(result.inject).not.toContain('vector database')
    expect(result.inject).not.toContain('stored in')
    expect(result.inject).not.toContain('has been parsed')
  })

  it('inject does NOT say "it has been stored" or similar passive phrasing', async () => {
    const result = await processFile(docPayload())
    // The old broken inject was: "[System: The user has attached a document named X.
    // It has been parsed and stored in the vector database.]"
    expect(result.inject).not.toMatch(/\[System:/i)
    expect(result.inject).not.toMatch(/has been parsed/i)
  })

  it('dataUrl is null for documents', async () => {
    const result = await processFile(docPayload())
    expect(result.dataUrl).toBeNull()
  })

  it('truncates inject to ≤12 000 chars for a very large document', async () => {
    mockPdfText = 'A'.repeat(20_000)
    const result = await processFile(docPayload())
    // 12 000 content chars + header overhead — allow small margin
    expect(result.inject!.length).toBeLessThanOrEqual(12_200)
  })

  it('appends "…" when the content is truncated', async () => {
    mockPdfText = 'B'.repeat(20_000)
    const result = await processFile(docPayload())
    expect(result.inject).toContain('…')
  })

  it('inject is null (not a placeholder string) when the PDF has no extractable text', async () => {
    mockPdfText = ''   // image-based / scanned PDF
    const result = await processFile(docPayload())
    expect(result.inject).toBeNull()
  })

  it('inject is null for whitespace-only extracted text', async () => {
    mockPdfText = '   \n\t\n   '
    const result = await processFile(docPayload())
    expect(result.inject).toBeNull()
  })
})

// ── Suite: plain-text files ───────────────────────────────────────────────────

describe('plain-text file inject field', () => {
  beforeEach(() => {
    mockPdfText = 'def hello():\n    print("hello world")'
    mockIngestDocument.mockClear()
  })

  it('injects plain-text content for .py files', async () => {
    const result = await processFile(docPayload({
      filePath: '/home/user/script.py',
      fileName: 'script.py',
      mimeType: 'text/plain',
    }))
    expect(result.inject).toContain('def hello()')
    expect(result.inject).toContain('[Document: script.py]')
  })
})

// ── Suite: RAG ingest is called ───────────────────────────────────────────────

describe('ingestDocument integration', () => {
  beforeEach(() => {
    mockPdfText = 'some extractable text'
    mockIngestDocument.mockClear()
  })

  it('calls ingestDocument after PDF extraction', async () => {
    await processFile(docPayload({ chatId: 'chat-xyz' }))
    expect(mockIngestDocument).toHaveBeenCalledOnce()
  })

  it('passes the extracted text to ingestDocument', async () => {
    await processFile(docPayload())
    const [, text] = mockIngestDocument.mock.calls[0]
    expect(text).toBe('some extractable text')
  })

  it('passes the correct chatId to ingestDocument', async () => {
    await processFile(docPayload({ chatId: 'chat-abc' }))
    const [, , chatId] = mockIngestDocument.mock.calls[0]
    expect(chatId).toBe('chat-abc')
  })

  it('still returns a result even when ingestDocument throws', async () => {
    mockIngestDocument.mockRejectedValueOnce(new Error('DB unavailable'))
    // processFile catches ingest errors and continues
    const result = await processFile(docPayload())
    expect(result.kind).toBe('document')
  })
})

// ── Suite: image files ────────────────────────────────────────────────────────

describe('image files', () => {
  it('returns kind="image" for image MIME types', async () => {
    const result = await processFile(imgPayload())
    expect(result.kind).toBe('image')
  })

  it('returns a base64 data URL for images', async () => {
    const result = await processFile(imgPayload())
    expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('inject is null for images — no text context to inject', async () => {
    const result = await processFile(imgPayload())
    expect(result.inject).toBeNull()
  })

  it('throws for images exceeding 5 MB', async () => {
    await expect(
      processFile(imgPayload({ size: 6 * 1024 * 1024 }))
    ).rejects.toThrow(/5 MB/)
  })
})
