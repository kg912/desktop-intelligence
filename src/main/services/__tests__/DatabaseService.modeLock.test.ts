/**
 * Mode lock (regular vs agent chats never cross over) — claimChatMode against
 * an in-memory DB with the production chats/chat_messages columns. This is the
 * main-process guard behind CHAT_SEND ('single') and MULTI_AGENT_START ('multi-agent').
 */
import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { _resetForTests } from '../rag/sqliteVecLoader'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/test-mode-lock') } }))
vi.mock('../PlotStore', () => ({ deletePlotsForChat: vi.fn() }))
_resetForTests()

import { applyMultiAgentMigration, claimChatMode, MODE_LOCK_ERROR } from '../DatabaseService'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Chat', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
  `)
  applyMultiAgentMigration(db)
  return db
}

function chat(db: Database.Database, id: string, mode: 'single' | 'multi-agent', messages: number): void {
  db.prepare('INSERT INTO chats (id, created_at, updated_at, mode) VALUES (?, 1, 1, ?)').run(id, mode)
  for (let i = 0; i < messages; i++) {
    db.prepare("INSERT INTO chat_messages VALUES (?, ?, 'user', 'hi', ?)").run(`${id}-${i}`, id, i)
  }
}

const modeOf = (db: Database.Database, id: string): string =>
  (db.prepare('SELECT mode FROM chats WHERE id = ?').get(id) as { mode: string }).mode

describe('claimChatMode', () => {
  it('rejects MULTI_AGENT_START on a regular chat with messages, mode unchanged', () => {
    const db = makeDb()
    chat(db, 'r', 'single', 2)
    expect(claimChatMode('r', 'multi-agent', db)).toBe('This chat is a regular chat. Start a new chat to use agents.')
    expect(modeOf(db, 'r')).toBe('single')
  })

  it('rejects a single-chat send on an agent chat, mode unchanged', () => {
    const db = makeDb()
    chat(db, 'a', 'multi-agent', 1)
    expect(claimChatMode('a', 'single', db)).toBe('Agent chats stay in agent mode.')
    expect(modeOf(db, 'a')).toBe('multi-agent')
  })

  it('allows the matching mode', () => {
    const db = makeDb()
    chat(db, 'r', 'single', 3)
    chat(db, 'a', 'multi-agent', 3)
    expect(claimChatMode('r', 'single', db)).toBeNull()
    expect(claimChatMode('a', 'multi-agent', db)).toBeNull()
  })

  it('an empty chat takes the requested mode, which then locks', () => {
    const db = makeDb()
    chat(db, 'e', 'single', 0)
    expect(claimChatMode('e', 'multi-agent', db)).toBeNull()
    expect(modeOf(db, 'e')).toBe('multi-agent')
    db.prepare("INSERT INTO chat_messages VALUES ('m', 'e', 'user', 'go', 1)").run()
    expect(claimChatMode('e', 'single', db)).toBe(MODE_LOCK_ERROR.single)
  })

  it('an unknown chat id is not refused (the send creates it)', () => {
    expect(claimChatMode('missing', 'single', makeDb())).toBeNull()
  })
})
