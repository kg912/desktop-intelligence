// Chat grants and denial memory for built-in file access (spec 2.1, 2.2).
// In memory only: cleared on restart and when a chat is deleted.

import type { FsAccessLevel } from '../../../shared/fsAccess'
import { isInside, mergeGrants, type FsGrant } from './pathPolicy'

interface ChatGrant {
  path: string
  access: FsAccessLevel
  addedAt: number
}
export type DenialScope = 'all' | 'write'

export class FsGrantStore {
  private grants = new Map<string, ChatGrant[]>()
  private denials = new Map<string, Array<{ path: string; scope: DenialScope }>>()
  private listeners = new Set<() => void>()

  constructor(private readonly now: () => number = Date.now) {}

  private changed(): void {
    for (const fn of this.listeners) fn()
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  addGrant(chatId: string, path: string, access: FsAccessLevel): void {
    const list = this.grants.get(chatId) ?? []
    const prev = list.find((g) => g.path === path)
    if (prev) {
      if (prev.access === 'write' || access === 'read') return
      prev.access = 'write'
    } else {
      list.push({ path, access, addedAt: this.now() })
      this.grants.set(chatId, list)
    }
    this.changed()
  }

  /** Chat grants always ask before edits. */
  getGrants(chatId: string): FsGrant[] {
    return (this.grants.get(chatId) ?? []).map((g) => ({ path: g.path, access: g.access, askBeforeEdit: true }))
  }

  listAll(): Array<{ chatId: string } & ChatGrant> {
    return [...this.grants].flatMap(([chatId, list]) => list.map((g) => ({ chatId, ...g })))
  }

  /** Every chat's grants merged — the worker's policy scope. */
  union(): FsGrant[] {
    return mergeGrants(...[...this.grants.keys()].map((id) => this.getGrants(id)))
  }

  revoke(chatId: string, path: string): boolean {
    const list = this.grants.get(chatId) ?? []
    const i = list.findIndex((g) => g.path === path)
    if (i === -1) return false
    list.splice(i, 1)
    if (list.length === 0) this.grants.delete(chatId)
    this.changed()
    return true
  }

  recordDenial(chatId: string, path: string, scope: DenialScope): void {
    const list = this.denials.get(chatId) ?? []
    list.push({ path, scope })
    this.denials.set(chatId, list)
  }

  /** A recorded denial covering `path` (or an ancestor) for this access, full denials first. */
  findDenial(chatId: string, path: string, access: FsAccessLevel): { path: string; scope: DenialScope } | null {
    const hits = (this.denials.get(chatId) ?? []).filter(
      (d) => isInside(d.path, path) && (d.scope === 'all' || access === 'write')
    )
    return hits.find((d) => d.scope === 'all') ?? hits[0] ?? null
  }

  clearChat(chatId: string): void {
    this.denials.delete(chatId)
    if (this.grants.delete(chatId)) this.changed()
  }
}
