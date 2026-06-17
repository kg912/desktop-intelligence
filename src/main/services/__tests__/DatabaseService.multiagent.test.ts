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
