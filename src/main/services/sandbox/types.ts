// Sandbox type definitions — spec section 05, extended for Phase 0/1.
//
// These are the contract every caller (PythonWorkerService, McpServerManager,
// future Multi-Agent proxy) depends on.  Which backend actually runs is an
// internal routing decision inside SandboxService — call sites never reference
// a backend directly.

import type { ChildProcessWithoutNullStreams } from 'child_process'

export interface SandboxRunSpec {
  /** Scratch directory the sandboxed process works inside. */
  workspaceDir: string
  /** Fixed, app-controlled shell command — NEVER interpolate LLM output (Section 08). */
  command: string
  /** Container image — used only by MicrosandboxBackend. */
  image?: string
  /** Routing key: 'lightweight' → SrtBackend, 'untrusted-heavy' → MicrosandboxBackend. */
  executionProfile: 'lightweight' | 'untrusted-heavy'
  /** Network allowlist — empty means zero network access (srt allow-only). */
  allowedDomains: string[]
  /** Paths the sandboxed process may write to (srt deny-write-by-default). */
  allowWrite: string[]
  /** Caller-supplied deny-read paths — merged with BASELINE_DENY_READ (Section 07). */
  denyRead: string[]
  /** Wall-clock timeout in milliseconds (enforced by ResourceGovernor, Phase 0 future item). */
  timeoutMs: number
  /** Maximum RSS in MB (enforced by ResourceGovernor, Phase 0 future item). */
  maxRssMb: number
  /**
   * Environment variables to merge with process.env at spawn time.
   * Additive — never replaces process.env wholesale.
   * Used by PythonWorkerService for MPLBACKEND='Agg', MPLCONFIGDIR, etc.
   */
  env?: Record<string, string>
  /**
   * Caller-supplied label used to attribute sandbox_violation trace events
   * back to whichever caller triggered them (Phase 2, spec section 11/16)
   * — e.g. 'python-worker' or 'mcp:<serverName>'. SrtBackend tracks this
   * against spec.command (the pre-wrap command), which is what
   * SandboxViolationEvent.command decodes back to, so violations can be
   * attributed without inferring it after the fact from the raw log line.
   * Optional so existing/future callers that don't care about attribution
   * don't need to change — falls back to 'unknown'.
   */
  callerLabel?: string
}

export interface SandboxRunResult {
  stdout: string
  stderr: string
  exitCode: number
  backend: 'srt' | 'microsandbox'
}

export interface SandboxExecutionBackend {
  readonly name: 'srt' | 'microsandbox'
  initialize(): Promise<void>
  run(spec: SandboxRunSpec): Promise<SandboxRunResult>
  /**
   * Wrap and spawn a long-lived persistent process.  Returns the live child
   * process handle immediately — does NOT wait for exit.  The caller owns
   * stdin writes, stdout parsing, and lifecycle (exit/restart) exactly as
   * PythonWorkerService already does today for its direct spawn() call.
   */
  spawnPersistent(spec: SandboxRunSpec): Promise<ChildProcessWithoutNullStreams>
  /**
   * Wrap a command for callers that do NOT spawn the process themselves —
   * e.g. the MCP SDK's StdioClientTransport owns the spawn call internally.
   * Returns argv-ready values (command + args array + env), not a shell
   * string, so the caller can hand them to its own spawn-owning API.
   */
  wrapStdioCommand(
    spec: SandboxRunSpec
  ): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>
  shutdown(): Promise<void>
}