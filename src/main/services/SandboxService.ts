// SandboxService — single choke point every caller uses (spec section 04/05).
//
// Backend selection (srt vs. microsandbox) is an internal routing decision
// behind a stable interface — call sites never reference a backend directly.
//
// Routing policy:
//   'lightweight' (default)       → SrtBackend
//   'untrusted-heavy' (explicit)  → MicrosandboxBackend
//
// Requesting 'untrusted-heavy' before Phase 4 ships throws rather than silently
// falling back to an under-sandboxed path — a missing capability must fail
// loudly, not degrade quietly.

import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { SandboxExecutionBackend, SandboxRunSpec, SandboxRunResult } from './sandbox/types'

export class SandboxService {
  private readonly srt: SandboxExecutionBackend
  private readonly microsandbox: SandboxExecutionBackend

  constructor(srt: SandboxExecutionBackend, microsandbox: SandboxExecutionBackend) {
    this.srt = srt
    this.microsandbox = microsandbox
  }

  async run(spec: SandboxRunSpec): Promise<SandboxRunResult> {
    if (spec.executionProfile === 'untrusted-heavy') {
      // Throws per MicrosandboxBackend stub — no silent fallback to srt.
      return this.microsandbox.run(spec)
    }
    return this.srt.run(spec)
  }

  async spawnPersistent(spec: SandboxRunSpec): Promise<ChildProcessWithoutNullStreams> {
    if (spec.executionProfile === 'untrusted-heavy') {
      return this.microsandbox.spawnPersistent(spec)
    }
    return this.srt.spawnPersistent(spec)
  }

  async wrapStdioCommand(
    spec: SandboxRunSpec
  ): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
    if (spec.executionProfile === 'untrusted-heavy') {
      // Throws per MicrosandboxBackend stub — no silent fallback to srt.
      return this.microsandbox.wrapStdioCommand(spec)
    }
    return this.srt.wrapStdioCommand(spec)
  }
}