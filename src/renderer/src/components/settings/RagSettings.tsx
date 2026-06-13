import { useEffect, useState } from 'react'
import { FileDown, Play } from 'lucide-react'
import type { EvalReport, EvalModeResult } from '../../../../main/services/rag/RagEvalService'

// ── Shared primitives (self-contained — each settings panel owns its helpers) ──

function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none ${
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'cursor-pointer'
      } ${checked ? 'bg-red-700' : 'bg-surface-border'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

function Row({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div
      className={`flex items-start justify-between gap-6 py-4 border-b border-surface-border/30 ${
        disabled ? 'opacity-50' : ''
      }`}
      style={disabled ? { pointerEvents: 'none' } : undefined}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-content-primary mb-0.5">{label}</p>
        <p className="text-xs text-content-muted leading-relaxed">{description}</p>
      </div>
      <div className="flex-shrink-0 mt-0.5">
        <Toggle checked={checked} onChange={onChange} disabled={disabled} />
      </div>
    </div>
  )
}

type DocEntry = { docId: string; docName: string; mode: string; tokenCount: number; chunkCount: number }

export function RagSettings() {
  const [rerankEnabled,   setRerankEnabled]   = useState(false)
  const [ragVerboseTrace, setRagVerboseTrace] = useState(false)

  // Chunk inspector
  const [diagChatId,  setDiagChatId]  = useState('')
  const [diagDocs,    setDiagDocs]    = useState<DocEntry[]>([])
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagMsg,     setDiagMsg]     = useState('')

  // Eval harness
  const [evalFile,    setEvalFile]    = useState('evals/eval.jsonl')
  const [evalChatId,  setEvalChatId]  = useState('')
  const [evalRunning, setEvalRunning] = useState(false)
  const [evalResult,  setEvalResult]  = useState<EvalReport | null>(null)
  const [evalError,   setEvalError]   = useState('')

  useEffect(() => {
    window.api.ragGetSettings()
      .then((s) => {
        setRerankEnabled(s.rerankEnabled)
        setRagVerboseTrace(s.ragVerboseTrace)
      })
      .catch(console.error)
  }, [])

  const handleRerankToggle = (v: boolean) => {
    setRerankEnabled(v)
    window.api.ragSaveSettings({ rerankEnabled: v }).catch(console.error)
  }

  const handleVerboseTraceToggle = (v: boolean) => {
    setRagVerboseTrace(v)
    window.api.ragSaveSettings({ ragVerboseTrace: v }).catch(console.error)
  }

  const handleLoadDocs = async () => {
    if (!diagChatId.trim()) return
    setDiagLoading(true)
    setDiagMsg('')
    try {
      const docs = await window.api.ragListDocs(diagChatId.trim())
      setDiagDocs(docs)
      if (docs.length === 0) setDiagMsg('No indexed documents for this chat.')
    } catch (err) {
      setDiagMsg(`Error: ${String(err)}`)
    } finally {
      setDiagLoading(false)
    }
  }

  const handleExportChunks = async (docId: string) => {
    try {
      const outPath = await window.api.ragExportChunks(docId)
      setDiagMsg(`Exported to ${outPath}`)
    } catch (err) {
      setDiagMsg(`Export failed: ${String(err)}`)
    }
  }

  const handleRunEval = async () => {
    if (!evalFile.trim() || !evalChatId.trim()) return
    setEvalRunning(true)
    setEvalError('')
    setEvalResult(null)
    try {
      const report = await window.api.ragRunEval({ filePath: evalFile.trim(), chatId: evalChatId.trim() }) as EvalReport
      setEvalResult(report)
    } catch (err) {
      setEvalError(String(err))
    } finally {
      setEvalRunning(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* ── Toggle rows ── */}
      <div>
        <Row
          label="Re-rank retrieved passages (cross-encoder, experimental)"
          description="After keyword + vector search, a local cross-encoder model (jinaai/jina-reranker-v1-tiny-en) re-scores the top 20 candidates for finer relevance ordering. Requires a one-time ~7 MB model download; adds ~200–700 ms per document query."
          checked={rerankEnabled}
          onChange={handleRerankToggle}
        />
        <Row
          label="Verbose RAG tracing (logs full retrieved chunk text)"
          description="When enabled, rag_query observability events include the full text of every retrieved chunk and final passage. Useful for debugging retrieval quality; produces larger event payloads."
          checked={ragVerboseTrace}
          onChange={handleVerboseTraceToggle}
        />
      </div>

      {/* ── RAG diagnostics ── */}
      <div>
        <p className="text-[10px] font-semibold tracking-widest uppercase text-content-muted mb-3">
          RAG Diagnostics
        </p>
        <div className="rounded-xl border border-surface-border/40 p-4 space-y-3" style={{ background: '#111' }}>
          <p className="text-xs text-content-secondary">
            Enter a chat ID to inspect its indexed documents and export chunk content.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Chat ID"
              value={diagChatId}
              onChange={e => setDiagChatId(e.target.value)}
              className="flex-1 text-xs rounded-md px-2.5 py-1.5 border border-surface-border bg-transparent text-content-primary placeholder:text-content-muted focus:outline-none focus:border-accent-700"
            />
            <button
              onClick={handleLoadDocs}
              disabled={diagLoading || !diagChatId.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-surface-border text-content-secondary hover:text-content-primary hover:border-accent-700 transition-colors disabled:opacity-40"
            >
              {diagLoading ? 'Loading…' : 'Load'}
            </button>
          </div>
          {diagMsg && <p className="text-xs text-content-muted">{diagMsg}</p>}
          {diagDocs.length > 0 && (
            <div className="rounded-lg border border-surface-border/30 overflow-hidden">
              {diagDocs.map((doc, idx) => (
                <div
                  key={doc.docId}
                  className={`flex items-center gap-3 px-3 py-2.5 text-xs ${idx < diagDocs.length - 1 ? 'border-b border-surface-border/20' : ''}`}
                >
                  <span className="flex-1 text-content-primary font-mono truncate min-w-0">{doc.docName}</span>
                  <span className="text-content-muted flex-shrink-0">{doc.chunkCount} chunks</span>
                  <span className="text-content-muted flex-shrink-0">{doc.tokenCount ? `~${doc.tokenCount} tok` : ''}</span>
                  <button
                    onClick={() => void handleExportChunks(doc.docId)}
                    className="flex items-center gap-1 px-2 py-1 rounded border border-surface-border text-content-muted hover:text-content-primary hover:border-accent-700 transition-colors"
                    title="Export chunks to markdown"
                  >
                    <FileDown className="w-3 h-3" />
                    Export
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Eval harness ── */}
      <div>
        <p className="text-[10px] font-semibold tracking-widest uppercase text-content-muted mb-3">
          Run RAG Eval
        </p>
        <div className="rounded-xl border border-surface-border/40 p-4 space-y-3" style={{ background: '#111' }}>
          <p className="text-xs text-content-secondary">
            Evaluate retrieval quality against a JSONL ground-truth file. Each line: <code className="text-accent-400">{"{ \"query\": \"…\", \"relevant\": [\"substring1\", …] }"}</code>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="Eval file path (e.g. evals/eval.jsonl)"
              value={evalFile}
              onChange={e => setEvalFile(e.target.value)}
              className="text-xs rounded-md px-2.5 py-1.5 border border-surface-border bg-transparent text-content-primary placeholder:text-content-muted focus:outline-none focus:border-accent-700"
            />
            <input
              type="text"
              placeholder="Chat ID"
              value={evalChatId}
              onChange={e => setEvalChatId(e.target.value)}
              className="text-xs rounded-md px-2.5 py-1.5 border border-surface-border bg-transparent text-content-primary placeholder:text-content-muted focus:outline-none focus:border-accent-700"
            />
          </div>
          <button
            onClick={handleRunEval}
            disabled={evalRunning || !evalFile.trim() || !evalChatId.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-accent-800/60 text-accent-400 hover:border-accent-700 hover:text-accent-300 transition-colors disabled:opacity-40"
          >
            <Play className="w-3 h-3" />
            {evalRunning ? 'Running…' : 'Run Eval'}
          </button>
          {evalError && <p className="text-xs text-red-400">{evalError}</p>}
          {evalResult && <EvalResultTable report={evalResult} />}
        </div>
      </div>
    </div>
  )
}

function EvalResultTable({ report }: { report: EvalReport }) {
  return (
    <div className="space-y-3 pt-1">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-content-secondary">
          {report.resolvedCount}/{report.queryCount} queries resolved
        </p>
        <p className="text-xs text-content-muted">{new Date(report.timestamp).toLocaleString()}</p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-surface-border/30">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-surface-border/30">
              <th className="text-left px-3 py-2 text-content-muted font-medium">Mode</th>
              <th className="text-right px-3 py-2 text-content-muted font-medium">Hit@K</th>
              <th className="text-right px-3 py-2 text-content-muted font-medium">P@K</th>
              <th className="text-right px-3 py-2 text-content-muted font-medium">R@K</th>
              <th className="text-right px-3 py-2 text-content-muted font-medium">MRR</th>
              <th className="text-right px-3 py-2 text-content-muted font-medium">CandRec</th>
            </tr>
          </thead>
          <tbody>
            {report.aggregates.map((m: EvalModeResult) => (
              <tr key={m.mode} className="border-b border-surface-border/20 last:border-0">
                <td className="px-3 py-2 text-content-primary font-mono">{m.mode}</td>
                <td className="px-3 py-2 text-right text-content-secondary">{m.hitAtK.toFixed(3)}</td>
                <td className="px-3 py-2 text-right text-content-secondary">{m.precisionAtK.toFixed(3)}</td>
                <td className="px-3 py-2 text-right text-content-secondary">{m.recallAtK.toFixed(3)}</td>
                <td className="px-3 py-2 text-right text-content-secondary">{m.mrr.toFixed(3)}</td>
                <td className="px-3 py-2 text-right text-content-secondary">{m.candidateRecall.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-content-muted">Full report with per-query breakdown written to Downloads.</p>
    </div>
  )
}
