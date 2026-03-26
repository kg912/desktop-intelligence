/**
 * FileProcessorService — Main process
 *
 * Converts raw files into ProcessedAttachment objects the LLM can use.
 *  - Images    → base64 data URL (guarded to ≤ 5 MB)
 *  - PDFs/Text → text extraction, then RAG ingest (AWAITED — not fire-and-forget)
 *
 * CRITICAL (Phase 10 fix):
 *   The RAG ingest MUST complete before processFile returns.  The IPC caller
 *   (handleSend in Layout) immediately fires chat:send after processFile resolves.
 *   If ingest is fire-and-forget, the embedding pipeline takes ~1 s to initialise
 *   and chunks are not in SQLite yet when retrieveContext runs — the LLM receives
 *   zero context even though the PDF was successfully parsed.
 *
 *   Timing measured:  @xenova/transformers pipeline() cold-start ≈ 1 056 ms
 *                     embed() warm                               ≈     4 ms/chunk
 *
 * Anti-regression notes (Phase 8):
 *   • payload.chatId is now forwarded to ingestDocument so each ingested document
 *     is tagged with its owning chat session.  The field is optional — callers that
 *     do not supply it continue to work; those documents are stored with chat_id = NULL
 *     and will not appear in any per-chat RAG retrieval (correct isolation behaviour).
 *   • No changes to the image path or the ProcessedAttachment return shape.
 */

import { readFileSync } from 'fs'
import { extname }      from 'path'
import type { AttachmentFilePayload, ProcessedAttachment } from '../../shared/types'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024  // 5 MB

// ── Public API ────────────────────────────────────────────────────
export async function processFile(
  payload: AttachmentFilePayload
): Promise<ProcessedAttachment> {
  const { filePath, fileName, mimeType, size } = payload

  // ── IPC transfer validation ───────────────────────────────────
  // In Electron, DOM File objects cannot be sent over IPC directly — they
  // arrive as empty objects.  The renderer must extract file.path (Electron
  // injects this on all File objects) and send the string.  If filePath is
  // empty here it means the renderer sent a raw File object or file.path was
  // not set — fail loudly rather than silently reading an empty buffer.
  console.log(`[FileProcessor] 📁 Received: filePath="${filePath}" fileName="${fileName}" mimeType="${mimeType}" size=${size} chatId=${payload.chatId ?? 'null'}`)
  if (!filePath) {
    throw new Error(
      `[FileProcessor] FATAL: filePath is empty for "${fileName}". ` +
      `Electron's File.path was not injected — the renderer may be sending a raw File object over IPC.`
    )
  }

  // ── Image ────────────────────────────────────────────────────
  if (mimeType.startsWith('image/')) {
    if (size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image "${fileName}" is ${(size / 1_048_576).toFixed(1)} MB — exceeds the 5 MB limit.`
      )
    }

    const buffer  = readFileSync(filePath)
    const base64  = buffer.toString('base64')
    const dataUrl = `data:${mimeType};base64,${base64}`

    return {
      id:      `${Date.now()}-${Math.random()}`,
      name:    fileName,
      kind:    'image',
      dataUrl,
      inject:  null,
    }
  }

  // ── Document ─────────────────────────────────────────────────
  let rawText: string

  if (extname(fileName).toLowerCase() === '.pdf') {
    // pdf-parse v2 exports a class-based API: new PDFParse({ data }) → getText()
    const { PDFParse } = await import('pdf-parse')
    const buffer  = readFileSync(filePath)
    console.log(`[FileProcessor] 📦 PDF buffer read: ${buffer.byteLength} bytes`)
    if (buffer.byteLength === 0) {
      throw new Error(`[FileProcessor] FATAL: Buffer is empty for "${fileName}". The file at "${filePath}" could not be read.`)
    }
    const parser  = new PDFParse({ data: buffer })
    const result  = await parser.getText()
    rawText = result.text
    console.log(`📄 PDF-PARSE EXTRACTED CHARACTERS: ${rawText?.length ?? 0}`)
    if (!rawText || rawText.trim().length === 0) {
      console.warn(`[FileProcessor] ⚠️  pdf-parse returned empty text for "${fileName}". The PDF may be image-based (scanned) with no embedded text layer.`)
    }
  } else {
    rawText = readFileSync(filePath, 'utf-8')
    console.log(`📄 TEXT FILE READ CHARACTERS: ${rawText?.length ?? 0}`)
  }

  // ── RAG ingest — AWAITED (not fire-and-forget) ───────────────
  // We must await the full chunk→embed→store pipeline before returning.
  // The IPC caller fires chat:send immediately after this resolves, and
  // retrieveContext must find completed rows in SQLite to return context.
  //
  // UX note: the renderer shows the assistant "thinking" bubble as soon as
  // sendChatMessage is called, which happens AFTER this await returns.
  // The user sees the thinking indicator start the moment ingest completes —
  // this is the correct signal that "your file has been processed".
  const ingestStart = Date.now()
  try {
    const { ingestDocument } = await import('./RAGService')
    await ingestDocument(fileName, rawText, payload.chatId)
    console.log(`[FileProcessor] ✅ Ingest complete in ${Date.now() - ingestStart} ms`)
  } catch (err) {
    // Log and continue — the message can still be sent without RAG context
    console.error(`[FileProcessor] ❌ Ingest FAILED after ${Date.now() - ingestStart} ms:`, err)
  }

  // Inject the raw text directly into the system prompt so the model can
  // read the file without depending on RAG retrieval timing or chatId
  // propagation.  The first 12 000 chars cover most lecture notes / papers;
  // additional content is always available via the RAG retrieval path.
  const MAX_INJECT_CHARS = 12_000
  const injectContent = rawText && rawText.trim().length > 0
    ? `[Document: ${fileName}]\n${rawText.slice(0, MAX_INJECT_CHARS)}${rawText.length > MAX_INJECT_CHARS ? '\n…' : ''}`
    : null

  console.log(`[FileProcessor] 📤 inject chars=${injectContent?.length ?? 0} for "${fileName}"`)

  return {
    id:      `${Date.now()}-${Math.random()}`,
    name:    fileName,
    kind:    'document',
    dataUrl: null,
    inject:  injectContent,
  }
}
