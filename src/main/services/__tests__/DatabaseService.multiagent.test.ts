/**
 * Multi-Agent Phase 1 — applyMultiAgentMigration unit tests.
 *
 * Tests applyMultiAgentMigration() in isolation against an in-memory DB.
 * getDB() is deliberately NOT called — this avoids Electron/native-module
 * bootstrap entirely. Only the exported migration helper is exercised.
 */

import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { _resetForTests } from '../rag/sqliteVecLoader'

// ── Mock electron so the DatabaseService module resolves ─────────────────────

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((_name: string) => '/tmp/test-multiagent'),
  },
}))

// Mock PlotStore (dynamically required inside deleteChatById — not called here
// but the dynamic require still resolves during module initialisation on some
// Node versions, so mock it to be safe).
vi.mock('../PlotStore', () => ({ deletePlotsForChat: vi.fn() }))

// Reset sqlite-vec loader state before DatabaseService module loads.
_resetForTests()

// ── Import the function under test AFTER mocks are in place ─────────────────

import { applyMultiAgentMigration } from '../DatabaseService'

// ── Helper: minimal chats table matching production base schema ──────────────

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE chats (
      id         TEXT    PRIMARY KEY,
      title      TEXT    NOT NULL DEFAULT 'New Chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  return db
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('applyMultiAgentMigration', () => {

  describe('columns added', () => {
    it('adds mode column to chats', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      expect(columnNames(db, 'chats')).toContain('mode')
    })

    it('adds run_status column to chats', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      expect(columnNames(db, 'chats')).toContain('run_status')
    })

    it('adds agent_graph column to chats', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      expect(columnNames(db, 'chats')).toContain('agent_graph')
    })

    it('adds execution_trace column to chats', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      expect(columnNames(db, 'chats')).toContain('execution_trace')
    })
  })

  describe('backfill of pre-existing rows', () => {
    it('pre-existing row gets mode = "single" after migration', () => {
      const db = makeDb()
      db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('c-pre', 'Old Chat', 1000, 2000)
      applyMultiAgentMigration(db)
      const row = db.prepare('SELECT mode FROM chats WHERE id = ?').get('c-pre') as { mode: string }
      expect(row.mode).toBe('single')
    })

    it('pre-existing row gets run_status = "idle" after migration', () => {
      const db = makeDb()
      db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('c-pre', 'Old Chat', 1000, 2000)
      applyMultiAgentMigration(db)
      const row = db.prepare('SELECT run_status FROM chats WHERE id = ?').get('c-pre') as { run_status: string }
      expect(row.run_status).toBe('idle')
    })

    it('pre-existing row gets agent_graph = NULL after migration', () => {
      const db = makeDb()
      db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('c-pre', 'Old Chat', 1000, 2000)
      applyMultiAgentMigration(db)
      const row = db.prepare('SELECT agent_graph FROM chats WHERE id = ?').get('c-pre') as { agent_graph: string | null }
      expect(row.agent_graph).toBeNull()
    })

    it('pre-existing row gets execution_trace = NULL after migration', () => {
      const db = makeDb()
      db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('c-pre', 'Old Chat', 1000, 2000)
      applyMultiAgentMigration(db)
      const row = db.prepare('SELECT execution_trace FROM chats WHERE id = ?').get('c-pre') as { execution_trace: string | null }
      expect(row.execution_trace).toBeNull()
    })
  })

  describe('defaults on new rows inserted after migration', () => {
    it('new row without specifying mode gets mode = "single"', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('c-new', 'New Chat', 3000, 4000)
      const row = db.prepare('SELECT mode FROM chats WHERE id = ?').get('c-new') as { mode: string }
      expect(row.mode).toBe('single')
    })

    it('new row without specifying run_status gets run_status = "idle"', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('c-new', 'New Chat', 3000, 4000)
      const row = db.prepare('SELECT run_status FROM chats WHERE id = ?').get('c-new') as { run_status: string }
      expect(row.run_status).toBe('idle')
    })

    it('new row without specifying agent_graph gets agent_graph = NULL', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('c-new', 'New Chat', 3000, 4000)
      const row = db.prepare('SELECT agent_graph FROM chats WHERE id = ?').get('c-new') as { agent_graph: string | null }
      expect(row.agent_graph).toBeNull()
    })

    it('new row without specifying execution_trace gets execution_trace = NULL', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('c-new', 'New Chat', 3000, 4000)
      const row = db.prepare('SELECT execution_trace FROM chats WHERE id = ?').get('c-new') as { execution_trace: string | null }
      expect(row.execution_trace).toBeNull()
    })
  })

  describe('idempotency — re-run on already-migrated DB', () => {
    it('calling applyMultiAgentMigration twice does not throw', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      expect(() => applyMultiAgentMigration(db)).not.toThrow()
    })

    it('each of the four columns appears exactly once after two runs', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      applyMultiAgentMigration(db)
      const cols = columnNames(db, 'chats')
      expect(cols.filter(c => c === 'mode').length).toBe(1)
      expect(cols.filter(c => c === 'run_status').length).toBe(1)
      expect(cols.filter(c => c === 'agent_graph').length).toBe(1)
      expect(cols.filter(c => c === 'execution_trace').length).toBe(1)
    })

    it('SELECT on all four columns still succeeds after two runs', () => {
      const db = makeDb()
      applyMultiAgentMigration(db)
      applyMultiAgentMigration(db)
      expect(() =>
        db.prepare('SELECT mode, run_status, agent_graph, execution_trace FROM chats').all()
      ).not.toThrow()
    })
  })

  describe('idempotency — chats table already has all four columns', () => {
    it('does not throw when all four columns are already present', () => {
      const db = new Database(':memory:')
      db.exec(`
        CREATE TABLE chats (
          id              TEXT    PRIMARY KEY,
          title           TEXT    NOT NULL DEFAULT 'New Chat',
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          mode            TEXT    NOT NULL DEFAULT 'single',
          run_status      TEXT    NOT NULL DEFAULT 'idle',
          agent_graph     TEXT,
          execution_trace TEXT
        )
      `)
      expect(() => applyMultiAgentMigration(db)).not.toThrow()
    })

    it('columns still queryable after no-op migration on pre-migrated DB', () => {
      const db = new Database(':memory:')
      db.exec(`
        CREATE TABLE chats (
          id              TEXT    PRIMARY KEY,
          title           TEXT    NOT NULL DEFAULT 'New Chat',
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          mode            TEXT    NOT NULL DEFAULT 'single',
          run_status      TEXT    NOT NULL DEFAULT 'idle',
          agent_graph     TEXT,
          execution_trace TEXT
        )
      `)
      applyMultiAgentMigration(db)
      // Should be able to insert and read back with correct defaults
      db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('c-check', 'Test', 1, 2)
      const row = db.prepare('SELECT mode, run_status, agent_graph, execution_trace FROM chats WHERE id = ?')
        .get('c-check') as { mode: string; run_status: string; agent_graph: string | null; execution_trace: string | null }
      expect(row.mode).toBe('single')
      expect(row.run_status).toBe('idle')
      expect(row.agent_graph).toBeNull()
      expect(row.execution_trace).toBeNull()
    })
  })
})

// ── Run persistence (begin / saveMultiAgentTrace / getMultiAgentRun) ─────────

import { beginMultiAgentRun, getMultiAgentRun, saveMultiAgentTrace } from '../DatabaseService'
import type { AgentEvent, AgentStep } from '../../../shared/types'

describe('multi-agent run persistence', () => {
  const steps: AgentStep[] = [{ id: '1.1', label: 'x', stage: 'worker', role: 'R', model: 'm', phase: 1 }]
  const trace: AgentEvent[] = [
    { runId: 'r', seq: 1, ts: 1, type: 'orchestrator_plan', steps },
    { runId: 'r', seq: 2, ts: 2, type: 'task_complete', finalOutput: 'done', totalCostUsd: 0.01, totalTokens: 5 },
  ]
  function seeded(): Database.Database {
    const db = makeDb()
    applyMultiAgentMigration(db)
    db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('chat-1', 't', 1, 1)
    return db
  }

  it('begin marks the chat multi-agent and running with an empty trace', () => {
    const db = seeded()
    beginMultiAgentRun('chat-1', [], db)
    expect(getMultiAgentRun('chat-1', db)).toEqual({ mode: 'multi-agent', runStatus: 'running', agentGraph: [], executionTrace: [] })
  })

  it('saves the whole trace, status and plan in one statement, and keeps the plan when omitted', () => {
    const db = seeded()
    beginMultiAgentRun('chat-1', [], db)
    saveMultiAgentTrace('chat-1', trace.slice(0, 1), 'running', steps, db)
    saveMultiAgentTrace('chat-1', trace, 'completed', undefined, db)
    expect(getMultiAgentRun('chat-1', db)).toEqual({ mode: 'multi-agent', runStatus: 'completed', agentGraph: steps, executionTrace: trace })
  })

  it('persists and replays a 6,000-event trace with reasoning and tool events intact', () => {
    const db = seeded()
    beginMultiAgentRun('chat-1', [], db)
    const big: AgentEvent[] = [trace[0]]
    for (let seq = 2; seq <= 6_000; seq++) {
      big.push(
        seq % 3 === 0
          ? { runId: 'r', seq, ts: seq, type: 'tool_done', agentId: '1.1', attempt: 0, callId: `c${seq}`, ok: true, durationMs: 5, resultPreview: 'x'.repeat(1_200), resultChars: 4_000 }
          : { runId: 'r', seq, ts: seq, type: 'agent_reasoning', agentId: '1.1', attempt: 0, token: `thought ${seq} — “ünïcode” ` }
      )
    }
    saveMultiAgentTrace('chat-1', big, 'completed', steps, db)
    const replay = getMultiAgentRun('chat-1', db)!.executionTrace
    expect(replay).toHaveLength(6_000)
    expect(replay).toEqual(big)
  })

  it('returns null for an unknown chat and survives a corrupted trace', () => {
    const db = seeded()
    expect(getMultiAgentRun('nope', db)).toBeNull()
    db.prepare(`UPDATE chats SET mode = 'multi-agent', execution_trace = '{not json' WHERE id = 'chat-1'`).run()
    expect(getMultiAgentRun('chat-1', db)).toMatchObject({ mode: 'multi-agent', executionTrace: [] })
  })
})

// ── Run history (multi_agent_runs) ───────────────────────────────────────────

import { applyMultiAgentRunsMigration } from '../DatabaseService'

describe('multi-agent run history', () => {
  const plan = (runId: string, ts: number): AgentEvent =>
    ({ runId, seq: 1, ts, type: 'orchestrator_plan', steps: [{ id: '1.1', label: runId, stage: 'worker', role: 'R', model: 'm', phase: 1 }] })
  const done = (runId: string, ts: number, finalOutput: string): AgentEvent =>
    ({ runId, seq: 2, ts, type: 'task_complete', finalOutput, totalCostUsd: 0.01, totalTokens: 5 })

  function migrated(): Database.Database {
    const db = makeDb()
    applyMultiAgentMigration(db)
    db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('chat-1', 't', 1, 1)
    return db
  }

  it('backfills each existing multi-agent chat as exactly one run, once, and skips single chats', () => {
    const db = makeDb()
    applyMultiAgentMigration(db)
    const ins = db.prepare(`INSERT INTO chats (id, title, created_at, updated_at, mode, run_status, agent_graph, execution_trace)
      VALUES (?, 't', ?, ?, ?, ?, ?, ?)`)
    const legacy = [plan('old-run', 5000), done('old-run', 6000, 'old answer')]
    ins.run('ma', 100, 200, 'multi-agent', 'completed', JSON.stringify([]), JSON.stringify(legacy))
    ins.run('ma-broken', 300, 400, 'multi-agent', 'failed', null, '{not json')
    ins.run('single', 1, 1, 'single', 'idle', null, null)
    applyMultiAgentRunsMigration(db)
    applyMultiAgentRunsMigration(db) // version-gated: second call is a no-op

    expect(db.pragma('user_version', { simple: true })).toBe(3)
    expect(db.prepare('SELECT run_id, chat_id, started_at, ended_at, status, task, config_json FROM multi_agent_runs ORDER BY chat_id').all()).toEqual([
      { run_id: 'old-run', chat_id: 'ma', started_at: 5000, ended_at: 200, status: 'completed', task: null, config_json: null },
      { run_id: 'legacy-ma-broken', chat_id: 'ma-broken', started_at: 300, ended_at: 400, status: 'failed', task: null, config_json: null },
    ])
    expect(getMultiAgentRun('ma', db)).toEqual({
      mode: 'multi-agent', runStatus: 'completed', agentGraph: [], executionTrace: legacy, runId: 'old-run', runIds: ['old-run'],
    })
  })

  it('keeps two runs in one chat, both retrievable by id, latest by default', () => {
    const db = migrated()
    beginMultiAgentRun('chat-1', [], db, { runId: 'run-a', task: 'first task', config: { budgetCapUsd: 0.5 } })
    saveMultiAgentTrace('chat-1', [plan('run-a', 10), done('run-a', 11, 'A')], 'completed', undefined, db)
    beginMultiAgentRun('chat-1', [], db, { runId: 'run-b', task: 'second task', config: { budgetCapUsd: 0.7 } })
    saveMultiAgentTrace('chat-1', [plan('run-b', 20), done('run-b', 21, 'B')], 'failed', undefined, db)

    expect(getMultiAgentRun('chat-1', db, 'run-a')).toEqual({
      mode: 'multi-agent', runStatus: 'completed', agentGraph: [], executionTrace: [plan('run-a', 10), done('run-a', 11, 'A')],
      runId: 'run-a', runIds: ['run-a', 'run-b'], task: 'first task',
    })
    const latest = {
      mode: 'multi-agent', runStatus: 'failed', agentGraph: [], executionTrace: [plan('run-b', 20), done('run-b', 21, 'B')],
      runId: 'run-b', runIds: ['run-a', 'run-b'], task: 'second task',
    }
    expect(getMultiAgentRun('chat-1', db, 'run-b')).toEqual(latest)
    expect(getMultiAgentRun('chat-1', db)).toEqual(latest)
    expect(getMultiAgentRun('chat-1', db, 'no-such-run')).toBeNull()
    expect(db.prepare('SELECT config_json FROM multi_agent_runs ORDER BY started_at, rowid').all())
      .toEqual([{ config_json: '{"budgetCapUsd":0.5}' }, { config_json: '{"budgetCapUsd":0.7}' }])
  })

  it('chats.agent_graph / execution_trace / run_status still hold the latest run only, as before', () => {
    const db = migrated()
    beginMultiAgentRun('chat-1', [], db, { runId: 'run-a', task: 'a', config: {} })
    saveMultiAgentTrace('chat-1', [plan('run-a', 10)], 'completed', undefined, db)
    beginMultiAgentRun('chat-1', [], db, { runId: 'run-b', task: 'b', config: {} })
    expect(db.prepare('SELECT mode, run_status, agent_graph, execution_trace FROM chats WHERE id = ?').get('chat-1'))
      .toEqual({ mode: 'multi-agent', run_status: 'running', agent_graph: '[]', execution_trace: '[]' })
    saveMultiAgentTrace('chat-1', [plan('run-b', 20)], 'completed', undefined, db)
    expect(db.prepare('SELECT run_status, execution_trace FROM chats WHERE id = ?').get('chat-1'))
      .toEqual({ run_status: 'completed', execution_trace: JSON.stringify([plan('run-b', 20)]) })
    // ...while the first run is untouched in history.
    expect(db.prepare('SELECT execution_trace FROM multi_agent_runs WHERE run_id = ?').get('run-a'))
      .toEqual({ execution_trace: JSON.stringify([plan('run-a', 10)]) })
  })

  it('deleting the chat deletes its runs', () => {
    const db = migrated()
    db.pragma('foreign_keys = ON')
    beginMultiAgentRun('chat-1', [], db, { runId: 'run-a', task: 'a', config: {} })
    db.prepare('DELETE FROM chats WHERE id = ?').run('chat-1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM multi_agent_runs').get()).toEqual({ n: 0 })
  })
})
