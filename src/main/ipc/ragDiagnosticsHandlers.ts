/**
 * RAG v2 diagnostics IPC handlers — Phase 4 + Phase 5.
 *
 * Registered from index.ts via registerRagDiagnosticsHandlers().
 * Exposes:
 *   rag:list-docs         → list indexed docs for a chat with chunk counts
 *   rag:export-chunks(docId) → write markdown dump to Downloads, return path
 *   rag:run-eval({ filePath, chatId }) → run evaluation harness, return EvalReport
 *   rag:list-doc-chats    → list all chats that have ≥1 document row
 *   rag:get-config        → return live retrieval constant values
 *
 * The listDocChatsFromDB and assembleRagConfig helpers are exported for unit testing.
 */

import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC_CHANNELS } from '../../shared/types'
import type Database from 'better-sqlite3'

// ── Exported pure helpers (testable without Electron) ────────────────────────

export type DocChatEntry = {
  chatId:          string
  title:           string
  docCount:        number
  indexedDocCount: number
  totalChunks:     number
}

/**
 * Queries all chats that have ≥1 document row and returns summary info.
 * Title falls back to the first user message when the chat still has the
 * default "New Chat" placeholder, then to the bare chatId.
 */
export function listDocChatsFromDB(db: Database.Database): DocChatEntry[] {
  const rows = db.prepare(`
    SELECT
      c.id                                                    AS chatId,
      c.title                                                 AS title,
      c.updated_at                                            AS updatedAt,
      COUNT(DISTINCT d.id)                                    AS docCount,
      COUNT(DISTINCT CASE WHEN d.mode = 'indexed' THEN d.id END) AS indexedDocCount,
      (SELECT COUNT(*) FROM rag_chunks rc WHERE rc.chat_id = c.id) AS totalChunks
    FROM   documents d
    JOIN   chats c ON c.id = d.chat_id
    WHERE  d.chat_id IS NOT NULL
    GROUP  BY c.id
    ORDER  BY c.updated_at DESC
  `).all() as Array<{
    chatId:          string
    title:           string
    updatedAt:       number
    docCount:        number
    indexedDocCount: number
    totalChunks:     number
  }>

  return rows.map(r => {
    let displayTitle = r.title
    if (!displayTitle || displayTitle === 'New Chat') {
      const firstMsg = db.prepare(
        `SELECT content FROM chat_messages
         WHERE chat_id = ? AND role = 'user'
         ORDER BY created_at ASC LIMIT 1`
      ).get(r.chatId) as { content: string } | undefined
      if (firstMsg?.content) {
        const t = firstMsg.content.trim().replace(/\s+/g, ' ')
        displayTitle = t.length > 60 ? t.slice(0, 60) + '…' : t
      } else {
        displayTitle = r.chatId
      }
    }
    return {
      chatId:          r.chatId,
      title:           displayTitle,
      docCount:        r.docCount,
      indexedDocCount: r.indexedDocCount,
      totalChunks:     r.totalChunks,
    }
  })
}

export type RagConfigValues = {
  CHUNK_TOKENS:         number
  CHUNK_OVERLAP_TOKENS: number
  FINAL_K:              number
  FINAL_K_RERANKED:     number
  K_LEXICAL:            number
  K_VECTOR:             number
  RRF_K:                number
  VEC_DISTANCE_FLOOR:   number
  CONTEXT_TOKEN_BUDGET: number
  EMBEDDING_MODEL_ID:   string
  EMBEDDING_DIM:        number
  RERANKER_MODEL_ID:    string
}

export async function assembleRagConfig(): Promise<RagConfigValues> {
  const { CHUNK_TOKENS, CHUNK_OVERLAP_TOKENS } = await import('../services/rag/RagChunker')
  const {
    FINAL_K, FINAL_K_RERANKED, K_LEXICAL, K_VECTOR,
    RRF_K, VEC_DISTANCE_FLOOR, CONTEXT_TOKEN_BUDGET,
  } = await import('../services/rag/RagRetrievalService')
  const { EMBEDDING_MODEL_ID, EMBEDDING_DIM } = await import('../services/EmbeddingService')
  const { RERANKER_MODEL_ID }                 = await import('../services/rag/RerankerService')

  return {
    CHUNK_TOKENS,
    CHUNK_OVERLAP_TOKENS,
    FINAL_K,
    FINAL_K_RERANKED,
    K_LEXICAL,
    K_VECTOR,
    RRF_K,
    VEC_DISTANCE_FLOOR,
    CONTEXT_TOKEN_BUDGET,
    EMBEDDING_MODEL_ID,
    EMBEDDING_DIM,
    RERANKER_MODEL_ID,
  }
}

/**
 * Resolves a (possibly relative) eval file path to an absolute path.
 *
 * - Absolute paths: used as-is; error if the file does not exist.
 * - Relative paths: tried against each candidateRoot in order; first match wins.
 *
 * Returns { kind:'ok', resolved } or { kind:'error', checked } where checked lists
 * every absolute path that was attempted, so the caller can surface a clear message.
 * existsFn is injectable for unit testing.
 */
export function resolveEvalFilePath(
  filePath: string,
  candidateRoots: string[],
  existsFn: (p: string) => boolean = (p) => fs.existsSync(p),
): { kind: 'ok'; resolved: string } | { kind: 'error'; checked: string[] } {
  if (path.isAbsolute(filePath)) {
    return existsFn(filePath)
      ? { kind: 'ok', resolved: filePath }
      : { kind: 'error', checked: [filePath] }
  }
  const checked: string[] = []
  for (const root of candidateRoots) {
    const candidate = path.resolve(root, filePath)
    checked.push(candidate)
    if (existsFn(candidate)) return { kind: 'ok', resolved: candidate }
  }
  return { kind: 'error', checked }
}

// ── IPC registration ──────────────────────────────────────────────────────────

export function registerRagDiagnosticsHandlers(): void {

  // ── LIST DOCS ────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.RAG_LIST_DOCS, async (_, chatId: string) => {
    const { getDB } = await import('../services/DatabaseService')
    const db = getDB()
    const rows = db.prepare(`
      SELECT d.id, d.name, d.mode, d.token_count,
             COUNT(rc.id) AS chunkCount
      FROM   documents d
      LEFT   JOIN rag_chunks rc ON rc.doc_id = d.id
      WHERE  d.chat_id = ? AND d.mode = 'indexed'
      GROUP  BY d.id
    `).all(chatId) as Array<{
      id: string
      name: string
      mode: string
      token_count: number | null
      chunkCount: number
    }>
    return rows.map(r => ({
      docId:      r.id,
      docName:    r.name,
      mode:       r.mode,
      tokenCount: r.token_count ?? 0,
      chunkCount: r.chunkCount,
    }))
  })

  // ── EXPORT CHUNKS ────────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.RAG_EXPORT_CHUNKS, async (_, docId: string) => {
    const { getDB } = await import('../services/DatabaseService')
    const db = getDB()

    const doc = db.prepare(
      'SELECT name, mode, token_count, source_char_len FROM documents WHERE id = ?'
    ).get(docId) as { name: string; mode: string; token_count: number | null; source_char_len: number | null } | undefined

    if (!doc) throw new Error(`Document not found: ${docId}`)

    const chunks = db.prepare(`
      SELECT chunk_index, section_title, char_start, char_end, content
      FROM   rag_chunks
      WHERE  doc_id = ?
      ORDER  BY chunk_index ASC
    `).all(docId) as Array<{
      chunk_index:   number
      section_title: string | null
      char_start:    number | null
      char_end:      number | null
      content:       string
    }>

    const lastChunk  = chunks[chunks.length - 1]
    const srcLen     = doc.source_char_len
    const coveragePct: number | null = (srcLen != null && srcLen > 0 && lastChunk)
      ? Math.min(Math.round((lastChunk.char_end ?? 0) / srcLen * 100 * 100) / 100, 100)
      : null

    const lines: string[] = []
    lines.push(`# Chunk Export — ${doc.name}`)
    lines.push('')
    lines.push(`| Field | Value |`)
    lines.push(`|---|---|`)
    lines.push(`| doc_id | \`${docId}\` |`)
    lines.push(`| mode | ${doc.mode} |`)
    lines.push(`| token_count | ${doc.token_count ?? 'n/a'} |`)
    lines.push(`| chunk_count | ${chunks.length} |`)
    lines.push(`| coverage_pct | ${coveragePct != null ? coveragePct + '%' : 'n/a (re-ingest to measure)'} |`)
    lines.push('')

    for (const c of chunks) {
      const section = c.section_title ? ` · §${c.section_title}` : ''
      const range   = (c.char_start != null && c.char_end != null)
        ? ` · ${c.char_start}–${c.char_end}`
        : ''
      const approxTok = Math.round(c.content.length / 3.5)
      lines.push(`## [#${c.chunk_index}${section}${range} · ~${approxTok} tokens]`)
      lines.push('')
      lines.push(c.content)
      lines.push('')
    }

    const ts       = new Date().toISOString().replace(/[:.]/g, '-')
    const safeName = doc.name.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 60)
    const outPath  = path.join(app.getPath('downloads'), `rag-chunks-${safeName}-${ts}.md`)
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8')
    console.log(`[RAG] Chunk export written to ${outPath}`)
    return outPath
  })

  // ── RUN EVAL ─────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.RAG_RUN_EVAL,
    async (_, { filePath, chatId }: { filePath: string; chatId: string }) => {
      const candidateRoots = [app.getPath('userData'), process.cwd()]
      const resolution = resolveEvalFilePath(filePath, candidateRoots)
      if (resolution.kind === 'error') {
        const list = resolution.checked.map(p => `  • ${p}`).join('\n')
        throw new Error(`Eval file not found. Checked:\n${list}`)
      }
      const { runEval } = await import('../services/rag/RagEvalService')
      return runEval(resolution.resolved, chatId)
    }
  )

  // ── PICK EVAL FILE ────────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.RAG_PICK_EVAL_FILE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
      title: 'Select Eval File',
      filters: [
        { name: 'JSONL / JSON / Text', extensions: ['jsonl', 'json', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // ── LIST DOC CHATS ────────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.RAG_LIST_DOC_CHATS, async () => {
    const { getDB } = await import('../services/DatabaseService')
    return listDocChatsFromDB(getDB())
  })

  // ── GET CONFIG ────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.RAG_GET_CONFIG, async () => {
    return assembleRagConfig()
  })
}
