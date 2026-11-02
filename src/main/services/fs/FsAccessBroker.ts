// FsAccessBroker — the one place fs_request_access is decided (spec 2.2).
// Validates the requested folder with the path policy before any dialog,
// answers from memory when it can (already covered, already denied), and
// otherwise asks the person: one dialog per chat at a time, FIFO, 120 s.
// It never consults bypass-all: a person always approves folder access.
//
// Events: 'request' (FsAccessRequestEvent) and 'expired' (requestId) — index.ts
// forwards them to the renderer as FS_ACCESS_REQUEST / FS_ACCESS_EXPIRED.

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { describeAccess, type FsAccessLevel, type FsAccessRequestEvent, type FsAccessResponse } from '../../../shared/fsAccess'
import { resolveTarget, validateGrantRoot, checkAccess, type FsGrant, type FsPolicyDeps } from './pathPolicy'
import type { FsGrantStore } from './FsGrantStore'
import { FsToolError } from './FsToolService'

export type { FsAccessRequestEvent, FsAccessResponse }

export interface FsAccessTrace {
  chatId: string
  path: string
  requested: FsAccessLevel
  decision: 'deny' | 'chat' | 'always' | 'auto-denied' | 'no-answer' | 'already-granted' | 'refused'
  scope: 'chat' | 'always' | null
  granted?: FsAccessLevel
}

export interface FsAccessBrokerDeps {
  policyDeps: FsPolicyDeps
  grants: FsGrantStore
  effectiveGrants: (chatId: string) => FsGrant[]
  blockedNames: () => string[]
  /** "Always allow": save the root in Settings (askBeforeEdit true). */
  addPersistentRoot: (path: string, access: FsAccessLevel) => void
  observe?: (trace: FsAccessTrace) => void
  timeoutMs?: number
  newId?: () => string
}

const NO_ANSWER = 'No answer from the user.'
const READ_TOOLS = 'fs_list, fs_glob, fs_grep and fs_read'
const ALL_TOOLS = 'fs_list, fs_glob, fs_grep, fs_read, fs_edit and fs_write'

interface Pending {
  chatId: string
  path: string
  access: FsAccessLevel
  timer: ReturnType<typeof setTimeout>
  resolve: (text: string) => void
}

export class FsAccessBroker extends EventEmitter {
  private pending = new Map<string, Pending>()
  private queues = new Map<string, Promise<unknown>>()
  private epoch = 0
  private chatEpoch = new Map<string, number>()

  constructor(private readonly d: FsAccessBrokerDeps) {
    super()
  }

  private epochOf(chatId: string): number {
    return this.epoch + (this.chatEpoch.get(chatId) ?? 0)
  }

  private trace(t: FsAccessTrace): void {
    this.d.observe?.(t)
  }

  /** Resolves with the tool result for the model; rejects with FsToolError when the request itself is refused. */
  async request(chatId: string, args: Record<string, unknown>): Promise<string> {
    const access = args.access
    if (access !== 'read' && access !== 'write') throw new FsToolError('access must be "read" or "write".')
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (!reason) throw new FsToolError('Give a short reason; it is shown to the user.')
    const r = resolveTarget(args.path as string, this.d.policyDeps)
    if (!r.ok) throw new FsToolError(r.reason)
    const v = validateGrantRoot(r.real, this.d.policyDeps)
    if (!v.ok) throw new FsToolError(v.reason)

    const epoch = this.epochOf(chatId)
    const job = (this.queues.get(chatId) ?? Promise.resolve()).then(() => this.ask(chatId, r.real, access, reason.slice(0, 300), epoch))
    this.queues.set(chatId, job.catch(() => {}))
    return job
  }

  private ask(chatId: string, path: string, access: FsAccessLevel, reason: string, epoch: number): Promise<string> | string {
    if (this.epochOf(chatId) !== epoch) {
      this.trace({ chatId, path, requested: access, decision: 'no-answer', scope: null })
      return NO_ANSWER
    }
    // Re-checked when this request's turn comes: an earlier answer may cover it.
    const covered = checkAccess(path, access, this.d.effectiveGrants(chatId), this.d.blockedNames(), this.d.policyDeps)
    if (covered.ok) {
      this.trace({ chatId, path, requested: access, decision: 'already-granted', scope: null })
      return `${path} is already accessible (${describeAccess(covered.grant.access)}) through ${covered.grant.path}. Use the fs_ tools directly; no request is needed.`
    }
    const denial = this.d.grants.findDenial(chatId, path, access)
    if (denial) {
      this.trace({ chatId, path, requested: access, decision: 'auto-denied', scope: null })
      return denial.scope === 'all'
        ? `Access to ${path} was already denied in this chat. Do not request it again.`
        : `Write access to ${path} was declined in this chat; you have read-only access.`
    }

    const requestId = (this.d.newId ?? randomUUID)()
    const timeoutMs = this.d.timeoutMs ?? 120_000
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => this.noAnswer(requestId), timeoutMs)
      this.pending.set(requestId, { chatId, path, access, timer, resolve })
      this.emit('request', { requestId, chatId, path, access, reason, timeoutMs } satisfies FsAccessRequestEvent)
    })
  }

  private noAnswer(requestId: string): void {
    // Only called for a live entry: respond() clears its timer, cancel walks live ones.
    const p = this.pending.get(requestId)!
    clearTimeout(p.timer)
    this.pending.delete(requestId)
    this.emit('expired', requestId)
    this.trace({ chatId: p.chatId, path: p.path, requested: p.access, decision: 'no-answer', scope: null })
    p.resolve(NO_ANSWER)
  }

  respond(r: FsAccessResponse): void {
    const p = this.pending.get(r?.requestId)
    if (!p) return
    if (!['deny', 'chat', 'always'].includes(r.decision) || (r.access !== 'read' && r.access !== 'write')) return
    clearTimeout(p.timer)
    this.pending.delete(r.requestId)
    const base = { chatId: p.chatId, requested: p.access }

    if (r.decision === 'deny') {
      this.d.grants.recordDenial(p.chatId, p.path, 'all')
      this.trace({ ...base, path: p.path, decision: 'deny', scope: null })
      p.resolve(`Access to ${p.path} was denied by the user. Do not request it again in this chat.`)
      return
    }

    // The person may have picked a different folder: re-validate it here.
    let target = p.path
    if (typeof r.path === 'string' && r.path !== p.path) {
      const rr = resolveTarget(r.path, this.d.policyDeps)
      const v = rr.ok ? validateGrantRoot(rr.real, this.d.policyDeps) : rr
      if (!rr.ok || !v.ok) {
        this.trace({ ...base, path: r.path, decision: 'refused', scope: null })
        p.resolve(`The folder chosen in the dialog cannot be used: ${(v as { reason: string }).reason} Nothing was granted.`)
        return
      }
      target = rr.real
    }

    if (r.decision === 'always') this.d.addPersistentRoot(target, r.access)
    else this.d.grants.addGrant(p.chatId, target, r.access)
    const downgraded = p.access === 'write' && r.access === 'read'
    if (downgraded) this.d.grants.recordDenial(p.chatId, target, 'write')
    this.trace({ ...base, path: target, decision: r.decision, scope: r.decision, granted: r.access })
    p.resolve(
      `Access granted: ${target} (${describeAccess(r.access)}, ${r.decision === 'always' ? 'saved in Settings' : 'this chat only'}). ` +
        `You can now use ${r.access === 'write' ? ALL_TOOLS : READ_TOOLS} inside it.` +
        (downgraded ? ' Write access was declined; do not request it again in this chat.' : '')
    )
  }

  /** Chat aborted or deleted: pending and queued requests get "No answer from the user." */
  cancelChat(chatId: string): void {
    this.chatEpoch.set(chatId, (this.chatEpoch.get(chatId) ?? 0) + 1)
    for (const [id, p] of [...this.pending]) if (p.chatId === chatId) this.noAnswer(id)
  }

  cancelAll(): void {
    this.epoch++
    for (const id of [...this.pending.keys()]) this.noAnswer(id)
  }
}
