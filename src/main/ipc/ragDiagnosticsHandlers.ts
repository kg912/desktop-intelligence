/**
 * RAG v2 diagnostics IPC handlers — Phase 4.
 *
 * Registered from index.ts via registerRagDiagnosticsHandlers().
 * Exposes:
 *   rag:list-docs    → list indexed docs for a chat with chunk counts
 *   rag:export-chunks(docId) → write markdown dump to Downloads, return path
 *   rag:run-eval({ filePath, chatId }) → run evaluation harness, return EvalReport
 */

import { ipcMain, app } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC_CHANNELS } from '../../shared/types'

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

    // Document metadata
    const doc = db.prepare(
      'SELECT name, mode, token_count FROM documents WHERE id = ?'
    ).get(docId) as { name: string; mode: string; token_count: number | null } | undefined

    if (!doc) throw new Error(`Document not found: ${docId}`)

    // Chunk rows
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

    // coveragePct from last chunk
    const lastChunk = chunks[chunks.length - 1]
    const rawText   = db.prepare(
      'SELECT text FROM doc_inline_text WHERE doc_id = ?'
    ).get(docId) as { text: string } | undefined
    // rag_chunks don't store the raw text length directly; approximate from char_end
    const approxTextLen = lastChunk?.char_end ?? 0
    const coveragePct   = approxTextLen > 0 && lastChunk
      ? Math.round((lastChunk.char_end ?? 0) / approxTextLen * 100 * 100) / 100
      : 0

    const lines: string[] = []
    lines.push(`# Chunk Export — ${doc.name}`)
    lines.push('')
    lines.push(`| Field | Value |`)
    lines.push(`|---|---|`)
    lines.push(`| doc_id | \`${docId}\` |`)
    lines.push(`| mode | ${doc.mode} |`)
    lines.push(`| token_count | ${doc.token_count ?? 'n/a'} |`)
    lines.push(`| chunk_count | ${chunks.length} |`)
    lines.push(`| coverage_pct | ${coveragePct}% |`)
    lines.push('')

    for (const c of chunks) {
      const section = c.section_title ? ` · §${c.section_title}` : ''
      const range   = (c.char_start != null && c.char_end != null)
        ? ` · ${c.char_start}–${c.char_end}`
        : ''
      // Approximate tokens from content length
      const approxTok = Math.round(c.content.length / 3.5)
      lines.push(`## [#${c.chunk_index}${section}${range} · ~${approxTok} tokens]`)
      lines.push('')
      lines.push(c.content)
      lines.push('')
    }

    // Write to Downloads
    const ts      = new Date().toISOString().replace(/[:.]/g, '-')
    const safeName = doc.name.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 60)
    const outPath = path.join(app.getPath('downloads'), `rag-chunks-${safeName}-${ts}.md`)
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8')
    console.log(`[RAG] Chunk export written to ${outPath}`)
    return outPath
  })

  // ── RUN EVAL ─────────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.RAG_RUN_EVAL,
    async (_, { filePath, chatId }: { filePath: string; chatId: string }) => {
      const { runEval } = await import('../services/rag/RagEvalService')
      // embedFn and scoreFn are omitted → real models used at runtime
      const report = await runEval(filePath, chatId)
      return report
    }
  )
}
