// Sandbox policy host — one forked Node process per distinct network policy.
//
// Why this exists (found 2026-09-30, see progress.md): @anthropic-ai/
// sandbox-runtime is a module-level singleton with ONE HTTP/SOCKS proxy and
// ONE live network allowlist, read per-request by filterNetworkRequest(). The
// proxy cannot tell which sandboxed process a connection came from (a single
// shared auth token), so SandboxManager.updateConfig() before each wrap —
// the previous approach — made the MOST RECENT spawn's allowlist apply to
// EVERY running sandboxed process: starting a no-network MCP server silently
// cut the Python worker's yfinance access, and a server spawned after another
// inherited its domains (spec section 10 / DoD D4–D5 violated as soon as two
// sandboxed processes coexist).
//
// Each host owns its own SandboxManager, so its proxy enforces exactly one
// allowlist, fixed at init. Seatbelt only lets a wrapped process reach its own
// host's proxy port, so processes with different policies can never share an
// allowlist. Violation monitoring is also per host: sandbox-runtime tags every
// profile with a random per-module session suffix and its `log stream`
// predicate matches only that suffix.
//
// Protocol (process.send / 'message'):
//   parent → host  { t: 'init', config }            → { t: 'ready' } | { t: 'init-error', message }
//   parent → host  { t: 'wrap', id, command, customConfig } → { t: 'wrapped', id, command } | { t: 'wrap-error', id, message }
//   parent → host  { t: 'shutdown' }                → host resets and exits
//   host   → parent { t: 'violation', line, command?, timestamp }

import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

// fork() sets this so Electron's binary runs as plain Node; it must not leak
// into anything this host reports back (the parent builds child envs itself).
delete process.env.ELECTRON_RUN_AS_NODE

type HostMessage =
  | { t: 'init'; config: SandboxRuntimeConfig }
  | { t: 'wrap'; id: number; command: string; customConfig: Partial<SandboxRuntimeConfig> }
  | { t: 'shutdown' }

const send = (msg: unknown): void => {
  if (process.connected) process.send?.(msg)
}

let managerPromise: Promise<typeof import('@anthropic-ai/sandbox-runtime')['SandboxManager']> | null = null

async function init(config: SandboxRuntimeConfig): Promise<void> {
  // Dynamic import — sandbox-runtime is ESM-only (see SrtBackend.ts header).
  managerPromise = import('@anthropic-ai/sandbox-runtime').then((m) => m.SandboxManager)
  const SandboxManager = await managerPromise
  await SandboxManager.initialize(config, undefined, true)

  const store = SandboxManager.getSandboxViolationStore()
  let lastTotal = store.getTotalCount()
  store.subscribe((violations) => {
    const total = store.getTotalCount()
    const fresh = total - lastTotal
    if (fresh <= 0) return
    lastTotal = total
    for (const v of violations.slice(-fresh)) {
      send({ t: 'violation', line: v.line, command: v.command, timestamp: v.timestamp.getTime() })
    }
  })
}

async function shutdown(): Promise<void> {
  try {
    if (managerPromise) await (await managerPromise).reset()
  } finally {
    process.exit(0)
  }
}

process.on('message', (msg: HostMessage) => {
  if (msg.t === 'init') {
    init(msg.config).then(
      () => send({ t: 'ready' }),
      (err: Error) => send({ t: 'init-error', message: err?.message ?? String(err) })
    )
  } else if (msg.t === 'wrap') {
    ;(async () => {
      if (!managerPromise) throw new Error('policy host not initialized')
      const SandboxManager = await managerPromise
      return SandboxManager.wrapWithSandbox(msg.command, undefined, msg.customConfig)
    })().then(
      (command) => send({ t: 'wrapped', id: msg.id, command }),
      (err: Error) => send({ t: 'wrap-error', id: msg.id, message: err?.message ?? String(err) })
    )
  } else if (msg.t === 'shutdown') {
    void shutdown()
  }
})

// Parent died or closed the channel — never outlive it (no orphaned proxies).
process.on('disconnect', () => void shutdown())
