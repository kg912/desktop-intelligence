// FsToolService — owns the sandboxed fs worker (spec 2.5) and applies the
// main-process layer of the path policy per chat before every call.
//
// One worker, lazily started, serial queue, per-call timeout (grep longer).
// A timeout or abort kills the worker; the next call starts a fresh one. The
// worker's policy is the union of every chat's grants; when that union (or the
// blocked-name list) changes, the next call restarts the worker with the new
// policy. Fail closed: no sandbox → no file access.

import { existsSync, mkdirSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { quote } from 'shell-quote'
import type { SandboxRunSpec } from '../sandbox/types'
import { memoryWatch, killProcessTree } from '../sandbox/ResourceGovernor'
import type { FsAccessSettings } from '../../../shared/fsAccess'
import { resolveTarget, checkAccess, mergeGrants, isInside, type FsGrant, type FsPolicyDeps } from './pathPolicy'
import type { FsGrantStore } from './FsGrantStore'
import type { FsReadLedger } from './FsReadLedger'
import type { FsOpResult } from './fsOps'

export type FsOp = 'read' | 'list' | 'glob' | 'grep' | 'edit' | 'write'

export const FS_UNAVAILABLE = 'File access is unavailable: the tool sandbox is not running.'
const FS_DISABLED = 'File access is turned off in Settings → File System Access.'
const CANCELLED = 'The operation was cancelled.'
const WORKER_RSS_MB = 512

/** A failure whose message is plain and safe to show the model and the user. */
export class FsToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FsToolError'
  }
}

export interface FsToolServiceOptions {
  spawn: (spec: SandboxRunSpec) => Promise<ChildProcessWithoutNullStreams>
  sandboxReady: () => boolean
  getSettings: () => FsAccessSettings
  grants: FsGrantStore
  ledger: FsReadLedger
  /** Main-process policy deps (real home, DI's userData, BASELINE_DENY_READ). */
  policyDeps: FsPolicyDeps
  userDataDir: string
  /** Arguments after the binary, and the code folders the binary + entry need to read. */
  worker?: { args: string[]; codeDirs: string[] }
  execPath?: string
  timeouts?: { default: number; grep: number; ready: number }
  /** Test only: the worker skips its own check, so Seatbelt is the only layer left. */
  testDisableWorkerCheck?: boolean
}

export interface FsCallOptions {
  chatId: string
  maxChars?: number | null
  signal?: AbortSignal
  /** Internal: compute the change without writing (edit approval). */
  dryRun?: boolean
}

interface WorkerReply {
  id?: number
  ready?: boolean
  ok?: boolean
  result?: FsOpResult
  error?: string
  kind?: 'op' | 'system'
}

interface Worker {
  proc: ChildProcessWithoutNullStreams
  key: string
  ready: Promise<void>
  dead: boolean
  pending: Map<number, (reply: WorkerReply | Error) => void>
  stopMemoryWatch: () => void
}

/**
 * Read access the worker's binary and entry need under home (measured in
 * Phase 0): the .app bundle holding the binary (dyld loads its framework),
 * the entry's folder, and the nearest package.json above it (Node reads it for
 * the module type). Paths outside home are readable anyway and are dropped.
 */
export function computeAppCodeDirs(execPath: string, entry: string, home: string, exists: (p: string) => boolean = existsSync): string[] {
  const parts = execPath.split(sep)
  const app = parts.findIndex((p) => p.endsWith('.app'))
  const bin = app === -1 ? execPath : parts.slice(0, app + 1).join(sep)
  let pkg: string[] = []
  for (let d = dirname(entry); ; d = dirname(d)) {
    if (exists(join(d, 'package.json'))) {
      pkg = [join(d, 'package.json')]
      break
    }
    if (dirname(d) === d) break
  }
  return [...new Set([bin, dirname(entry), ...pkg])].filter((p) => isInside(home, p))
}

function defaultWorker(home: string): { args: string[]; codeDirs: string[] } {
  // Bundled (dev/packaged): electron-vite emits the worker beside index.js.
  const built = join(__dirname, 'fsWorker.js')
  if (existsSync(built)) return { args: [built], codeDirs: computeAppCodeDirs(process.execPath, built, home) }
  // Unbundled (vitest): run the TypeScript source through tsx from the repo.
  const repo = resolve(__dirname, '../../../..')
  return { args: ['--import', 'tsx', join(__dirname, 'fsWorker.ts')], codeDirs: [repo] }
}

export class FsToolService {
  private worker: Worker | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private nextId = 1
  private readonly workerCmd: { args: string[]; codeDirs: string[] }
  private readonly timeouts: { default: number; grep: number; ready: number }

  constructor(private readonly o: FsToolServiceOptions) {
    this.workerCmd = o.worker ?? defaultWorker(o.policyDeps.homedir)
    this.timeouts = o.timeouts ?? { default: 15_000, grep: 30_000, ready: 15_000 }
  }

  isAvailable(): boolean {
    return this.o.getSettings().enabled && this.o.sandboxReady()
  }

  /** Persistent roots ∪ this chat's grants. */
  effectiveGrants(chatId: string): FsGrant[] {
    const roots = this.o.getSettings().roots.map((r) => ({ path: r.path, access: r.access, askBeforeEdit: r.askBeforeEdit }))
    return mergeGrants(roots, this.o.grants.getGrants(chatId))
  }

  private assertAvailable(): void {
    if (!this.o.getSettings().enabled) throw new FsToolError(FS_DISABLED)
    if (!this.o.sandboxReady()) throw new FsToolError(FS_UNAVAILABLE)
  }

  /**
   * Main-process policy check for `chatId`, then the worker. Records reads and
   * writes in the read ledger. Throws FsToolError with a plain message.
   */
  async run(op: FsOp, args: Record<string, unknown>, opts: FsCallOptions): Promise<FsOpResult> {
    this.assertAvailable()
    if (opts.signal?.aborted) throw new FsToolError(CANCELLED)
    const level = op === 'edit' || op === 'write' ? 'write' : 'read'
    const deps = this.o.policyDeps
    const r = resolveTarget(args.path as string, deps)
    if (!r.ok) throw new FsToolError(r.reason)
    const c = checkAccess(r.real, level, this.effectiveGrants(opts.chatId), this.o.getSettings().blockedNames, deps)
    if (!c.ok) throw new FsToolError(c.reason)

    // Only known model arguments pass; ledger hash, dryRun and maxChars are ours.
    const { expectedSha256: _h, dryRun: _d, maxChars: _m, ...clean } = args
    const wargs: Record<string, unknown> = { ...clean, path: r.real }
    if (level === 'write') wargs.expectedSha256 = this.o.ledger.get(opts.chatId, r.real)?.sha256
    if (opts.dryRun) wargs.dryRun = true
    if (op === 'read' && opts.maxChars) wargs.maxChars = opts.maxChars

    const result = await this.request(op, wargs, opts.signal)
    if (result.ledger && !opts.dryRun) this.o.ledger.record(opts.chatId, r.real, result.ledger)
    return result
  }

  /**
   * Send a request straight to the worker, skipping the main-process policy.
   * Used by the integration test to prove the worker's own check and Seatbelt.
   */
  rawRequest(op: FsOp, args: Record<string, unknown>): Promise<FsOpResult> {
    return this.request(op, args)
  }

  private request(op: FsOp, args: Record<string, unknown>, signal?: AbortSignal): Promise<FsOpResult> {
    const timeoutMs = op === 'grep' ? this.timeouts.grep : this.timeouts.default
    const job = this.chain.then(() => this.exec(op, args, timeoutMs, signal))
    this.chain = job.catch(() => {})
    return job
  }

  private async exec(op: FsOp, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<FsOpResult> {
    if (signal?.aborted) throw new FsToolError(CANCELLED)
    const w = await this.ensureWorker()
    if (signal?.aborted) throw new FsToolError(CANCELLED)
    return new Promise<FsOpResult>((resolvePromise, reject) => {
      const id = this.nextId++
      const finish = (fn: () => void): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        w.pending.delete(id)
        fn()
      }
      const timer = setTimeout(() => {
        finish(() => reject(new FsToolError('The operation timed out.')))
        this.kill(w)
      }, timeoutMs)
      const onAbort = (): void => {
        finish(() => reject(new FsToolError(CANCELLED)))
        this.kill(w)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      w.pending.set(id, (reply) =>
        finish(() => {
          if (reply instanceof Error) reject(reply)
          else if (reply.ok && reply.result) resolvePromise(reply.result)
          else if (reply.kind === 'op') reject(new FsToolError(reply.error ?? 'The file operation failed.'))
          else reject(new FsToolError(`The file operation failed: ${reply.error ?? 'unknown error'}`))
        })
      )
      w.proc.stdin.write(JSON.stringify({ id, op, args }) + '\n')
    })
  }

  private policy(): Record<string, unknown> {
    const s = this.o.getSettings()
    const roots = s.roots.map((r) => ({ path: r.path, access: r.access, askBeforeEdit: r.askBeforeEdit }))
    const d = this.o.policyDeps
    return {
      grants: mergeGrants(roots, this.o.grants.union()),
      blockedNames: s.blockedNames,
      homedir: d.homedir,
      userDataDir: d.userDataDir,
      credentialEntries: [...d.credentialEntries],
      ...(this.o.testDisableWorkerCheck ? { testDisableOwnCheck: true } : {}),
    }
  }

  private kill(w: Worker): void {
    if (this.worker === w) this.worker = null
    w.dead = true
    w.stopMemoryWatch()
    // The spawn is a shell wrapper; kill its whole tree (a worker stuck in a
    // runaway regex never sees stdin close).
    if (w.proc.pid) void killProcessTree(w.proc.pid)
    else w.proc.kill('SIGKILL')
  }

  private async ensureWorker(): Promise<Worker> {
    const policy = this.policy()
    const key = JSON.stringify(policy)
    if (this.worker && this.worker.key === key && !this.worker.dead) {
      await this.worker.ready
      return this.worker
    }
    if (this.worker) this.kill(this.worker)

    const grants = policy.grants as FsGrant[]
    const workspaceDir = join(this.o.userDataDir, 'sandboxes', 'fs-worker')
    mkdirSync(workspaceDir, { recursive: true })
    const spec: SandboxRunSpec = {
      workspaceDir,
      command: quote([this.o.execPath ?? process.execPath, ...this.workerCmd.args]),
      env: { ELECTRON_RUN_AS_NODE: '1', DI_FS_POLICY: key, TMPDIR: workspaceDir },
      executionProfile: 'lightweight',
      allowedDomains: [],
      denyRead: [this.o.policyDeps.homedir],
      allowRead: [...new Set([...grants.map((g) => g.path), ...this.workerCmd.codeDirs, workspaceDir])],
      allowWrite: grants.filter((g) => g.access === 'write').map((g) => g.path),
      timeoutMs: 0,
      maxRssMb: WORKER_RSS_MB,
      callerLabel: 'fs-worker',
    }
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = await this.o.spawn(spec)
    } catch (err) {
      throw new FsToolError(`The file worker could not start: ${(err as Error).message}`)
    }

    let stderr = ''
    let buffer = ''
    let readyResolve!: () => void
    let readyReject!: (e: Error) => void
    const w: Worker = {
      proc,
      key,
      dead: false,
      pending: new Map(),
      ready: new Promise<void>((res, rej) => {
        readyResolve = res
        readyReject = rej
      }),
      stopMemoryWatch: proc.pid ? memoryWatch(proc.pid, WORKER_RSS_MB, () => this.kill(w)) : () => {},
    }
    w.ready.catch(() => {})
    this.worker = w

    const readyTimer = setTimeout(() => {
      readyReject(new FsToolError(`The file worker did not start${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : '.'}`))
      this.kill(w)
    }, this.timeouts.ready)

    proc.stdout.on('data', (d: Buffer) => {
      buffer += d.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg: WorkerReply
        try {
          msg = JSON.parse(line) as WorkerReply
        } catch {
          continue
        }
        if (msg.ready) {
          clearTimeout(readyTimer)
          readyResolve()
        } else if (typeof msg.id === 'number') w.pending.get(msg.id)?.(msg)
      }
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000)
    })
    proc.once('exit', () => {
      clearTimeout(readyTimer)
      const err = new FsToolError('The file worker stopped unexpectedly. Try again.')
      readyReject(new FsToolError(`The file worker did not start${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : '.'}`))
      for (const settle of [...w.pending.values()]) settle(err)
      if (this.worker === w) this.worker = null
      w.dead = true
      w.stopMemoryWatch()
    })
    proc.stdin.on('error', () => {}) // EPIPE after a kill is expected

    await w.ready
    return w
  }

  async shutdown(): Promise<void> {
    if (this.worker) this.kill(this.worker)
    this.chain = Promise.resolve()
  }
}
