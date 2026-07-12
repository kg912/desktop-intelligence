// MicrosandboxBackend — stub satisfying SandboxExecutionBackend.
//
// Phase 0 ships this as a stub that compiles and satisfies the interface but
// throws on run().  This is deliberate (spec section 05): call sites are
// written once against the interface, and Phase 4 is purely "implement the
// stub's internals" — not a design change touching code that's already shipped.
//
// Actual adoption timing depends on the benchmark gate (spec section 14),
// not vendor marketing figures.

import type { SandboxExecutionBackend, SandboxRunSpec, SandboxRunResult } from './types'

export class MicrosandboxBackend implements SandboxExecutionBackend {
  readonly name = 'microsandbox' as const

  async initialize(): Promise<void> {
    // No-op until Phase 4 gate passes.
  }

  async run(_spec: SandboxRunSpec): Promise<SandboxRunResult> {
    throw new Error(
      'MicrosandboxBackend is not yet implemented — ' +
      'see SANDBOX_ARCHITECTURE_SPEC.html section 14 for the benchmark gate ' +
      'that must pass before this backend is enabled'
    )
  }

  async shutdown(): Promise<void> {
    // No-op until Phase 4 gate passes.
  }
}
