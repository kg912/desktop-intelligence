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
// CRITICAL (found 2026-07-13, see progress.md row 303): wrapWithSandbox()'s
// `customConfig` argument does NOT push a new network allowlist to the live
// enforcement proxy — that proxy is configured once, at initialize()-time,
// from `baseConfig` (deny-all). Without an explicit SandboxManager.updateConfig()
// call before each wrapWithSandbox(), every spawned process silently gets
// initialize()'s network policy instead of its own spec.allowedDomains —
// confirmed via a real yfinance render that failed with
// "curl: (56) CONNECT tunnel failed, response 403" until updateConfig() was
// added below. This is why every run()/spawnPersistent() call updates the
// live config immediately before wrapping.
//
// ── Violation store investigation (Phase 2, 2026-07-13, spec section 11/16) ──
// Investigated (not guessed — read node_modules/@anthropic-ai/sandbox-runtime/
// dist/sandbox/sandbox-manager.js and sandbox-violation-store.js directly,
// then verified live with 4 separate diagnostic runs):
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

import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { SandboxExecutionBackend, SandboxRunSpec, SandboxRunResult } from './types'
import { BASELINE_DENY_READ } from './BASELINE_DENY_READ'
import type { SandboxViolationTraceEvent } from '../../../shared/types'

const baseConfig: SandboxRuntimeConfig = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  enableWeakerNestedSandbox: false,
  enableWeakerNetworkIsolation: false
}

export class SrtBackend implements SandboxExecutionBackend {
  readonly name = 'srt' as const
  private initialized = false

  // spec.command → caller-supplied label (see SandboxRunSpec.callerLabel and
  // the header comment's investigation point 3). Populated by every
  // run()/spawnPersistent()/wrapStdioCommand() call so violations can be
  // attributed back to whichever caller triggered them.
  private commandLabels = new Map<string, string>()

  async initialize(): Promise<void> {
    if (this.initialized) return
    // enableLogMonitor:true — required for getSandboxViolationStore() to
    // ever populate. See header comment investigation point 1. Does not
    // change the config passed for run()/spawnPersistent()/wrapStdioCommand().
    await SandboxManager.initialize(baseConfig, undefined, true)
    this.initialized = true
  }

  // ── Shared config builder ─────────────────────────────────────────────────

  private buildPerSpecConfig(spec: SandboxRunSpec): Partial<SandboxRuntimeConfig> {
    const mergedDenyRead = [...new Set([...BASELINE_DENY_READ, ...spec.denyRead])]
    if (spec.callerLabel) {
      this.commandLabels.set(spec.command, spec.callerLabel)
    }
    return {
      network: { allowedDomains: spec.allowedDomains, deniedDomains: [] },
      filesystem: {
        denyRead: mergedDenyRead,
        allowWrite: spec.allowWrite,
        denyWrite: []
      },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false
    }
  }

  // ── One-shot run (spawn, wait for exit, capture stdout/stderr) ────────────

  async run(spec: SandboxRunSpec): Promise<SandboxRunResult> {
    if (!this.initialized) {
      await this.initialize()
    }

    const perSpecConfig = this.buildPerSpecConfig(spec)

    // Push the per-spec network/filesystem policy to the live enforcement
    // proxy — wrapWithSandbox()'s customConfig alone does not do this (see
    // header comment). Must happen before wrapWithSandbox() below.
    SandboxManager.updateConfig(perSpecConfig as SandboxRuntimeConfig)

    const sandboxedCommand = await SandboxManager.wrapWithSandbox(
      spec.command,
      undefined,
      perSpecConfig
    )

    // Merge spec.env with process.env — additive, never replaces wholesale.
    const env = { ...process.env, ...(spec.env ?? {}) }

    return new Promise<SandboxRunResult>((resolve) => {
      const child = spawn(sandboxedCommand, { shell: true, env })
      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      child.on('error', (err: Error) => {
        resolve({
          stdout,
          stderr: stderr + '\n[SrtBackend] spawn error: ' + err.message,
          exitCode: -1,
          backend: 'srt'
        })
      })
      child.on('exit', (code: number | null) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
          backend: 'srt'
        })
      })
    })
  }

  // ── Persistent spawn (return live process, caller owns lifecycle) ─────────

  async spawnPersistent(spec: SandboxRunSpec): Promise<ChildProcessWithoutNullStreams> {
    if (!this.initialized) {
      await this.initialize()
    }

    const perSpecConfig = this.buildPerSpecConfig(spec)

    // Push the per-spec network/filesystem policy to the live enforcement
    // proxy — wrapWithSandbox()'s customConfig alone does not do this (see
    // header comment). Must happen before wrapWithSandbox() below.
    SandboxManager.updateConfig(perSpecConfig as SandboxRuntimeConfig)

    const sandboxedCommand = await SandboxManager.wrapWithSandbox(
      spec.command,
      undefined,
      perSpecConfig
    )

    // Merge spec.env with process.env — additive, never replaces wholesale.
    const env = { ...process.env, ...(spec.env ?? {}) }

    return spawn(sandboxedCommand, { shell: true, env })
  }

  // ── Argv-ready wrap (caller owns the spawn — e.g. MCP SDK's transport) ────

  async wrapStdioCommand(
    spec: SandboxRunSpec
  ): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
    if (!this.initialized) {
      await this.initialize()
    }

    const perSpecConfig = this.buildPerSpecConfig(spec)

    // Push the per-spec network/filesystem policy to the live enforcement
    // proxy — wrapWithSandbox()'s customConfig alone does not do this (see
    // header comment). Must happen before wrapWithSandboxArgv() below.
    SandboxManager.updateConfig(perSpecConfig as SandboxRuntimeConfig)

    const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
      spec.command,
      undefined,
      perSpecConfig
    )

    return { command: argv[0], args: argv.slice(1), env }
  }

  // ── Violation observation (Phase 2) ────────────────────────────────────────

  /**
   * Subscribe to sandbox violations, parsed and labeled with the caller
   * that triggered them. Only violations added AFTER subscribing are
   * delivered — SandboxViolationStore.subscribe() replays the full history
   * synchronously on every call (see header comment point 2), so a
   * getTotalCount() cursor is used to skip that replay and any violations
   * this listener has already seen. Lines that don't parse as a
   * read/write/network operation are silently skipped (see
   * parseViolationLine() — the type only has three kinds.
   *
   * Returns an unsubscribe function.
   */
  subscribeToViolations(onViolation: (event: SandboxViolationTraceEvent) => void): () => void {
    const store = SandboxManager.getSandboxViolationStore()
    let lastTotal = store.getTotalCount()

    return store.subscribe((violations) => {
      const currentTotal = store.getTotalCount()
      const newCount = currentTotal - lastTotal
      if (newCount <= 0) return
      lastTotal = currentTotal

      for (const raw of violations.slice(-newCount)) {
        const parsed = parseViolationLine(raw.line)
        if (!parsed) continue
        const source = (raw.command && this.commandLabels.get(raw.command)) || 'unknown'
        onViolation({
          source,
          kind: parsed.kind,
          target: parsed.target,
          timestamp: raw.timestamp.getTime(),
        })
      }
    })
  }

  async shutdown(): Promise<void> {
    await SandboxManager.reset()
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