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

import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
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

  // ── Shared config builder ─────────────────────────────────────────────────

  private buildPerSpecConfig(spec: SandboxRunSpec): Partial<SandboxRuntimeConfig> {
    const mergedDenyRead = [...new Set([...BASELINE_DENY_READ, ...spec.denyRead])]
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

  async shutdown(): Promise<void> {
    await SandboxManager.reset()
    this.initialized = false
  }
}