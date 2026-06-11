/**
 * FileProcessorService — Main process
 *
 * Converts raw files into ProcessedAttachment objects the LLM can use.
 *  - Images    → base64 data URL (guarded to ≤ 5 MB)
 *  - PDFs/Text → text extraction → v2 RAG ingest (inline or indexed)
 *
 * Phase 2: v1 ingestDocument path removed. v2 is the primary path.
 * inject is always null for documents — context delivery is handled by
 * RagRetrievalService via the <attached_file_context> envelope in handlers.ts.
 *
 * Ingest failure is non-fatal: processFile logs and returns a zero-inject
 * attachment so the message can still be sent (model acknowledges the file
 * without RAG context for this turn).
 */

import { readFileSync } from 'fs'
import { extname }      from 'path'
import crypto           from 'crypto'
import type { AttachmentFilePayload, ProcessedAttachment } from '../../shared/types'

/**
 * Sanitizes untrusted document text before RAG ingest.
 * Strips common prompt-injection patterns.
 * Best-effort defence layer — not a cryptographic guarantee.
 */
function sanitizeDocumentText(text: string): string {
  return text
    .replace(/ignore\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|context|rules?)/gi, '[CONTENT FILTERED]')
    .replace(/disregard\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|context|rules?)/gi, '[CONTENT FILTERED]')
    .replace(/forget\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|context|rules?)/gi, '[CONTENT FILTERED]')
    .replace(/new\s+(instructions?|directive|system\s+prompt|task|role|persona)/gi, '[CONTENT FILTERED]')
    .replace(/you\s+are\s+now\s+(a\s+)?(different|new|another)/gi, '[CONTENT FILTERED]')
    .replace(/<\/?system>/gi, '[CONTENT FILTERED]')
    .replace(/\[INST\]|\[\/INST\]/gi, '[CONTENT FILTERED]')
    .replace(/<>|<\/SYS>/gi, '[CONTENT FILTERED]')
    .replace(/<\|im_start\|>|<\|im_end\|>/gi, '[CONTENT FILTERED]')
    .replace(/developer\s+mode\s+(enabled|on|active)/gi, '[CONTENT FILTERED]')
    .replace(/jailbreak/gi, '[CONTENT FILTERED]')
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024  // 5 MB

// ── Public API ────────────────────────────────────────────────────
export async function processFile(
  payload: AttachmentFilePayload
): Promise<ProcessedAttachment> {
  const { filePath, fileName, mimeType, size } = payload

  console.log(`[FileProcessor] 📁 Received: filePath="${filePath}" fileName="${fileName}" mimeType="${mimeType}" size=${size} chatId=${payload.chatId ?? 'null'}`)
  if (!filePath) {
    throw new Error(
      `[FileProcessor] FATAL: filePath is empty for "${fileName}". ` +
      `Electron's File.path was not injected — the renderer may be sending a raw File object over IPC.`
    )
  }

  // ── Image ────────────────────────────────────────────────────
  if (mimeType.startsWith('image/')) {
    if (mimeType === 'image/svg+xml' || fileName.toLowerCase().endsWith('.svg')) {
      throw new Error(
        `SVG files cannot be sent to vision models — they require raster images. ` +
        `Please convert "${fileName}" to PNG or JPEG first.`
      )
    }
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
      console.warn(`[FileProcessor] ⚠️  pdf-parse returned empty text for "${fileName}". The PDF may be image-based.`)
    }
  } else {
    rawText = readFileSync(filePath, 'utf-8')
    console.log(`📄 TEXT FILE READ CHARACTERS: ${rawText?.length ?? 0}`)
  }

  const sanitizedText = sanitizeDocumentText(rawText)
  if (sanitizedText !== rawText) {
    console.warn(`[FileProcessor] ⚠️  Prompt injection patterns removed from "${fileName}"`)
  }

  // ── v2 RAG ingest (primary path) ────────────────────────────
  const ingestStart = Date.now()
  try {
    // Resolve context window for inline/indexed routing (D6)
    let contextWindow = 32768
    try {
      const { readSettings } = await import('./SettingsStore')
      const settings = readSettings()
      if (typeof settings.contextLength === 'number' && settings.contextLength > 0) {
        contextWindow = settings.contextLength
      }
    } catch { /* use fallback */ }

    const INLINE_BUDGET = Math.floor(0.5 * contextWindow)

    const { countTokens }       = await import('./tokenUtils')
    const { getDB }             = await import('./DatabaseService')
    const { ingest: v2ingest }  = await import('./rag/RagIngestionService')

    const tokenCount  = countTokens(sanitizedText)
    const contentHash = crypto.createHash('sha256').update(sanitizedText, 'utf8').digest('hex')
    const v2DocId     = crypto.randomUUID()
    const db          = getDB()
    const v2Mode      = tokenCount <= INLINE_BUDGET ? 'inline' : 'indexed'

    db.prepare(
      `INSERT INTO documents (id, name, path, ts, chat_id, content_hash, token_count, mode)
       VALUES (?, ?, '', ?, ?, ?, ?, ?)`
    ).run(v2DocId, fileName, Date.now(), payload.chatId ?? null, contentHash, tokenCount, v2Mode)

    if (v2Mode === 'inline') {
      db.prepare('INSERT INTO doc_inline_text (doc_id, text) VALUES (?, ?)').run(v2DocId, sanitizedText)
      console.log(
        `[FileProcessor] [v2] mode=inline tokenCount=${tokenCount} ` +
        `INLINE_BUDGET=${INLINE_BUDGET} doc="${fileName}" in ${Date.now() - ingestStart}ms`
      )
    } else {
      const result = await v2ingest({
        docId:      v2DocId,
        chatId:     payload.chatId,
        fileName,
        text:       sanitizedText,
        tokenCount,
      })
      console.log(
        `[FileProcessor] [v2] mode=indexed status=${result.status} ` +
        `chunks=${result.chunkCount} vectors=${result.vectorCount} ` +
        `in ${Date.now() - ingestStart}ms`
      )
    }
  } catch (ingestErr) {
    // Non-fatal: the message can still be sent; the model will note it cannot
    // see the file content this turn and the user can re-upload.
    console.error(`[FileProcessor] ❌ v2 Ingest FAILED after ${Date.now() - ingestStart} ms:`, ingestErr)
  }

  // inject is always null — context is delivered via RagRetrievalService
  // on every turn through the handlers.ts <attached_file_context> envelope.
  return {
    id:      `${Date.now()}-${Math.random()}`,
    name:    fileName,
    kind:    'document',
    dataUrl: null,
    inject:  null,
  }
}
