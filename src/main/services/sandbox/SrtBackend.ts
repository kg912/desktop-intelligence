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

import { spawn } from 'child_process'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { SandboxExecutionBackend, SandboxRunSpec, SandboxRunResult } from './types'
import { BASELINE_DENY_READ } from './BASELINE_DENY_READ'

const baseConfig: SandboxRuntimeConfig = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  enableWeakerNestedSandbox: false,
  enableWeakerNetworkIsolation: false
}

export class SrtBackend implements SandboxExecutionBackend {
  readonly name = 'srt' as const
  private initialized = false

  async initialize(): Promise<void> {
    if (this.initialized) return
    await SandboxManager.initialize(baseConfig)
    this.initialized = true
  }

  async run(spec: SandboxRunSpec): Promise<SandboxRunResult> {
    if (!this.initialized) {
      await this.initialize()
    }

    // Merge caller-supplied denyRead with the baseline — de-duplicated.
    const mergedDenyRead = [...new Set([...BASELINE_DENY_READ, ...spec.denyRead])]

    // Per-spec config passed as customConfig to wrapWithSandbox — merges with
    // the base config from initialize().  Flat schema per spec section 19.
    const perSpecConfig: Partial<SandboxRuntimeConfig> = {
      network: { allowedDomains: spec.allowedDomains, deniedDomains: [] },
      filesystem: {
        denyRead: mergedDenyRead,
        allowWrite: spec.allowWrite,
        denyWrite: []
      },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false
    }

    const sandboxedCommand = await SandboxManager.wrapWithSandbox(
      spec.command,
      undefined,
      perSpecConfig
    )

    return new Promise<SandboxRunResult>((resolve) => {
      const child = spawn(sandboxedCommand, { shell: true })
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

  async shutdown(): Promise<void> {
    await SandboxManager.reset()
    this.initialized = false
  }
}
