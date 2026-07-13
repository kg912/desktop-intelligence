// MicrosandboxBackend — stub satisfying SandboxExecutionBackend.
//
// Phase 0 ships this as a stub that compiles and satisfies the interface but
// throws on run() and spawnPersistent().  This is deliberate (spec section 05):
// call sites are written once against the interface, and Phase 4 is purely
// "implement the stub's internals" — not a design change touching code that's
// already shipped.
//
// Actual adoption timing depends on the benchmark gate (spec section 14),
// not vendor marketing figures.

import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { SandboxExecutionBackend, SandboxRunSpec, SandboxRunResult } from './types'

const NOT_IMPLEMENTED =
  'MicrosandboxBackend is not yet implemented — ' +
  'see SANDBOX_ARCHITECTURE_SPEC.html section 14 for the benchmark gate ' +
  'that must pass before this backend is enabled'

export class MicrosandboxBackend implements SandboxExecutionBackend {
  readonly name = 'microsandbox' as const

  async initialize(): Promise<void> {
    // No-op until Phase 4 gate passes.
  }

  async run(_spec: SandboxRunSpec): Promise<SandboxRunResult> {
    throw new Error(NOT_IMPLEMENTED)
  }

  async spawnPersistent(_spec: SandboxRunSpec): Promise<ChildProcessWithoutNullStreams> {
    throw new Error(NOT_IMPLEMENTED)
  }

  async wrapStdioCommand(
    _spec: SandboxRunSpec
  ): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
    throw new Error(NOT_IMPLEMENTED)
  }

  async shutdown(): Promise<void> {
    // No-op until Phase 4 gate passes.
  }
}