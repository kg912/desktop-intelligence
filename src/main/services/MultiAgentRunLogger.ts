/**
 * Per-run multi-agent call logs (specs/multi-agent-observability.md §3.3, §4).
 *
 *   <root>/<chatId>/<runId>/
 *     run.meta.json  run.md  events.jsonl
 *     planner.jsonl  agent-<id>.jsonl  synthesis.jsonl   ← call records, appended as they arrive
 *     planner.md     agent-<id>.md     synthesis.md      ← rendered from the JSONL when the run ends
 *
 * Everything is appended as it arrives, so a crash leaves valid JSONL and a
 * run.meta.json that still says "incomplete". Markdown is rendered from the
 * files on disk, never from memory, so an incomplete run can be rendered later
 * too. No Electron imports: the root directory and secrets are injected.
 *
 * A logger failure never fails or slows a run: every entry point is
 * synchronous and non-throwing; disk work happens on one background queue.
 */
import fs from 'fs/promises'
import path from 'path'
import type { AgentEvent, MultiAgentConfig } from '../../shared/types'

export const DEFAULT_KEEP_RUNS = 50

export type RunLogStatus = 'incomplete' | 'completed' | 'failed'

export interface RunLogMeta {
  schema: 1
  runId: string
  chatId: string
  chatTitle: string
  task: string
  startedAt: number
  endedAt: number | null
  status: RunLogStatus
  config: MultiAgentConfig
  /** Filled when the run is rendered. */
  summary?: RunSummary
}

export interface RunSummary {
  modelCalls: number
  toolCalls: number
  costUsd: number
  tokens: number
  durationMs: number | null
  /** Reported by the run's terminal event, for reconciliation (null if the run never ended). */
  reportedCostUsd: number | null
  reportedTokens: number | null
  anomalies: Anomaly[]
}

export interface Anomaly {
  kind: 'length' | 'served_model_differs' | 'fallback_plan' | 'repetition' | 'retry' | 'error' | 'cancelled' | 'tool_denied' | 'tool_rejected' | 'reconciliation' | 'capped'
  message: string
  /** Link target inside the run directory, e.g. "agent-1.1.md#call-7". */
  ref?: string
}

/** One call record as the sidecar writes it (resources/python/multi_agent_sidecar.py call_record / record_tool). */
export interface CallRecord {
  schema: 1
  runId: string
  chatId: string
  seq: number
  kind: 'model' | 'tool'
  role: 'planner' | 'worker' | 'reflection' | 'synthesis'
  agentId: string | null
  attempt: number
  toolRound?: number
  retry?: number
  model?: string
  modelServed?: string | null
  request?: { messages: Array<Record<string, unknown>>; params: Record<string, unknown>; headers?: Record<string, string> } | null
  response?: {
    content: string
    reasoning: string
    toolCalls: Array<{ id: string; name: string; arguments: string }>
    finishReason: string | null
    looped?: string | null
    truncated?: string | null
  }
  usage?: { promptTokens: number | null; completionTokens: number | null; reasoningTokens: number | null; costUsd: number | null; generationId: string | null }
  timing: { startedAt: number | null; firstTokenAt?: number | null; endedAt: number; ms: number | null }
  error?: { kind: string; message: string; httpStatus: number | null } | null
  capped?: Array<{ field: string; originalChars: number }> | null
  // kind: "tool"
  callId?: string
  name?: string
  args?: string
  result?: string | null
  approved?: boolean
  denied?: boolean
}

interface ActiveRun {
  dir: string
  meta: RunLogMeta
  secrets: Promise<string[]>
}

export interface RunLoggerOptions {
  /** Credentials that must never appear in a log: scrubbed from every line before it is written. */
  secrets: () => Promise<string[]> | string[]
  /** Run directories to keep; the oldest beyond this are deleted (never an active one). */
  keep?: () => number
}

/** File-name-safe id (agent ids come from planner output). */
export function safeId(id: string): string {
  return id.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_') || '_'
}

export function recordFile(record: Pick<CallRecord, 'role' | 'agentId'>): string {
  if (record.role === 'planner') return 'planner'
  if (record.role === 'synthesis') return 'synthesis'
  return `agent-${safeId(record.agentId ?? 'unknown')}`
}

export function scrub(text: string, secrets: string[]): string {
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]')
  return text
}

export class MultiAgentRunLogger {
  private readonly active = new Map<string, ActiveRun>()
  private readonly pending = new Map<string, { lines: string[]; secrets: Promise<string[]> }>()
  private draining: Promise<void> | null = null

  constructor(readonly root: string, private readonly opts: RunLoggerOptions) {}

  runDir(chatId: string, runId: string): string {
    return path.join(this.root, safeId(chatId), safeId(runId))
  }

  isActive(runId: string): boolean {
    return this.active.has(runId)
  }

  begin(info: { runId: string; chatId: string; chatTitle: string; task: string; config: MultiAgentConfig; startedAt?: number }): void {
    try {
      const dir = this.runDir(info.chatId, info.runId)
      const secrets = Promise.resolve()
        .then(() => this.opts.secrets())
        .then((list) => list.filter((s) => typeof s === 'string' && s.length >= 8))
        .catch(() => [])
      const meta: RunLogMeta = {
        schema: 1, runId: info.runId, chatId: info.chatId, chatTitle: info.chatTitle, task: info.task,
        startedAt: info.startedAt ?? Date.now(), endedAt: null, status: 'incomplete', config: info.config,
      }
      this.active.set(info.runId, { dir, meta, secrets })
      this.write(info.runId, 'run.meta.json', JSON.stringify(meta, null, 2), 'replace')
      void this.prune()
    } catch (err) {
      console.warn('[RunLog] begin failed:', err)
    }
  }

  /** A UI AgentEvent (coalesced, as persisted). The terminal event ends the run and renders it. */
  event(event: AgentEvent): void {
    try {
      const run = this.active.get(event.runId)
      if (!run) return // not recorded: the run started while observability was off
      this.write(event.runId, 'events.jsonl', JSON.stringify(event))
      if (event.type === 'task_complete' || event.type === 'task_failed') {
        this.active.delete(event.runId)
        run.meta = { ...run.meta, endedAt: Date.now(), status: event.type === 'task_complete' ? 'completed' : 'failed' }
        void this.finish(run)
      }
    } catch (err) {
      console.warn('[RunLog] event write failed:', err)
    }
  }

  record(runId: string, record: CallRecord): void {
    try {
      if (!this.active.has(runId)) return
      this.write(runId, `${recordFile(record)}.jsonl`, JSON.stringify(record))
    } catch (err) {
      console.warn('[RunLog] record write failed:', err)
    }
  }

  /** Resolves once every queued line is on disk. */
  async flush(): Promise<void> {
    while (this.draining) await this.draining
  }

  private async finish(run: ActiveRun): Promise<void> {
    try {
      this.write(run.meta.runId, 'run.meta.json', JSON.stringify(run.meta, null, 2), 'replace', run)
      await this.flush()
      await renderRun(run.dir, await run.secrets)
    } catch (err) {
      console.warn('[RunLog] render failed:', err)
    }
  }

  // ── Disk queue: one writer, per-file order preserved ──────────────────────

  private write(runId: string, file: string, text: string, mode: 'append' | 'replace' = 'append', known?: ActiveRun): void {
    const run = known ?? this.active.get(runId)
    if (!run) return
    const key = `${mode}:${path.join(run.dir, file)}`
    const entry = this.pending.get(key)
    if (mode === 'replace') this.pending.delete(key) // a newer replace supersedes an unwritten older one
    if (mode === 'append' && entry) entry.lines.push(text + '\n')
    else this.pending.set(key, { lines: [mode === 'append' ? text + '\n' : text], secrets: run.secrets })
    this.draining ??= this.drain()
  }

  private async drain(): Promise<void> {
    while (this.pending.size) {
      const [key, { lines, secrets }] = this.pending.entries().next().value!
      this.pending.delete(key)
      const [mode, ...rest] = key.split(':')
      const file = rest.join(':')
      try {
        const text = scrub(lines.join(''), await secrets)
        await fs.mkdir(path.dirname(file), { recursive: true })
        if (mode === 'append') await fs.appendFile(file, text, 'utf8')
        else await fs.writeFile(file, text, 'utf8')
      } catch (err) {
        console.warn('[RunLog] write failed:', err)
      }
    }
    this.draining = null
  }

  // ── Browse / retention ─────────────────────────────────────────────────

  async listRuns(): Promise<Array<RunLogMeta & { dir: string }>> {
    const out: Array<RunLogMeta & { dir: string }> = []
    let chats: string[] = []
    try { chats = await fs.readdir(this.root) } catch { return out }
    for (const chat of chats) {
      let runs: string[] = []
      try { runs = await fs.readdir(path.join(this.root, chat)) } catch { continue }
      for (const run of runs) {
        const dir = path.join(this.root, chat, run)
        try {
          out.push({ ...(JSON.parse(await fs.readFile(path.join(dir, 'run.meta.json'), 'utf8')) as RunLogMeta), dir })
        } catch { /* not a run directory */ }
      }
    }
    return out.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Deletes a run directory; refuses while that run is active. */
  async deleteRun(chatId: string, runId: string): Promise<boolean> {
    if (this.active.has(runId)) return false
    await fs.rm(this.runDir(chatId, runId), { recursive: true, force: true })
    await fs.rmdir(path.join(this.root, safeId(chatId))).catch(() => {}) // only if now empty
    return true
  }

  async prune(): Promise<void> {
    try {
      const keep = Math.max(1, this.opts.keep?.() ?? DEFAULT_KEEP_RUNS)
      const runs = await this.listRuns()
      for (const run of runs.slice(keep)) {
        if (!this.active.has(run.runId)) await this.deleteRun(run.chatId, run.runId)
      }
    } catch (err) {
      console.warn('[RunLog] retention failed:', err)
    }
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Parses JSONL, skipping a torn last line (crash mid-append). */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as T) } catch { /* torn or corrupt line */ }
  }
  return out
}

export async function readRun(dir: string): Promise<{ meta: RunLogMeta; events: AgentEvent[]; records: CallRecord[] }> {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'run.meta.json'), 'utf8')) as RunLogMeta
  const files = await fs.readdir(dir)
  const read = async (name: string): Promise<string> => fs.readFile(path.join(dir, name), 'utf8').catch(() => '')
  const events = parseJsonl<AgentEvent>(await read('events.jsonl'))
  const records: CallRecord[] = []
  for (const name of files) {
    if (name.endsWith('.jsonl') && name !== 'events.jsonl') records.push(...parseJsonl<CallRecord>(await read(name)))
  }
  records.sort((a, b) => a.seq - b.seq)
  return { meta, events, records }
}

// ── Rendering ───────────────────────────────────────────────────────────────

const ROLES = ['planner', 'worker', 'reflection', 'synthesis'] as const

function fence(body: string, lang = ''): string {
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((m) => m.length))
  const f = '`'.repeat(longest + 1)
  return `${f}${lang}\n${body}\n${f}`
}

function details(summary: string, body: string, lang = ''): string {
  return `<details><summary>${escapeHtml(summary)}</summary>\n\n${fence(body, lang)}\n\n</details>`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function cell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

const usd = (n: number | null | undefined): string => (n == null ? '' : `$${n.toFixed(6)}`)
const iso = (ms: number | null | undefined): string => (ms ? new Date(ms).toISOString() : '')
const tokensOf = (r: CallRecord): number => (r.usage?.promptTokens ?? 0) + (r.usage?.completionTokens ?? 0)

export function anchor(r: CallRecord): string {
  return `call-${r.seq}`
}

export function callRef(r: CallRecord): string {
  return `${recordFile(r)}.md#${anchor(r)}`
}

function callTitle(r: CallRecord): string {
  if (r.kind === 'tool') return `Tool ${r.name} (${r.callId}), round ${r.toolRound ?? 0}`
  const parts: string[] = [r.role]
  if (r.role === 'worker') parts.push(`tool round ${r.toolRound ?? 0}`)
  if (r.role === 'planner') parts.push(`attempt ${r.attempt}`)
  if (r.retry) parts.push(`retry ${r.retry}`)
  return parts.join(', ')
}

function renderModelCall(r: CallRecord): string {
  const res = r.response
  const lines = [
    `<a id="${anchor(r)}"></a>`,
    `#### Call ${r.seq}: ${callTitle(r)}`,
    '',
    '| Field | Value |',
    '|---|---|',
    `| Model requested | \`${cell(r.model)}\` |`,
    `| Model served | \`${cell(r.modelServed ?? '')}\` |`,
    `| Finish reason | ${cell(res?.finishReason ?? '')}${res?.truncated ? ` (limit: ${res.truncated})` : ''}${res?.looped ? ` (repetition guard: ${res.looped})` : ''} |`,
    `| Tokens | ${r.usage?.promptTokens ?? ''} prompt / ${r.usage?.completionTokens ?? ''} completion${r.usage?.reasoningTokens ? ` (${r.usage.reasoningTokens} reasoning)` : ''} |`,
    `| Cost | ${usd(r.usage?.costUsd)} |`,
    `| Started | ${iso(r.timing.startedAt)} |`,
    `| First token | ${iso(r.timing.firstTokenAt)} |`,
    `| Duration | ${r.timing.ms ?? ''} ms |`,
    `| Generation id | \`${cell(r.usage?.generationId ?? '')}\` |`,
  ]
  if (r.error) lines.push(`| Error | ${cell(`${r.error.kind}${r.error.httpStatus ? ` HTTP ${r.error.httpStatus}` : ''}: ${r.error.message}`)} |`)
  if (r.capped?.length) lines.push(`| Cut fields | ${cell(r.capped.map((c) => `${c.field} (${c.originalChars} chars)`).join(', '))} |`)
  lines.push('')
  const messages = r.request?.messages ?? []
  for (const [i, m] of messages.entries()) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)
    const extra = { ...m }
    delete extra.role
    delete extra.content
    const tail = Object.keys(extra).length ? `\n\n${JSON.stringify(extra, null, 2)}` : ''
    lines.push(details(`Message ${i + 1}: ${String(m.role)}`, content + tail), '')
  }
  if (r.request) lines.push(details('Request parameters', JSON.stringify(r.request.params, null, 2), 'json'), '')
  if (res?.reasoning) lines.push(details('Reasoning (raw)', res.reasoning), '')
  lines.push(details('Output (raw)', res?.content ?? ''), '')
  if (res?.toolCalls.length) lines.push(details('Tool calls requested', JSON.stringify(res.toolCalls, null, 2), 'json'), '')
  return lines.join('\n')
}

function renderToolCall(r: CallRecord): string {
  const status = r.error ? `rejected or failed: ${r.error}` : r.approved ? 'approved, executed' : r.denied ? 'denied' : 'not executed'
  return [
    `<a id="${anchor(r)}"></a>`,
    `#### Call ${r.seq}: ${callTitle(r)}`,
    '',
    `Status: ${status}. Duration: ${r.timing.ms ?? ''} ms.`,
    '',
    details('Arguments (raw)', r.args ?? '', 'json'),
    '',
    details('Result (as sent back to the model)', r.result ?? '(none)'),
    '',
  ].join('\n')
}

function renderCall(r: CallRecord): string {
  return r.kind === 'tool' ? renderToolCall(r) : renderModelCall(r)
}

type Ev<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>

function eventsOf<T extends AgentEvent['type']>(events: AgentEvent[], type: T): Array<Ev<T>> {
  return events.filter((e): e is Ev<T> => e.type === type)
}

function renderAgentFile(agentId: string, records: CallRecord[], events: AgentEvent[], step: { label?: string; role?: string } | undefined): string {
  const lines = [`# Agent ${agentId}${step?.role ? `: ${step.role}` : ''}`, '', step?.label ? `Subtask: ${step.label}` : '', '', '[Back to run](run.md)', '']
  const attempts = [...new Set(records.map((r) => r.attempt))].sort((a, b) => a - b)
  for (const attempt of attempts) {
    lines.push(`## Attempt ${attempt}`, '')
    const mine = records.filter((r) => r.attempt === attempt)
    const work = mine.filter((r) => r.role === 'worker').sort((a, b) => (a.toolRound ?? 0) - (b.toolRound ?? 0) || a.seq - b.seq)
    lines.push('### Work', '')
    for (const r of work) lines.push(renderCall(r))
    const reflections = mine.filter((r) => r.role === 'reflection')
    const verdict = events.find((e): e is Ev<'reflection_result'> => e.type === 'reflection_result' && e.agentId === agentId && (e.attempt ?? 0) === attempt)
    if (reflections.length || verdict) {
      lines.push('### Reflection', '')
      for (const r of reflections) lines.push(renderCall(r))
      if (verdict) {
        lines.push(`Parsed verdict: score ${verdict.score}/5, ${verdict.passed ? 'passed' : 'failed'}${verdict.model ? ` (judge: \`${verdict.model}\`)` : ''}. ${verdict.reason}`, '')
        for (const issue of verdict.issues ?? []) lines.push(`- ${issue}`)
        lines.push('')
      }
    }
  }
  const failed = events.find((e): e is Ev<'agent_failed'> => e.type === 'agent_failed' && e.agentId === agentId)
  if (failed) lines.push(`## Failed`, '', failed.reason, '')
  return lines.join('\n')
}

function renderSimpleFile(title: string, records: CallRecord[]): string {
  return [`# ${title}`, '', '[Back to run](run.md)', '', ...records.map(renderCall)].join('\n')
}

/** Peak number of model calls in flight at once, from their recorded start/end times. */
export function peakConcurrency(records: CallRecord[]): number {
  const edges: Array<[number, number]> = []
  for (const r of records) {
    if (r.kind !== 'model' || r.timing.startedAt == null) continue
    edges.push([r.timing.startedAt, 1], [r.timing.endedAt, -1])
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]) // an end before a start at the same instant
  let now = 0
  let peak = 0
  for (const [, d] of edges) peak = Math.max(peak, (now += d))
  return peak
}

export function summarise(meta: RunLogMeta, events: AgentEvent[], records: CallRecord[]): RunSummary {
  const model = records.filter((r) => r.kind === 'model')
  const tools = records.filter((r) => r.kind === 'tool')
  const terminal = events.find((e): e is Ev<'task_complete'> => e.type === 'task_complete')
  const costUsd = model.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0)
  const tokens = model.reduce((s, r) => s + tokensOf(r), 0)
  return {
    modelCalls: model.length,
    toolCalls: tools.length,
    costUsd,
    tokens,
    durationMs: meta.endedAt ? meta.endedAt - meta.startedAt : null,
    reportedCostUsd: terminal ? terminal.totalCostUsd : null,
    reportedTokens: terminal ? terminal.totalTokens : null,
    anomalies: findAnomalies(meta, events, records, costUsd, tokens),
  }
}

/** Cost differences below this are float rounding (the sidecar rounds totals to 8 decimals). */
const RECONCILE_USD = 1e-6

/** Everything in a run worth a second look, each linked to the call that shows it (spec §4 item 7). */
export function findAnomalies(_meta: RunLogMeta, events: AgentEvent[], records: CallRecord[], costUsd: number, tokens: number): Anomaly[] {
  const out: Anomaly[] = []
  const who = (r: CallRecord): string => `${r.role}${r.agentId ? ` ${r.agentId}` : ''} attempt ${r.attempt}`
  for (const r of records) {
    const ref = callRef(r)
    if (r.kind === 'tool') {
      if (r.error) out.push({ kind: 'tool_rejected', message: `${r.name} rejected for agent ${r.agentId}: ${r.error}`, ref })
      else if (r.denied) out.push({ kind: 'tool_denied', message: `${r.name} denied for agent ${r.agentId}`, ref })
      continue
    }
    const res = r.response
    if (res?.finishReason === 'length') out.push({ kind: 'length', message: `${who(r)} stopped at its token limit (${res.truncated ?? 'unknown'} bound)`, ref })
    if (res?.looped) out.push({ kind: 'repetition', message: `${who(r)}: repetition guard stopped the ${res.looped} stream`, ref })
    // A dated or variant id of the same model (e.g. "<id>-20240620") is not a different model.
    if (r.modelServed && r.model && !r.modelServed.startsWith(r.model)) {
      out.push({ kind: 'served_model_differs', message: `${who(r)} requested \`${r.model}\`, OpenRouter served \`${r.modelServed}\``, ref })
    }
    if (res?.finishReason === 'cancelled') out.push({ kind: 'cancelled', message: `${who(r)} was cancelled mid-call`, ref })
    else if (r.error) out.push({ kind: 'error', message: `${who(r)} failed: ${r.error.kind}${r.error.httpStatus ? ` HTTP ${r.error.httpStatus}` : ''}: ${r.error.message}`, ref })
    if (r.role === 'planner' && r.attempt > 0) out.push({ kind: 'retry', message: `planner re-asked (attempt ${r.attempt})`, ref })
    if (r.role === 'reflection' && (r.retry ?? 0) > 0) out.push({ kind: 'retry', message: `reviewer re-asked for agent ${r.agentId} after an unusable verdict`, ref })
    for (const c of r.capped ?? []) out.push({ kind: 'capped', message: `${who(r)}: ${c.field} cut in the log (${c.originalChars} chars)`, ref })
  }
  for (const e of events) {
    if (e.type === 'orchestrator_plan' && e.fallback) out.push({ kind: 'fallback_plan', message: 'the planner never returned a usable plan; the built-in fallback plan ran', ref: 'planner.md' })
    if (e.type === 'retry') out.push({ kind: 'retry', message: `agent ${e.agentId} retried (attempt ${e.attempt}): ${e.reason}`, ref: `agent-${safeId(e.agentId)}.md` })
  }
  const done = events.find((e): e is Ev<'task_complete'> => e.type === 'task_complete')
  if (done && (Math.abs(done.totalCostUsd - costUsd) > RECONCILE_USD || done.totalTokens !== tokens)) {
    out.push({ kind: 'reconciliation', message: `call records sum to ${tokens} tokens / ${usd(costUsd)}; the run reported ${done.totalTokens} tokens / ${usd(done.totalCostUsd)}` })
  }
  return out
}

function mermaidId(id: string): string {
  return `s_${id.replace(/\W/g, '_')}`
}

export function renderRunMd(meta: RunLogMeta, events: AgentEvent[], records: CallRecord[], summary: RunSummary): string {
  const plan = eventsOf(events, 'orchestrator_plan').at(-1)?.steps ?? []
  const runConfig = eventsOf(events, 'run_config').at(-1)
  const t0 = Math.min(meta.startedAt, ...records.map((r) => r.timing.startedAt ?? Infinity))
  const L: string[] = []

  L.push(`# Multi-agent run: ${meta.chatTitle || '(untitled chat)'}`, '')
  L.push('| Field | Value |', '|---|---|')
  L.push(`| Run id | \`${meta.runId}\` |`, `| Chat id | \`${meta.chatId}\` |`)
  L.push(`| Started | ${iso(meta.startedAt)} |`, `| Ended | ${iso(meta.endedAt)} |`, `| Status | ${meta.status} |`)
  L.push('', '## Trigger', '', fence(meta.task), '')

  L.push('## Config', '')
  L.push('| Role | Model | Source |', '|---|---|---|')
  const models = runConfig?.models ?? meta.config.models
  for (const [role, id] of Object.entries(models)) L.push(`| ${role} | \`${cell(id)}\` | ${cell(runConfig?.sources?.[role] ?? '')} |`)
  L.push('')
  const c = meta.config
  L.push('| Setting | Value |', '|---|---|')
  L.push(`| Max agents | ${c.maxAgents} |`, `| Budget cap | ${usd(c.budgetCapUsd)} |`, `| Reflection pass threshold | ${c.reflectionPassThreshold} |`)
  L.push(`| Max retries per agent | ${c.maxRetriesPerAgent} |`, `| Reasoning effort | ${c.reasoningEffort ?? ''} |`, `| Tool approvals required | ${c.requirePermissions} |`)
  L.push(`| Approval timeout | ${c.hitlTimeoutMs} ms |`, `| Catalogue checked | ${runConfig?.catalogueChecked ?? ''} |`, `| Tools offered | ${cell((runConfig?.tools ?? []).join(', '))} |`, '')

  L.push('## Plan', '')
  if (plan.length) {
    L.push('| Step | Role | Label | Depends on |', '|---|---|---|---|')
    for (const s of plan) L.push(`| [${s.id}](agent-${safeId(s.id)}.md) | ${cell(s.role)} | ${cell(s.label)} | ${cell((s.dependsOn ?? []).join(', '))} |`)
    L.push('', '```mermaid', 'flowchart LR')
    for (const s of plan) L.push(`  ${mermaidId(s.id)}["${s.id} ${s.role}: ${s.label.replace(/"/g, '#quot;')}"]`)
    L.push('  synth(["Synthesis"])')
    const dependedOn = new Set(plan.flatMap((s) => s.dependsOn ?? []))
    for (const s of plan) for (const d of s.dependsOn ?? []) L.push(`  ${mermaidId(d)} --> ${mermaidId(s.id)}`)
    for (const s of plan) if (!dependedOn.has(s.id)) L.push(`  ${mermaidId(s.id)} --> synth`)
    L.push('```', '')
  } else L.push('No plan was recorded.', '')

  L.push('## Timeline', '', `Peak concurrency (model calls in flight at once, from recorded timestamps): ${peakConcurrency(records)}`, '')
  L.push('| # | Start (+ms) | Duration (ms) | Kind | Role | Agent | Attempt | Model | Tokens | Cost | Finish | Record |', '|---|---|---|---|---|---|---|---|---|---|---|---|')
  const ordered = [...records].sort((a, b) => (a.timing.startedAt ?? a.timing.endedAt) - (b.timing.startedAt ?? b.timing.endedAt) || a.seq - b.seq)
  for (const r of ordered) {
    const start = (r.timing.startedAt ?? r.timing.endedAt) - t0
    const finish = r.kind === 'tool' ? (r.error ? 'rejected' : r.approved ? 'ok' : 'denied') : r.response?.finishReason ?? ''
    L.push(`| ${r.seq} | ${start} | ${r.timing.ms ?? ''} | ${r.kind === 'tool' ? `tool ${cell(r.name)}` : 'model'} | ${r.role} | ${r.agentId ?? ''} | ${r.attempt} | ${r.kind === 'model' ? `\`${cell(r.model)}\`` : ''} | ${r.kind === 'model' ? tokensOf(r) : ''} | ${r.kind === 'model' ? usd(r.usage?.costUsd) : ''} | ${cell(finish)} | [${callRef(r)}](${callRef(r)}) |`)
  }
  L.push('')

  L.push('## Agents', '')
  L.push('| Agent | Role | Attempts | Reflection scores | Outcome | Tools used | Cost |', '|---|---|---|---|---|---|---|')
  for (const s of plan) {
    const mine = records.filter((r) => r.agentId === s.id)
    const scores = eventsOf(events, 'reflection_result').filter((e) => e.agentId === s.id).map((e) => `${e.score}${e.passed ? '✓' : '✗'}`)
    const failed = eventsOf(events, 'agent_failed').find((e) => e.agentId === s.id)
    const done = eventsOf(events, 'agent_complete').some((e) => e.agentId === s.id)
    const tools = [...new Set(mine.filter((r) => r.kind === 'tool').map((r) => r.name))]
    const attempts = new Set(mine.map((r) => r.attempt)).size
    const cost = mine.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0)
    L.push(`| [${s.id}](agent-${safeId(s.id)}.md) | ${cell(s.role)} | ${attempts} | ${scores.join(' ')} | ${cell(failed ? `failed: ${failed.reason}` : done ? 'completed' : 'not finished')} | ${cell(tools.join(', '))} | ${usd(cost)} |`)
  }
  for (const s of plan) {
    const issues = eventsOf(events, 'reflection_result').filter((e) => e.agentId === s.id && (e.issues?.length ?? 0) > 0)
    for (const e of issues) L.push('', `Reviewer issues for ${s.id}, attempt ${e.attempt ?? 0}:`, ...(e.issues ?? []).map((i) => `- ${i}`))
  }
  L.push('')

  L.push('## Totals', '')
  L.push('| Role | Calls | Tokens | Cost |', '|---|---|---|---|')
  for (const role of ROLES) {
    const rs = records.filter((r) => r.kind === 'model' && r.role === role)
    L.push(`| ${role} | ${rs.length} | ${rs.reduce((s, r) => s + tokensOf(r), 0)} | ${usd(rs.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0))} |`)
  }
  L.push('', '| Model | Calls | Tokens | Cost |', '|---|---|---|---|')
  for (const id of [...new Set(records.filter((r) => r.kind === 'model').map((r) => r.model ?? ''))]) {
    const rs = records.filter((r) => r.kind === 'model' && r.model === id)
    L.push(`| \`${cell(id)}\` | ${rs.length} | ${rs.reduce((s, r) => s + tokensOf(r), 0)} | ${usd(rs.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0))} |`)
  }
  L.push('', `Sum of call records: ${summary.modelCalls} model calls, ${summary.toolCalls} tool calls, ${summary.tokens} tokens, ${usd(summary.costUsd)}.`)
  if (summary.reportedCostUsd != null) {
    L.push(`Reported by the run: ${summary.reportedTokens} tokens, ${usd(summary.reportedCostUsd)}.`, '')
    L.push(summary.anomalies.some((a) => a.kind === 'reconciliation') ? '**Mismatch** between call records and the run\'s totals: see Anomalies.' : 'Reconciled with the run\'s own totals.')
  }
  L.push('')

  L.push('## Anomalies', '')
  if (!summary.anomalies.length) L.push('None detected.')
  for (const a of summary.anomalies) L.push(`- **${a.kind}**: ${a.message}${a.ref ? ` ([${a.ref}](${a.ref}))` : ''}`)
  L.push('', '## Files', '', '- [events.jsonl](events.jsonl): the UI events for this run', '- `*.jsonl`: full call records; the markdown files are rendered from them', '')
  return L.join('\n')
}

/** Renders every markdown file and refreshes run.meta.json's summary from the files on disk. */
export async function renderRun(dir: string, secrets: string[] = []): Promise<RunLogMeta> {
  const { meta, events, records } = await readRun(dir)
  const summary = summarise(meta, events, records)
  const plan = eventsOf(events, 'orchestrator_plan').at(-1)?.steps ?? []
  const out = new Map<string, string>()
  out.set('run.md', renderRunMd(meta, events, records, summary))
  out.set('planner.md', renderSimpleFile('Planner', records.filter((r) => r.role === 'planner')))
  out.set('synthesis.md', renderSimpleFile('Synthesis', records.filter((r) => r.role === 'synthesis')))
  const agentIds = [...new Set([...plan.map((s) => s.id), ...records.filter((r) => r.agentId).map((r) => r.agentId!)])]
  for (const id of agentIds) {
    out.set(`agent-${safeId(id)}.md`, renderAgentFile(id, records.filter((r) => r.agentId === id), events, plan.find((s) => s.id === id)))
  }
  const updated: RunLogMeta = { ...meta, summary }
  out.set('run.meta.json', JSON.stringify(updated, null, 2))
  for (const [name, text] of out) await fs.writeFile(path.join(dir, name), scrub(text, secrets), 'utf8')
  return updated
}

// ── Debug panel views (read-only, built from the files) ──────────────────────

export type RunRowStatus = RunLogStatus | 'running' | 'not_recorded'

export interface RunListRow {
  runId: string
  chatId: string
  chatTitle: string
  startedAt: number
  status: RunRowStatus
  models: Record<string, string>
  costUsd: number | null
  durationMs: number | null
  anomalyCount: number | null
}

export interface TimelineCall {
  seq: number
  kind: 'model' | 'tool'
  role: CallRecord['role']
  agentId: string | null
  attempt: number
  label: string
  /** ms from the run's first recorded call. */
  start: number
  ms: number
  finish: string
  /** File (in the run directory) that holds this call, and its anchor. */
  file: string
  anchor: string
  anomalous: boolean
}

export interface RunDetail {
  meta: RunLogMeta
  plan: Array<{ id: string; role: string; label: string; dependsOn: string[] }>
  calls: TimelineCall[]
  anomalies: Anomaly[]
  peak: number
  files: string[]
}

export function rowFromMeta(meta: RunLogMeta, active: boolean): RunListRow {
  return {
    runId: meta.runId, chatId: meta.chatId, chatTitle: meta.chatTitle, startedAt: meta.startedAt,
    status: active ? 'running' : meta.status,
    models: meta.config?.models ?? {},
    costUsd: meta.summary?.costUsd ?? null,
    durationMs: meta.summary?.durationMs ?? null,
    anomalyCount: meta.summary ? meta.summary.anomalies.length : null,
  }
}

export async function runDetail(dir: string): Promise<RunDetail> {
  const { meta, events, records } = await readRun(dir)
  const summary = meta.summary ?? summarise(meta, events, records)
  const t0 = Math.min(...records.map((r) => r.timing.startedAt ?? r.timing.endedAt), Infinity)
  const flagged = new Set(summary.anomalies.map((a) => a.ref))
  const plan = eventsOf(events, 'orchestrator_plan').at(-1)?.steps ?? []
  return {
    meta,
    plan: plan.map((s) => ({ id: s.id, role: s.role, label: s.label, dependsOn: s.dependsOn ?? [] })),
    calls: records.map((r) => {
      const start = r.timing.startedAt ?? r.timing.endedAt
      return {
        seq: r.seq, kind: r.kind, role: r.role, agentId: r.agentId, attempt: r.attempt,
        label: r.kind === 'tool' ? `tool ${r.name}` : r.model ?? '',
        start: start - t0, ms: r.timing.ms ?? Math.max(0, r.timing.endedAt - start),
        finish: r.kind === 'tool' ? (r.error ? 'rejected' : r.approved ? 'ok' : 'denied') : r.response?.finishReason ?? '',
        file: `${recordFile(r)}.md`, anchor: anchor(r), anomalous: flagged.has(callRef(r)),
      }
    }),
    anomalies: summary.anomalies,
    peak: peakConcurrency(records),
    files: (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort((a, b) => (a === 'run.md' ? -1 : b === 'run.md' ? 1 : a.localeCompare(b))),
  }
}

/** The run's UI events, newest first, one page at a time. */
export async function runEvents(dir: string, offset: number, limit: number): Promise<{ total: number; events: AgentEvent[] }> {
  const events = parseJsonl<AgentEvent>(await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8').catch(() => '')).reverse()
  return { total: events.length, events: events.slice(offset, offset + limit) }
}

// ── Verification (observability spec Phase 5) ────────────────────────────────

/**
 * Re-reads a finished run directory and lists every problem: a timeline row
 * without a record, a model call with an empty request or response, a markdown
 * link to a missing file or anchor, totals that do not reconcile, or a secret
 * anywhere in the tree. Empty = the log is complete and consistent.
 */
export async function verifyRunDir(dir: string, secrets: string[] = []): Promise<string[]> {
  const problems: string[] = []
  const { events, records } = await readRun(dir)
  const bySeq = new Map(records.map((r) => [r.seq, r]))
  const names = await fs.readdir(dir)
  const text = new Map<string, string>()
  for (const name of names) text.set(name, await fs.readFile(path.join(dir, name), 'utf8'))
  const runMd = text.get('run.md') ?? ''
  if (!runMd) problems.push('run.md is missing')

  const timeline = runMd.split('## Timeline')[1]?.split('\n## ')[0] ?? ''
  const rows = [...timeline.matchAll(/^\| (\d+) \|.*\[([^\]]+)\]\(([^)]+)\) \|$/gm)]
  if (!rows.length && records.length) problems.push('the timeline lists no calls')
  for (const [, seq] of rows) {
    const r = bySeq.get(Number(seq))
    if (!r) { problems.push(`timeline call ${seq}: no record`); continue }
    if (r.kind === 'model') {
      if (!r.request?.messages?.length) problems.push(`call ${seq}: empty request`)
      const said = r.response && (r.response.content || r.response.reasoning || r.response.toolCalls.length)
      if (!said && !r.error) problems.push(`call ${seq}: empty response and no error`)
    } else if (r.result == null && !r.error && !r.denied) problems.push(`tool call ${seq}: no result`)
  }
  if (rows.length !== records.length) problems.push(`timeline lists ${rows.length} calls, records hold ${records.length}`)

  for (const [name, body] of text) {
    if (!name.endsWith('.md')) continue
    for (const [, file, anchorId] of body.matchAll(/\]\(([^)\s#]+\.md)(?:#([^)\s]+))?\)/g)) {
      const linked = text.get(file)
      if (linked === undefined) problems.push(`${name}: link to missing ${file}`)
      else if (anchorId && !linked.includes(`<a id="${anchorId}"></a>`)) problems.push(`${name}: link to missing anchor ${file}#${anchorId}`)
    }
  }

  const done = events.find((e): e is Ev<'task_complete'> => e.type === 'task_complete')
  if (done) {
    const model = records.filter((r) => r.kind === 'model')
    const cost = model.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0)
    const tokens = model.reduce((s, r) => s + tokensOf(r), 0)
    if (Math.abs(cost - done.totalCostUsd) > RECONCILE_USD || tokens !== done.totalTokens) {
      problems.push(`totals do not reconcile: records ${tokens} tokens / ${cost}, run ${done.totalTokens} / ${done.totalCostUsd}`)
    }
  }

  for (const secret of secrets) {
    for (const [name, body] of text) if (secret && body.includes(secret)) problems.push(`${name}: contains a credential`)
  }
  return problems
}
