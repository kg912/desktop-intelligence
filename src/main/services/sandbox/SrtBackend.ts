// SrtBackend — the active, default sandbox backend (Phase 0).
//
// Uses @anthropic-ai/sandbox-runtime's SandboxManager to wrap commands with
// macOS Seatbelt (sandbox-exec) filesystem and network restrictions.
//
// Key API details (verified against @anthropic-ai/sandbox-runtime 0.0.65):
//   - SandboxManager.initialize(config) — called once at startup with a base config
//   - SandboxManager.wrapWithSandbox(command, binShell?, customConfig?) — wraps a shell
//     command string, returns the sandboxed command string
//   - SandboxManager.reset() — optional cleanup
//
// The config schema is FLAT (spec section 19):
//   { network: { allowedDomains, deniedDomains }, filesystem: { denyRead, allowWrite, denyWrite }, ... }
// NOT nested under a "sandbox" key.
//
// NETWORK POLICY ISOLATION (2026-09-30, supersedes the 2026-07-13 note in
// progress.md row 303): sandbox-runtime keeps ONE live allowlist per module
// instance, read per-request by its proxy. The 07-13 fix — updateConfig()
// immediately before every wrap — made each spawn's allowlist apply to EVERY
// already-running sandboxed process (last writer wins): a no-network MCP
// server starting cut the Python worker's yfinance hosts, and a server
// spawned after another inherited its domains. Each distinct allowlist now
// gets its own SandboxManager in a forked policy host (policyHost.ts), whose
// proxy enforces exactly that list; Seatbelt only lets a wrapped process
// reach its own host's proxy port. Hosts are leased per process and stop
// after HOST_IDLE_MS with no leases (the deny-all host is kept warm).
//
// ── Violation store investigation (Phase 2, 2026-07-13, spec section 11/16) ──
// Investigated (not guessed — read node_modules/@anthropic-ai/sandbox-runtime/
// dist/sandbox/sandbox-manager.js and sandbox-violation-store.js directly,
// then verified live with 4 separate diagnostic runs):
//
// (Items 1–3 now run inside each policy host — see policyHost.ts — which
// forwards raw violations here for parsing and attribution.)
//
// 1. SandboxManager.getSandboxViolationStore() requires enableLogMonitor:true
//    as initialize()'s 3rd positional arg. It defaults to false. With it
//    false (the case before this change), sandbox-manager.js's initialize()
//    never calls startMacOSSandboxLogMonitor(), so the store's addViolation()
//    is never invoked — getSandboxViolationStore() returns a real, live
//    SandboxViolationStore object either way, but it stays permanently empty
//    unless enableLogMonitor was true at initialize()-time. This is why
//    initialize() below now passes `true`.
//
// 2. SandboxViolationStore is EVENT-BASED, not poll-based: it exposes
//    subscribe(listener) which registers a callback fired on every
//    addViolation(). It is NOT incremental, though — each notification
//    delivers the FULL current violations array (capped at 100, oldest
//    trimmed), not just the new entry ("Always notify with all violations
//    so listeners can track the full count" — sandbox-violation-store.js).
//    subscribe() also fires once immediately, synchronously, with whatever
//    is already in the store. Consumers must track a cursor themselves;
//    getTotalCount() (monotonically increasing, never reset by trimming or
//    clear()) is used below for that — see subscribeToViolations().
//
// 3. SandboxViolationEvent's shape is `{ line: string, command?: string,
//    encodedCommand?: string, timestamp: Date }` — NOT structured with
//    path/domain/kind fields. `line` is a raw macOS unified-log fragment
//    (format: "<proc>(<pid>) deny(<n>) <operation> <resource...>", the part
//    after "Sandbox: " in the kernel log) that must be parsed — see
//    parseViolationLine() below. `command` is the DECODED pre-wrap command
//    string (i.e. spec.command, not the sandbox-exec-wrapped one) — this is
//    the only thing that reliably correlates a violation back to which
//    SrtBackend call produced it, which is why commandLabels below is keyed
//    on spec.command rather than anything wrap-time-generated.
//
// 4. TIMING QUIRK, narrowed down live (4 diagnostic spikes, then confirmed
//    against the real PythonWorkerService persistent worker): a FRESH
//    one-shot spawn (SrtBackend.run(), and every standalone diagnostic
//    script tried) reliably loses an explicit path-scoped file-read-data
//    denial's log line — only the generic default-deny fallback that fires
//    once at every process launch (a `sysctl-read kern.iossupportversion`
//    denial from posix_spawn's own startup checks) gets captured, across
//    dozens of attempts with shell- vs. argv-wrapped spawn, short vs. long
//    command paths, and repeated denied-read attempts within one process.
//    The explicit `(deny file-read* (subpath ...) (with message ...))`
//    rule's own log line never appeared for a FRESH spawn.
//
//    But a denied read performed by an ALREADY-RUNNING persistent process
//    (i.e. spawnPersistent()'s use case — no competing process-launch noise
//    at that moment) DOES reliably surface the real, explicit,
//    credential-path-classified violation — confirmed via
//    PythonWorkerService's actual persistent worker in
//    PythonWorkerService.test.ts's real (non-mocked) integration test.
//    Since spawnPersistent() is how both PythonWorkerService and every MCP
//    stdio server actually run in production (spawn once, communicate over
//    stdin/stdout for the process's whole lifetime), this is the case that
//    matters in practice, and it works. run()'s one-shot fallback path
//    (fallbackRender() in PythonWorkerService) is the one place a violation
//    could still be missed due to this timing quirk — noted as a known gap,
//    not fixable from this codebase (looks like a macOS unified-logging
//    buffering/ordering behavior in @anthropic-ai/sandbox-runtime@0.0.65's
//    log-stream consumer, not something under our control).
//
// ── ESM-only dependency (found 2026-07-14, real .dmg launch crash) ───────────
// @anthropic-ai/sandbox-runtime's package.json has "type":"module" and no
// CJS `exports` fallback (confirmed by reading node_modules/@anthropic-ai/
// sandbox-runtime/package.json directly — no `exports` field at all, just
// `main`). electron-vite's externalizeDepsPlugin() leaves it external, and
// the main-process bundle is CommonJS, so a static `import` compiles to a
// top-level `require("@anthropic-ai/sandbox-runtime")` that runs at module
// load — before app.whenReady() — and Node refuses to require() an ESM
// package (ERR_REQUIRE_ESM), crashing the packaged app before the window
// ever shows. None of npm test / typecheck / dev mode catch this — only a
// real packaged .dmg launch does (per CLAUDE.md section 12.6). The fix is
// the one Node's own error message recommends: a dynamic import(), valid
// from CommonJS, loaded lazily (now inside policyHost.ts). This is NOT a new pattern —
// EmbeddingService.ts and RerankerService.ts already do exactly this for
// @xenova/transformers (also ESM-only, also no CJS `exports` fallback).

import { fork, spawn } from 'child_process'
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type {
  SandboxExecutionBackend,
  SandboxRunSpec,
  SandboxRunResult,
  WrappedStdioCommand,
} from './types'
import { BASELINE_DENY_READ } from './BASELINE_DENY_READ'
import { memoryWatch, wallClockWatch } from './ResourceGovernor'
import type { SandboxViolationTraceEvent } from '../../../shared/types'

/** A policy host with no leases is stopped after this long. */
const HOST_IDLE_MS = 30_000
/** sandbox-runtime init (proxy bind + log monitor) must finish within this. */
const HOST_INIT_TIMEOUT_MS = 30_000
/** Bound on remembered command → caller labels (fallback renders are unique). */
const MAX_COMMAND_LABELS = 500

interface PolicyHost {
  key: string
  domains: string[]
  allowLocalBinding: boolean
  proc: ChildProcess
  ready: Promise<void>
  leases: number
  pinned: boolean
  dead: boolean
  /** Set by stopHost() — an intentional exit is not a crash. */
  stopping: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  nextId: number
  pending: Map<number, { resolve: (command: string) => void; reject: (err: Error) => void }>
}

type HostReply =
  | { t: 'ready' }
  | { t: 'init-error'; message: string }
  | { t: 'wrapped'; id: number; command: string }
  | { t: 'wrap-error'; id: number; message: string }
  | { t: 'violation'; line: string; command?: string; timestamp: number }

export interface SrtBackendOptions {
  /** Policy host entry + Node flags. Defaults to the built host next to this bundle. */
  hostEntry?: string
  hostExecArgv?: string[]
  /** How long a lease-less host lingers before stopping (default HOST_IDLE_MS). */
  hostIdleMs?: number
}

function defaultHost(): { entry: string; execArgv: string[] } {
  // Bundled (dev/packaged): electron-vite emits the host beside index.js.
  const built = join(__dirname, 'sandboxPolicyHost.js')
  if (existsSync(built)) return { entry: built, execArgv: [] }
  // Unbundled (vitest): run the TypeScript source through tsx.
  return { entry: join(__dirname, 'policyHost.ts'), execArgv: ['--import', 'tsx'] }
}

function policyKey(domains: string[], allowLocalBinding: boolean): string {
  return JSON.stringify({ domains: [...new Set(domains)].sort(), allowLocalBinding })
}

export class SrtBackend implements SandboxExecutionBackend {
  readonly name = 'srt' as const
  private initialized = false
  private readonly hostEntry: string
  private readonly hostExecArgv: string[]
  private readonly hostIdleMs: number
  private hosts = new Map<string, PolicyHost>()
  private activeRuns = new Set<ChildProcess>()
  private violationListeners = new Set<(event: SandboxViolationTraceEvent) => void>()

  // spec.command → caller-supplied label (see SandboxRunSpec.callerLabel and
  // the header comment's investigation point 3). Populated by every
  // run()/spawnPersistent()/wrapStdioCommand() call so violations can be
  // attributed back to whichever caller triggered them.
  private commandLabels = new Map<string, string>()

  constructor(options: SrtBackendOptions = {}) {
    const fallback = defaultHost()
    this.hostEntry = options.hostEntry ?? fallback.entry
    this.hostExecArgv = options.hostExecArgv ?? fallback.execArgv
    this.hostIdleMs = options.hostIdleMs ?? HOST_IDLE_MS
  }

  /**
   * Starts (and keeps warm) the deny-all policy host — the policy every
   * server without declared domains uses — so a broken sandbox surfaces at
   * startup rather than on the first tool call. Throws if it cannot start.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return
    const host = this.hostFor([], false)
    host.pinned = true
    await host.ready
    this.initialized = true
  }

  // ── Shared config builder ─────────────────────────────────────────────────

  private buildPerSpecConfig(spec: SandboxRunSpec): Partial<SandboxRuntimeConfig> {
    const mergedDenyRead = [...new Set([...BASELINE_DENY_READ, ...spec.denyRead])]
    if (spec.callerLabel) {
      this.commandLabels.delete(spec.command)
      this.commandLabels.set(spec.command, spec.callerLabel)
      if (this.commandLabels.size > MAX_COMMAND_LABELS) {
        this.commandLabels.delete(this.commandLabels.keys().next().value as string)
      }
    }
    // L3 workspace confinement: the scratch dir is always writable.
    const allowWrite = [...new Set([spec.workspaceDir, ...spec.allowWrite].filter(Boolean))]
    return {
      network: {
        allowedDomains: spec.allowedDomains,
        deniedDomains: [],
        allowLocalBinding: spec.allowLocalBinding === true,
      },
      filesystem: { denyRead: mergedDenyRead, allowWrite, denyWrite: [] },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
    }
  }

  // ── Policy hosts ──────────────────────────────────────────────────────────

  private hostFor(domains: string[], allowLocalBinding: boolean): PolicyHost {
    const key = policyKey(domains, allowLocalBinding)
    const existing = this.hosts.get(key)
    if (existing && !existing.dead) return existing

    const proc = fork(this.hostEntry, [], {
      execArgv: this.hostExecArgv,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    const host: PolicyHost = {
      key,
      domains: (JSON.parse(key) as { domains: string[] }).domains,
      allowLocalBinding,
      proc,
      ready: Promise.resolve(),
      leases: 0,
      pinned: false,
      dead: false,
      stopping: false,
      idleTimer: null,
      nextId: 1,
      pending: new Map(),
    }

    host.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`sandbox policy host did not initialize within ${HOST_INIT_TIMEOUT_MS} ms`))
        proc.kill('SIGKILL')
      }, HOST_INIT_TIMEOUT_MS)
      proc.on('message', (msg: HostReply) => {
        if (msg.t === 'ready') {
          clearTimeout(timer)
          resolve()
        } else if (msg.t === 'init-error') {
          clearTimeout(timer)
          reject(new Error(`sandbox policy host failed to initialize: ${msg.message}`))
          proc.kill('SIGKILL')
        } else if (msg.t === 'wrapped' || msg.t === 'wrap-error') {
          const waiter = host.pending.get(msg.id)
          host.pending.delete(msg.id)
          if (msg.t === 'wrapped') waiter?.resolve(msg.command)
          else waiter?.reject(new Error(msg.message))
        } else if (msg.t === 'violation') {
          this.handleViolation(msg)
        }
      })
      proc.once('exit', (code, signal) => {
        clearTimeout(timer)
        host.dead = true
        if (host.idleTimer) clearTimeout(host.idleTimer)
        if (this.hosts.get(key) === host) this.hosts.delete(key)
        const err = new Error(`sandbox policy host exited (code ${code}, signal ${signal})`)
        reject(err)
        for (const waiter of host.pending.values()) waiter.reject(err)
        host.pending.clear()
        if (host.leases > 0 && !host.stopping) {
          console.warn(
            `[SrtBackend] policy host ${key} exited with ${host.leases} live sandboxed ` +
              'process(es) — they have lost network access until restarted'
          )
        }
      })
      proc.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    // Rejections are delivered to whoever awaits a lease; never unhandled.
    host.ready.catch(() => {})

    proc.send({
      t: 'init',
      config: {
        network: { allowedDomains: host.domains, deniedDomains: [], allowLocalBinding },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
        enableWeakerNestedSandbox: false,
        enableWeakerNetworkIsolation: false,
      } satisfies SandboxRuntimeConfig,
    })
    this.hosts.set(key, host)
    return host
  }

  /** Wrap `spec.command` under its policy host and hold that host open until release(). */
  private async lease(spec: SandboxRunSpec): Promise<{ command: string; release: () => void }> {
    const customConfig = this.buildPerSpecConfig(spec)
    const host = this.hostFor(spec.allowedDomains, spec.allowLocalBinding === true)
    host.leases++
    if (host.idleTimer) {
      clearTimeout(host.idleTimer)
      host.idleTimer = null
    }

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      host.leases--
      if (host.leases === 0 && !host.pinned && !host.dead) {
        host.idleTimer = setTimeout(() => this.stopHost(host), this.hostIdleMs)
        host.idleTimer.unref?.()
      }
    }

    try {
      await host.ready
      const command = await new Promise<string>((resolve, reject) => {
        if (host.dead) return reject(new Error('sandbox policy host is not running'))
        const id = host.nextId++
        host.pending.set(id, { resolve, reject })
        host.proc.send({ t: 'wrap', id, command: spec.command, customConfig })
      })
      return { command, release }
    } catch (err) {
      release()
      throw err
    }
  }

  private stopHost(host: PolicyHost, graceMs = 3_000): Promise<void> {
    if (this.hosts.get(host.key) === host) this.hosts.delete(host.key)
    host.stopping = true
    if (host.dead) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const kill = setTimeout(() => host.proc.kill('SIGKILL'), graceMs)
      host.proc.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
      if (host.proc.connected) host.proc.send({ t: 'shutdown' })
      else host.proc.kill('SIGTERM')
    })
  }

  // ── One-shot run (spawn, wait for exit, capture stdout/stderr) ────────────

  async run(spec: SandboxRunSpec): Promise<SandboxRunResult> {
    const { command, release } = await this.lease(spec)

    // Merge spec.env with process.env — additive, never replaces wholesale.
    const env = { ...process.env, ...(spec.env ?? {}) }

    return new Promise<SandboxRunResult>((resolve) => {
      // detached → own process group, so a limit kills the whole tree
      // (shell wrapper, sandbox-exec, and whatever the command forked).
      const child = spawn(command, { shell: true, env, detached: true })
      this.activeRuns.add(child)
      let stdout = ''
      let stderr = ''
      let killedFor: string | null = null
      let settled = false

      const killTree = (reason: string): void => {
        if (killedFor) return
        killedFor = reason
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      const stopClock = wallClockWatch(spec.timeoutMs, () =>
        killTree(`wall-clock timeout (${spec.timeoutMs} ms)`)
      )
      const stopMemory =
        spec.maxRssMb > 0 && child.pid
          ? memoryWatch(child.pid, spec.maxRssMb, () => killTree(`RSS exceeded ${spec.maxRssMb} MB`))
          : () => {}

      const finish = (code: number | null, note = ''): void => {
        if (settled) return
        settled = true
        stopClock()
        stopMemory()
        this.activeRuns.delete(child)
        release()
        resolve({
          stdout,
          stderr: stderr + note + (killedFor ? `\n[SrtBackend] killed: ${killedFor}` : ''),
          exitCode: killedFor ? -1 : (code ?? -1),
          backend: 'srt',
        })
      }

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      child.on('error', (err: Error) => finish(-1, '\n[SrtBackend] spawn error: ' + err.message))
      // 'close', not 'exit' — output is only complete once stdio has drained.
      child.on('close', (code: number | null) => finish(code))
    })
  }

  // ── Persistent spawn (return live process, caller owns lifecycle) ─────────

  async spawnPersistent(spec: SandboxRunSpec): Promise<ChildProcessWithoutNullStreams> {
    const { command, release } = await this.lease(spec)

    // Merge spec.env with process.env — additive, never replaces wholesale.
    const env = { ...process.env, ...(spec.env ?? {}) }

    const child = spawn(command, { shell: true, env })
    child.once('exit', release)
    child.once('error', release)
    return child
  }

  // ── Argv-ready wrap (caller owns the spawn — e.g. MCP SDK's transport) ────

  async wrapStdioCommand(spec: SandboxRunSpec): Promise<WrappedStdioCommand> {
    const { command, release } = await this.lease(spec)
    // Same shape sandbox-runtime's own wrapWithSandboxArgv() returns on
    // macOS/Linux: the wrapped string behind `bash -c`, with this process's env.
    return { command: '/bin/bash', args: ['-c', command], env: { ...process.env }, release }
  }

  // ── Violation observation (Phase 2) ────────────────────────────────────────

  private handleViolation(raw: { line: string; command?: string; timestamp: number }): void {
    const parsed = parseViolationLine(raw.line)
    if (!parsed) return
    const event: SandboxViolationTraceEvent = {
      source: (raw.command && this.commandLabels.get(raw.command)) || 'unknown',
      kind: parsed.kind,
      target: parsed.target,
      timestamp: raw.timestamp,
    }
    for (const listener of this.violationListeners) listener(event)
  }

  /**
   * Subscribe to sandbox violations from every policy host, parsed and
   * labeled with the caller that triggered them. Only violations raised
   * after subscribing are delivered (each host skips its store's replay).
   * Lines that don't parse as a read/write/network operation are skipped —
   * see parseViolationLine(). Returns an unsubscribe function.
   */
  subscribeToViolations(onViolation: (event: SandboxViolationTraceEvent) => void): () => void {
    this.violationListeners.add(onViolation)
    return () => {
      this.violationListeners.delete(onViolation)
    }
  }

  /** Policies with a live host — for Settings/status display. */
  getActivePolicies(): Array<{ allowedDomains: string[]; allowLocalBinding: boolean; leases: number }> {
    return [...this.hosts.values()]
      .filter((h) => !h.dead)
      .map((h) => ({ allowedDomains: h.domains, allowLocalBinding: h.allowLocalBinding, leases: h.leases }))
  }

  async shutdown(): Promise<void> {
    for (const child of this.activeRuns) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    this.activeRuns.clear()
    await Promise.all([...this.hosts.values()].map((h) => this.stopHost(h)))
    this.hosts.clear()
    this.initialized = false
    this.commandLabels.clear()
  }
}

// ── Violation line parsing ────────────────────────────────────────────────────
// SandboxViolationEvent.line is the text after "Sandbox: " in the macOS
// kernel log, formatted as "<proc>(<pid>) deny(<n>) <operation> <resource>"
// (verified live — see header comment point 3/4). macOS seatbelt operation
// names follow a `<category>-<action>` convention (file-read-data,
// file-write-create, network-outbound, sysctl-read, mach-lookup, ...).
// Classifying by the action suffix rather than only the `file-*` prefix is
// deliberate: it also correctly classifies non-file reads (e.g. the
// default-deny fallback's sysctl-read, the one violation kind verified to
// be reliably captured — see point 4) as 'read', which is accurate even
// though it isn't a file. Operations that don't fit read/write/network
// (mach-lookup, iokit-open, process-exec, ...) are skipped — the app-level
// type only has three kinds and forcing an inaccurate bucket would be worse
// than omitting them.
function parseViolationLine(line: string): { kind: 'read' | 'write' | 'network'; target: string } | null {
  const match = line.match(/deny(?:\(\d+\))?\s+(\S+)\s+(.+)$/)
  if (!match) return null
  const [, operation, target] = match

  if (operation.startsWith('network')) return { kind: 'network', target: target.trim() }
  if (/write|create|unlink/.test(operation)) return { kind: 'write', target: target.trim() }
  if (/read/.test(operation)) return { kind: 'read', target: target.trim() }
  return null
}