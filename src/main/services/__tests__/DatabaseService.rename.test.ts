/**
 * DatabaseService.rename.test.ts
 * Tests for the renameChatById function.
 * Uses a real temporary SQLite DB (same pattern as DatabaseService.rag.test.ts).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { join }        from 'path'
import { tmpdir }      from 'os'
import { _resetForTests } from '../rag/sqliteVecLoader'

const TEST_DIR = mkdtempSync(join(tmpdir(), 'di-rename-test-'))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((_name: string) => TEST_DIR),
  },
}))

vi.mock('../PlotStore', () => ({ deletePlotsForChat: vi.fn() }))

_resetForTests()

import {
  createChat,
  renameChatById,
  getAllChats,
} from '../DatabaseService'

describe('renameChatById', () => {
  let chatId: string

  beforeAll(() => {
    const chat = createChat('test-rename-id', 'Original Title')
    chatId = chat.id
  })

  it('updates the title in the database', () => {
    renameChatById(chatId, 'Updated Title')
    const chats = getAllChats()
    const found = chats.find((c) => c.id === chatId)
    expect(found?.title).toBe('Updated Title')
  })

  it('trims whitespace from the new title before writing', () => {
    renameChatById(chatId, '  Trimmed  ')
    const chats = getAllChats()
    const found = chats.find((c) => c.id === chatId)
    expect(found?.title).toBe('Trimmed')
  })

  it('does not update when the new title is whitespace-only', () => {
    renameChatById(chatId, 'Before Blank Attempt')
    renameChatById(chatId, '   ')
    const chats = getAllChats()
    const found = chats.find((c) => c.id === chatId)
    expect(found?.title).toBe('Before Blank Attempt')
  })

  it('does not update when the new title is an empty string', () => {
    renameChatById(chatId, 'Before Empty Attempt')
    renameChatById(chatId, '')
    const chats = getAllChats()
    const found = chats.find((c) => c.id === chatId)
    expect(found?.title).toBe('Before Empty Attempt')
  })

  it('is a no-op and does not throw for a nonexistent chat ID', () => {
    expect(() => renameChatById('nonexistent-id', 'Ghost Title')).not.toThrow()
  })

  it('does not affect other chats in the database', () => {
    const other = createChat('other-chat-id', 'Other Chat')
    renameChatById(chatId, 'Renamed Again')
    const chats = getAllChats()
    const otherFound = chats.find((c) => c.id === other.id)
    expect(otherFound?.title).toBe('Other Chat')
  })

  it('persists the final title across multiple sequential renames', () => {
    renameChatById(chatId, 'First')
    renameChatById(chatId, 'Second')
    renameChatById(chatId, 'Third')
    const chats = getAllChats()
    const found = chats.find((c) => c.id === chatId)
    expect(found?.title).toBe('Third')
  })
})
