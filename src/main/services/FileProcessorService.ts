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
import crypto           from 'crypto'
import type { AttachmentFilePayload, ProcessedAttachment } from '../../shared/types'

/**
 * Sanitizes untrusted document text before RAG ingest and prompt injection.
 * Strips common prompt-injection patterns that could cause the LLM to follow
 * instructions embedded in user-supplied files (PDFs, text files).
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

  // Sanitize before ingest — prevents prompt injection via uploaded documents
  const sanitizedText = sanitizeDocumentText(rawText)
  if (sanitizedText !== rawText) {
    console.warn(`[FileProcessor] ⚠️  Prompt injection patterns removed from "${fileName}"`)
  }

  // ── v1 RAG ingest — AWAITED (not fire-and-forget) ───────────────
  // v1 path — removed in RAG v2 Phase 2 ─────────────────────────────────────
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
    await ingestDocument(fileName, sanitizedText, payload.chatId)
    console.log(`[FileProcessor] ✅ v1 Ingest complete in ${Date.now() - ingestStart} ms`)
  } catch (err) {
    // Log and continue — the message can still be sent without RAG context
    console.error(`[FileProcessor] ❌ v1 Ingest FAILED after ${Date.now() - ingestStart} ms:`, err)
  }

  // ── v2 RAG ingest — STRICTLY ADDITIVE dual-write (Phase 1) ──────────────
  // v2 path — wires into the new rag/ pipeline alongside the v1 path above.
  // Wrapped entirely in try/catch so any failure leaves v1 serving as before.
  // v2 path — removed in RAG v2 Phase 2 (once v2 retrieval is live and gated) ─
  try {
    // Resolve configured context window for inline/indexed routing (D6).
    let contextWindow = 32768  // conservative fallback
    let usedFallback  = false
    try {
      const { readSettings } = await import('./SettingsStore')
      const settings = readSettings()
      if (typeof settings.contextLength === 'number' && settings.contextLength > 0) {
        contextWindow = settings.contextLength
      } else {
        usedFallback = true
      }
    } catch {
      usedFallback = true
    }
    if (usedFallback) {
      console.log('[FileProcessor] [v2] context window not resolvable from SettingsStore — using 32768')
    }

    const INLINE_BUDGET = Math.floor(0.5 * contextWindow)

    const { countTokens }  = await import('./tokenUtils')
    const { getDB }        = await import('./DatabaseService')
    const { ingest: v2ingest } = await import('./rag/RagIngestionService')

    const tokenCount  = countTokens(sanitizedText)
    const contentHash = crypto.createHash('sha256').update(sanitizedText, 'utf8').digest('hex')
    const v2DocId     = crypto.randomUUID()
    const db          = getDB()
    const v2Mode      = tokenCount <= INLINE_BUDGET ? 'inline' : 'indexed'

    // Insert v2 documents row
    db.prepare(
      `INSERT INTO documents (id, name, path, ts, chat_id, content_hash, token_count, mode)
       VALUES (?, ?, '', ?, ?, ?, ?, ?)`
    ).run(v2DocId, fileName, Date.now(), payload.chatId ?? null, contentHash, tokenCount, v2Mode)

    if (v2Mode === 'inline') {
      db.prepare('INSERT INTO doc_inline_text (doc_id, text) VALUES (?, ?)').run(v2DocId, sanitizedText)
      console.log(
        `[FileProcessor] [v2] mode=inline tokenCount=${tokenCount} ` +
        `INLINE_BUDGET=${INLINE_BUDGET} doc="${fileName}"`
      )
    } else {
      console.log(
        `[FileProcessor] [v2] mode=indexed tokenCount=${tokenCount} ` +
        `INLINE_BUDGET=${INLINE_BUDGET} doc="${fileName}"`
      )
      const result = await v2ingest({
        docId:   v2DocId,
        chatId:  payload.chatId,
        fileName,
        text:    sanitizedText,
      })
      console.log(
        `[FileProcessor] [v2] ingest result: status=${result.status} ` +
        `chunks=${result.chunkCount} vectors=${result.vectorCount}`
      )
    }
  } catch (v2Err) {
    // Non-fatal: v1 path is still active and serving context
    console.warn('[FileProcessor] [v2] Ingest path failed (non-fatal, v1 still active):', v2Err)
  }

  // ── Inject (v1 rule — unchanged) ────────────────────────────────────────
  // Inject the raw text directly into the system prompt so the model can
  // read the file without depending on RAG retrieval timing or chatId
  // propagation.  The first 12 000 chars cover most lecture notes / papers;
  // additional content is always available via the RAG retrieval path.
  const MAX_INJECT_CHARS = 12_000
  const injectContent = sanitizedText && sanitizedText.trim().length > 0
    ? `[Document: ${fileName}]\n${sanitizedText.slice(0, MAX_INJECT_CHARS)}${sanitizedText.length > MAX_INJECT_CHARS ? '\n…' : ''}`
    : null

  console.log(`[FileProcessor] 📤 inject chars=${injectContent?.length ?? 0} for "${fileName}"`)
  console.log(`[FileProcessor] 📋 INJECT CONTENT PREVIEW (first 500 chars): ${injectContent?.slice(0, 500).replace(/\n/g, '↵') ?? 'NULL'}`)

  return {
    id:      `${Date.now()}-${Math.random()}`,
    name:    fileName,
    kind:    'document',
    dataUrl: null,
    inject:  injectContent,
  }
}
