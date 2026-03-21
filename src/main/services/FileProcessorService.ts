/**
 * FileProcessorService — Main process
 *
 * Converts raw files into ProcessedAttachment objects the LLM can use.
 *  - Images    → base64 data URL (guarded to ≤ 5 MB)
 *  - PDFs/Text → text extraction, then Phase 5 RAG ingest (async, fire-and-forget)
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

  // Phase 5 RAG: chunk + embed + store asynchronously.
  // Fire-and-forget — the user gets the confirmation UI immediately
  // and the vector store is ready for the next query.
  // Phase 8: chatId is passed through so each document is tagged to its chat session,
  // preventing cross-chat context bleed during retrieval.
  import('./RAGService')
    .then(({ ingestDocument }) => ingestDocument(fileName, rawText, payload.chatId))
    .catch((err) => console.error('[RAG] ingest failed:', err))

  return {
    id:      `${Date.now()}-${Math.random()}`,
    name:    fileName,
    kind:    'document',
    dataUrl: null,
    inject:  `[System: The user has attached a document named ${fileName}. It has been parsed and stored in the vector database.]`,
  }
}
