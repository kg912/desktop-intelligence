// Sandbox type definitions — spec section 05 verbatim.
//
// These are the contract every caller (PythonWorkerService, McpServerManager,
// future Multi-Agent proxy) depends on.  Which backend actually runs is an
// internal routing decision inside SandboxService — call sites never reference
// a backend directly.

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
  shutdown(): Promise<void>
}
