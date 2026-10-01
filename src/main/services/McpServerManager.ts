/**
 * McpServerManager
 *
 * Owns the lifecycle of all custom MCP server processes.
 * Reads configuration from mcp.json in app.getPath('userData').
 * Spawns each enabled server as a stdio child process via @modelcontextprotocol/sdk.
 * Discovers tool schemas and dispatches tool calls on behalf of ChatService.
 *
 * Tool name namespacing convention: "serverName__toolName" (double underscore)
 * ensures no collisions with built-in tools (brave_web_search) across servers.
 *
 * Permission flow:
 *   callTool() → if requiresApproval → sends MCP_TOOL_PERMISSION_REQUEST to renderer
 *   → waits for MCP_TOOL_PERMISSION_RESPONSE via resolvePermission()
 *   → executes or denies the call
 */

import { EventEmitter } from 'events'
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { quote } from 'shell-quote'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  McpServerConfig,
  McpServerSettings,
  McpServerRuntimeInfo,
  McpToolPermissionRequest,
} from '../../shared/types'
import { isHttpMcpConfig } from '../../shared/types'
import { sandboxService } from './sandbox/sandboxServiceInstance'
import { memoryWatch } from './sandbox/ResourceGovernor'
import type { SandboxViolationTraceEvent } from '../../shared/types'

// RSS cap for sandboxed MCP stdio servers — lower than PythonWorkerService's
// 1 GB since these are typically lightweight tool servers, not
// matplotlib/numpy/yfinance workloads.
const MCP_SERVER_MAX_RSS_MB = 512

/** A stdio server whose sandbox manifest the user has not reviewed yet. */
function needsSandboxReview(config: McpServerConfig): boolean {
  return !isHttpMcpConfig(config) && !config.sandboxProfile
}

export const SANDBOX_REVIEW_REQUIRED =
  'Sandbox review required — approve this server\'s allowed domains and writable paths ' +
  '(Settings → MCP → Sandbox profile) before it can run'

// ── MCP tool call result ─────────────────────────────────────────

export interface McpToolResult {
  text:    string
  images:  Array<{ mimeType: string; data: string }>
  userNote: string
}

export class McpDeniedError extends Error {
  constructor(public readonly userNote: string) {
    super('Tool call denied by user')
    this.name = 'McpDeniedError'
  }
}

export function buildApprovedToolResult(result: string, userNote: string): string {
  if (!userNote) return result
  return `[User note: "${userNote}"]\n\n${result}`
}

export function buildDeniedToolMessage(userNote: string): string {
  const reasonLine = userNote ? `\nUser reason: "${userNote}"` : ''
  return `Tool call denied by user.${reasonLine}\nDo not attempt this tool call again in this conversation.`
}

// ── LM Studio tool schema shape (matches BRAVE_SEARCH_TOOL in ChatService) ──

export interface LMStudioToolParam {
  type:         string
  description?: string
  properties?:  Record<string, LMStudioToolParam>
  required?:    string[]
  items?:       LMStudioToolParam
}

export interface LMStudioTool {
  type: 'function'
  function: {
    name:        string
    description: string
    parameters:  {
      type:       'object'
      properties: Record<string, LMStudioToolParam>
      required:   string[]
    }
  }
}

// ── Internal state per running server ────────────────────────────

interface ServerEntry {
  name:    string
  config:  McpServerConfig & { enabled: boolean }
  client:  Client | null
  status:  import('../../shared/types').McpServerStatus
  tools:   string[]       // discovered tool names (un-namespaced)
  schemas: LMStudioTool[] // namespaced tool schemas for injection
  error:   string | undefined
  /** Session-level flag: false means calls bypass the approval dialog */
  requiresApproval: boolean
  /**
   * Meta-MCP translation map — only populated for servers that expose
   * TOOL_LIST/TOOL_GET/TOOL_CALL instead of real domain tools.
   * Maps the expanded tool name (as seen by the model, un-namespaced) → the
   * real tool name to call on the server (always "TOOL_CALL" for meta-MCPs).
   * When present, callTool() injects the logical name into the args instead
   * of passing it as the tool name directly.
   */
  metaToolMap?: Map<string, string> // expandedToolName → 'TOOL_CALL'
  /**
   * The parameter key names that TOOL_CALL expects, read from its inputSchema
   * at startup. Different meta-MCP servers may use different key names.
   * e.g. AlphaVantage uses { toolNameKey: 'tool_name', argumentsKey: 'arguments' }
   */
  metaCallKeys?: { toolNameKey: string; argumentsKey: string }
  /**
   * ResourceGovernor stop handle for the stdio child's RSS watch (Phase 1
   * sandbox retrofit). Only set for stdio transports, where
   * StdioClientTransport.pid is available. Cleared on _stopServer().
   */
  stopMemoryWatch?: () => void
  /** Releases the sandbox network policy held for this server's process. */
  releaseSandbox?: () => void
}

// ── Permission promise map ────────────────────────────────────────

interface PendingPermission {
  serverName: string
  toolName:   string
  chatId:     string
  /** `${runId}\u0000${agentId}` for multi-agent requests (per-agent trust). */
  agentKey?:  string
  resolve:    (result: { approved: boolean; userNote: string }) => void
  timer:      ReturnType<typeof setTimeout>
}

/** Who is calling, for a proxied multi-agent worker tool request. */
export interface MultiAgentToolContext {
  chatId:  string
  runId:   string
  agentId: string
  role:    string
  model:   string
  /** Multi-agent HITL default (Settings): prompt for every tool call not otherwise trusted. */
  requirePermissions: boolean
  /** The run's HITL timeout — the dialog auto-denies after this. */
  hitlTimeoutMs: number
}

const PERMISSION_TIMEOUT_MS = 60_000
/** Server namespace of Electron's built-in worker tools (`builtin__brave_web_search`). */
export const BUILTIN_SERVER = 'builtin'
const agentKey = (runId: string, agentId: string): string => `${runId}\u0000${agentId}`

// ── McpServerManager ─────────────────────────────────────────────

export class McpServerManager extends EventEmitter {
  private servers            = new Map<string, ServerEntry>()
  private pendingPermissions = new Map<string, PendingPermission>()
  private sessionAllowList     = new Set<string>()
  private bypassAllPermissions = false
  /** serverName → agentIds with a proxied call in flight (for violation attribution). */
  private activeMultiAgentWorkers = new Map<string, Map<string, number>>()
  /**
   * Agent-level trust within a run (spec §07) — sits between the per-chat
   * layers (bypass-all, session allow) and the per-server approval setting.
   */
  private agentTrust = new Map<string, 'trust' | 'block'>()

  // ── Config helpers ───────────────────────────────────────────

  protected configPath(): string {
    return join(app.getPath('userData'), 'mcp.json')
  }

  async readConfig(): Promise<McpServerSettings> {
    const p = this.configPath()
    if (!existsSync(p)) return {}
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as McpServerSettings
    } catch (err) {
      console.warn('[McpServerManager] mcp.json parse error (returning {}):', err)
      return {}
    }
  }

  async writeConfig(settings: McpServerSettings): Promise<void> {
    writeFileSync(this.configPath(), JSON.stringify(settings, null, 2), 'utf8')
    console.log('[McpServerManager] mcp.json written:', Object.keys(settings).join(', '))
  }

  async setToolEnabled(serverName: string, toolName: string, enabled: boolean): Promise<void> {
    const config = await this.readConfig()
    const server = config[serverName]
    if (!server) throw new Error(`Server "${serverName}" not found in config`)

    const disabled = new Set(server.disabledTools ?? [])
    if (enabled) {
      disabled.delete(toolName)
    } else {
      disabled.add(toolName)
    }
    server.disabledTools = disabled.size > 0 ? [...disabled] : []

    await this.writeConfig(config)
    console.log(`[McpServerManager] Tool "${serverName}__${toolName}" ${enabled ? 'enabled' : 'disabled'}`)

    const entry = this.servers.get(serverName)
    if (entry) {
      entry.config = { ...entry.config, disabledTools: server.disabledTools }
      // Push confirmed state to renderer so the UI reflects the persisted value
      this._emitStatus(serverName)
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async startAll(): Promise<void> {
    const config = await this.readConfig()
    const names  = Object.keys(config)
    console.log(`[McpServerManager] startAll: ${names.length} server(s) configured`)
    await Promise.allSettled(names.map((n) => this._startServer(n, config[n])))
  }

  async stopAll(): Promise<void> {
    console.log('[McpServerManager] stopAll')
    await Promise.allSettled([...this.servers.keys()].map((n) => this._stopServer(n)))
  }

  async restartServer(name: string): Promise<void> {
    console.log(`[McpServerManager] restartServer: ${name}`)
    await this._stopServer(name)
    const config = await this.readConfig()
    if (config[name]) {
      await this._startServer(name, config[name])
    }
  }

  async removeServer(name: string): Promise<void> {
    await this._stopServer(name)
    this.servers.delete(name)
    const config = await this.readConfig()
    delete config[name]
    await this.writeConfig(config)
    console.log(`[McpServerManager] Removed server: ${name}`)
  }

  // ── Status / schema accessors ────────────────────────────────

  getServerStatus(): McpServerRuntimeInfo[] {
    return [...this.servers.values()].map((e) => ({
      name:             e.name,
      status:           e.status,
      tools:            e.tools,
      error:            e.error,
      disabledTools:    e.config.disabledTools ?? [],
      requiresApproval: e.requiresApproval,
      needsSandboxReview: needsSandboxReview(e.config),
    }))
  }

  getToolSchemas(): LMStudioTool[] {
    const result: LMStudioTool[] = []
    for (const entry of this.servers.values()) {
      if (entry.status !== 'running') continue
      const disabledSet = new Set(entry.config.disabledTools ?? [])
      for (const schema of entry.schemas) {
        // schema.function.name is namespaced: "serverName__toolName"
        // Extract the un-namespaced tool name for the disable check
        const parts = schema.function.name.split('__')
        const unNamespacedTool = parts.slice(1).join('__') // handles tool names that might contain __
        if (!disabledSet.has(unNamespacedTool)) {
          result.push(schema)
        }
      }
    }
    return result
  }

  // ── Tool call dispatch ────────────────────────────────────────

  async callTool(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
    chatId:     string = '',
  ): Promise<McpToolResult> {
    const entry = this._runningEntry(serverName)
    const perm = await this._requestPermission(serverName, toolName, args, chatId)
    if (!perm.approved) throw new McpDeniedError(perm.userNote)
    return this._executeTool(entry, toolName, args, perm.userNote)
  }

  private async _executeTool(
    entry:    ServerEntry & { client: Client },
    toolName: string,
    args:     Record<string, unknown>,
    userNote: string,
  ): Promise<McpToolResult> {

    // Meta-MCP translation: if this server uses a TOOL_LIST/TOOL_CALL proxy
    // layer, the model was given expanded tool names (e.g. "TIME_SERIES_DAILY").
    // We must translate back to the real executor ("TOOL_CALL") and pass the
    // logical tool name as an argument so the server knows what to invoke.
    let resolvedToolName = toolName
    let resolvedArgs     = args
    if (entry.metaToolMap?.has(toolName)) {
      resolvedToolName = entry.metaToolMap.get(toolName)! // always 'TOOL_CALL'
      const { toolNameKey, argumentsKey } = entry.metaCallKeys ?? {
        toolNameKey: 'tool_name',
        argumentsKey: 'arguments',
      }
      resolvedArgs = {
        [toolNameKey]:  toolName,
        [argumentsKey]: Object.keys(args).length > 0 ? args : {},
      }
    }

    const result = await entry.client.callTool({ name: resolvedToolName, arguments: resolvedArgs })

    if (result.isError) {
      const msg = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n')
      throw new Error(msg || 'MCP tool returned an error')
    }

    const content = result.content as Array<{ type: string; text?: string; mimeType?: string; data?: string }>
    const text   = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
    const images = content
      .filter((c) => c.type === 'image' && c.data)
      .map((c) => ({ mimeType: c.mimeType ?? 'image/png', data: c.data! }))

    return { text, images, userNote }
  }

  private _runningEntry(serverName: string): ServerEntry & { client: Client } {
    const entry = this.servers.get(serverName)
    if (!entry || entry.status !== 'running' || !entry.client) {
      throw new Error(`MCP server "${serverName}" is not running`)
    }
    return entry as ServerEntry & { client: Client }
  }

  /**
   * Multi-agent workers never receive an MCP transport: Electron executes on
   * their behalf (spec §07, sandbox spec §04). Permission layers, in order:
   *   per-chat bypass-all → agent block → agent trust → per-chat session
   *   allow → [multi-agent requirePermissions default | per-server setting]
   * A local stdio server must run under an active SandboxService profile.
   */
  async callToolForMultiAgent(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
    ctx:        MultiAgentToolContext,
  ): Promise<McpToolResult> {
    const entry = this._runningEntry(serverName)
    if (!isHttpMcpConfig(entry.config) && (!entry.config.sandboxProfile || entry.config.sandboxProfile.bypassSandbox)) {
      throw new Error(`MCP server "${serverName}" has no active SandboxService profile for multi-agent execution`)
    }
    const perm = await this._authorizeForMultiAgent(serverName, toolName, args, ctx, !!entry.requiresApproval)

    const inFlight = this.activeMultiAgentWorkers.get(serverName) ?? new Map<string, number>()
    inFlight.set(ctx.agentId, (inFlight.get(ctx.agentId) ?? 0) + 1)
    this.activeMultiAgentWorkers.set(serverName, inFlight)
    try {
      return await this._executeTool(entry, toolName, args, perm.userNote)
    } finally {
      const left = (inFlight.get(ctx.agentId) ?? 1) - 1
      if (left > 0) inFlight.set(ctx.agentId, left)
      else inFlight.delete(ctx.agentId)
      if (inFlight.size === 0) this.activeMultiAgentWorkers.delete(serverName)
    }
  }

  /**
   * A built-in (Electron-side, non-MCP) tool requested by a worker: the same
   * permission layers as an MCP call, then `run` executes it. Built-ins need no
   * per-server approval, so only the multi-agent requirePermissions default prompts.
   */
  async callBuiltinForMultiAgent(
    toolName: string,
    args:     Record<string, unknown>,
    ctx:      MultiAgentToolContext,
    run:      () => Promise<string>,
  ): Promise<McpToolResult> {
    const perm = await this._authorizeForMultiAgent(BUILTIN_SERVER, toolName, args, ctx, false)
    return { text: await run(), images: [], userNote: perm.userNote }
  }

  /** Throws McpDeniedError unless a layer approves (order in callToolForMultiAgent's doc). */
  private async _authorizeForMultiAgent(
    serverName:       string,
    toolName:         string,
    args:             Record<string, unknown>,
    ctx:              MultiAgentToolContext,
    requiresApproval: boolean,
  ): Promise<{ approved: boolean; userNote: string }> {
    const trust = this.agentTrust.get(agentKey(ctx.runId, ctx.agentId))
    let perm: { approved: boolean; userNote: string }
    if (this.bypassAllPermissions) perm = { approved: true, userNote: '' }
    else if (trust === 'block') perm = { approved: false, userNote: `${ctx.role} is blocked for this run` }
    else if (trust === 'trust') perm = { approved: true, userNote: '' }
    else if (this.sessionAllowList.has(`${ctx.chatId}__${serverName}__${toolName}`)) perm = { approved: true, userNote: '' }
    else if (!ctx.requirePermissions && !requiresApproval) perm = { approved: true, userNote: '' }
    else {
      perm = await this._awaitPermissionDialog(serverName, toolName, args, ctx.chatId, {
        agent: { runId: ctx.runId, agentId: ctx.agentId, role: ctx.role, model: ctx.model },
        timeoutMs: ctx.hitlTimeoutMs,
      })
    }
    if (!perm.approved) throw new McpDeniedError(perm.userNote)
    return perm
  }

  /** Drop a finished run's agent trust decisions (they are run-scoped). */
  clearRunTrust(runId: string): void {
    for (const key of this.agentTrust.keys()) {
      if (key.startsWith(`${runId}\u0000`)) this.agentTrust.delete(key)
    }
  }

  /** Attach the in-flight worker id to an OS-observed MCP sandbox denial. */
  attributeMultiAgentViolation(violation: SandboxViolationTraceEvent): SandboxViolationTraceEvent {
    const prefix = 'mcp:'
    if (!violation.source.startsWith(prefix)) return violation
    const serverName = violation.source.slice(prefix.length)
    const agents = this.activeMultiAgentWorkers.get(serverName)
    if (!agents?.size) return violation
    // Concurrent calls to one server can't be told apart by the OS log; name all.
    return { ...violation, source: `multi-agent:${[...agents.keys()].sort().join('|')}:${violation.source}` }
  }

  // ── Permission resolution (called by IPC handler) ────────────

  resolvePermission(response: import('../../shared/types').McpToolPermissionResponse): void {
    const pending = this.pendingPermissions.get(response.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingPermissions.delete(response.requestId)
    if (pending.agentKey && response.agentTrust) {
      this.agentTrust.set(pending.agentKey, response.agentTrust)
      if (response.agentTrust === 'block') {
        pending.resolve({ approved: false, userNote: response.userNote })
        return
      }
    }
    if (response.approved && response.alwaysAllow === 'forever') {
      this._persistServerApprovalMode(pending.serverName, false)
      const entry = this.servers.get(pending.serverName)
      if (entry) entry.requiresApproval = false
    } else if (response.approved && response.alwaysAllow === 'session') {
      this.sessionAllowList.add(`${pending.chatId}__${pending.serverName}__${pending.toolName}`)
    }
    pending.resolve({ approved: response.approved, userNote: response.userNote })
  }

  setBypassPermissions(bypass: boolean): void {
    this.bypassAllPermissions = bypass
  }

  setServerApprovalMode(serverName: string, requiresApproval: boolean): void {
    const entry = this.servers.get(serverName)
    if (entry) entry.requiresApproval = requiresApproval
    this._persistServerApprovalMode(serverName, requiresApproval)
  }

  drainPendingPermissions(): void {
    for (const [id, pending] of this.pendingPermissions.entries()) {
      clearTimeout(pending.timer)
      pending.resolve({ approved: false, userNote: '' })
      this.pendingPermissions.delete(id)
    }
  }

  // ── Private: start one server ────────────────────────────────

  private async _startServer(
    name:   string,
    config: McpServerConfig & { enabled: boolean },
  ): Promise<void> {
    if (!config.enabled) {
      this.servers.set(name, {
        name, config, client: null,
        status: 'stopped', tools: [], schemas: [], error: undefined,
        requiresApproval: config.requiresApproval ?? true,
      })
      return
    }

    const entry: ServerEntry = {
      name, config, client: null,
      status: 'starting', tools: [], schemas: [], error: undefined,
      requiresApproval: config.requiresApproval ?? true,
    }
    this.servers.set(name, entry)
    this._emitStatus(name)

    try {
      // ── Security: validate config before connecting ───────────────
      if (isHttpMcpConfig(config)) {
        // Enforce HTTPS-only for remote endpoints to prevent credential leakage
        // over plain HTTP. localhost is allowed for local dev servers.
        const parsed = new URL(config.url)
        const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
        if (!isLocal && parsed.protocol !== 'https:') {
          throw new Error(
            `HTTP MCP servers must use HTTPS (got "${parsed.protocol}"). ` +
            `Plain HTTP is only permitted for localhost.`
          )
        }
        // Reject URLs with credentials embedded in them (e.g. http://user:pass@host)
        if (parsed.username || parsed.password) {
          throw new Error(
            'Credentials must not be embedded in the URL. Use the Authorization header instead.'
          )
        }
      }

      // ── Build transport ───────────────────────────────────────────
      // Only the stdio branch spawns a local process — HTTP servers have no
      // local process to sandbox and are already covered by the HTTPS +
      // credential validation above.
      let transport: StreamableHTTPClientTransport | StdioClientTransport
      if (isHttpMcpConfig(config)) {
        transport = new StreamableHTTPClientTransport(
          new URL(config.url),
          {
            requestInit: {
              headers: config.headers ?? {},
            },
          }
        )
      } else {
        const sandboxProfile = config.sandboxProfile
        if (!sandboxProfile) {
          // Spec section 10/16: the user reviews a server's requested domains
          // and writable paths before it is first allowed to run. No profile
          // = not reviewed = fail closed (never silently unsandboxed).
          throw new Error(SANDBOX_REVIEW_REQUIRED)
        }
        if (sandboxProfile.bypassSandbox === true) {
          // Visible every start — not a one-time warning — so an operator
          // scanning logs after the fact can't miss that this server has
          // unrestricted filesystem/network access on the host.
          console.warn(`[McpServerManager] ⚠️ "${name}" running WITHOUT sandbox — bypassSandbox: true`)
          transport = new StdioClientTransport({
            command: config.command,
            args:    config.args ?? [],
            env:     { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
          })
        } else {
          // Never hand-roll shell escaping (spec section 08) — shell-quote
          // is the vetted library for joining command + args into one string.
          const joinedCommand = quote([config.command, ...(config.args ?? [])])
          const scratchDir = join(app.getPath('userData'), 'sandboxes', 'mcp', name)
          mkdirSync(scratchDir, { recursive: true })

          const wrapped = await sandboxService.wrapStdioCommand({
            workspaceDir:     scratchDir,
            command:          joinedCommand,
            executionProfile: 'lightweight',
            allowedDomains:   sandboxProfile.allowedDomains,
            allowWrite:       sandboxProfile.allowWrite,
            denyRead:         [],
            callerLabel:      `mcp:${name}`,
            timeoutMs:        0, // persistent process, no wall-clock timeout
            maxRssMb:         MCP_SERVER_MAX_RSS_MB,
          })
          entry.releaseSandbox = wrapped.release

          // wrapped.env carries the sandbox's own env; config.env entries
          // (server-specific vars the user configured, e.g. API keys) must
          // still reach the process, so they're merged on top. npm's cache
          // is pointed into the (writable) scratch dir so `npx` servers work
          // under deny-write-by-default; a user-set value still wins.
          transport = new StdioClientTransport({
            command: wrapped.command,
            args:    wrapped.args,
            cwd:     scratchDir,
            env:     {
              ...wrapped.env,
              npm_config_cache: join(scratchDir, '.npm-cache'),
              ...(config.env ?? {}),
            } as Record<string, string>,
          })
        }
      }

      const client = new Client(
        { name: 'desktop-intelligence', version: '1.0.0' },
        { capabilities: {} },
      )

      await this._withTimeout(
        client.connect(transport),
        10_000,
        `Server "${name}" did not connect within 10 s`,
      )

      entry.client = client
      // The process can exit on its own (crash) — drop its sandbox lease then too.
      client.onclose = () => entry.releaseSandbox?.()

      // ── ResourceGovernor: RSS watchdog for the stdio child ────────────
      // StdioClientTransport does not expose the underlying ChildProcess
      // (it's a private field), but it does expose a public `.pid` getter
      // once started — which is all memoryWatch() needs. Only stdio
      // transports have a pid; HTTP servers have no local process.
      if (!isHttpMcpConfig(config)) {
        const stdioTransport = transport as StdioClientTransport
        const pid = stdioTransport.pid
        if (pid) {
          entry.stopMemoryWatch = memoryWatch(pid, MCP_SERVER_MAX_RSS_MB, () => {
            console.warn(
              `[McpServerManager] ⚠️ "${name}" RSS exceeded ${MCP_SERVER_MAX_RSS_MB} MB — stopping server`
            )
            entry.error = `Process exceeded ${MCP_SERVER_MAX_RSS_MB} MB RSS and was stopped automatically`
            this._stopServer(name).catch((err) => {
              console.error(`[McpServerManager] Failed to stop "${name}" after RSS exceeded:`, err)
            })
          })
        }
      }

      const { tools } = await this._withTimeout(
        client.listTools(),
        10_000,
        `Server "${name}" did not respond to tools/list within 10 s`,
      )

      // ── Meta-MCP detection ─────────────────────────────────────────
      // Some MCP servers (e.g. AlphaVantage) expose a generic proxy layer:
      // TOOL_LIST (discover available tools), TOOL_GET (get schema), TOOL_CALL
      // (invoke a tool). The model would normally waste a full round-trip
      // calling TOOL_LIST before it can do anything useful.
      //
      // Detection: if TOOL_LIST is among the discovered tools, we call it
      // eagerly at startup, expand the real tool schemas, and present them
      // directly to the model. callTool() translates back to TOOL_CALL.
      const isMetaMcp = tools.some((t) => t.name === 'TOOL_LIST')

      if (isMetaMcp) {
        console.log(`[McpServerManager] 🔍 "${name}" is a meta-MCP — eagerly resolving TOOL_LIST`)
        try {
          // Read TOOL_CALL's inputSchema to learn what parameter keys it expects.
          // This is the only server-agnostic way — we never hardcode key names.
          const toolCallDef = tools.find((t) => t.name === 'TOOL_CALL')
          const toolCallSchema = (toolCallDef?.inputSchema ?? {}) as {
            properties?: Record<string, unknown>
          }
          const schemaKeys = Object.keys(toolCallSchema.properties ?? {})
          // Heuristic: the tool-name key is the property whose name contains
          // 'tool' or 'name' (but not 'arg'); the arguments key contains 'arg'.
          // Fall back to first/second key if naming is non-standard.
          const toolNameKey =
            schemaKeys.find((k) => /tool|name/i.test(k) && !/arg/i.test(k)) ??
            schemaKeys[0] ??
            'tool_name'
          const argumentsKey =
            schemaKeys.find((k) => /arg/i.test(k)) ??
            schemaKeys[1] ??
            'arguments'
          console.log(`[McpServerManager] 🔑 "${name}" TOOL_CALL keys: toolNameKey="${toolNameKey}" argumentsKey="${argumentsKey}"`)

          const listResult = await this._withTimeout(
            entry.client!.callTool({ name: 'TOOL_LIST', arguments: {} }),
            10_000,
            `Server "${name}" TOOL_LIST did not respond within 10 s`,
          )
          // TOOL_LIST returns text content — parse it as JSON
          const rawText = (listResult.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('')
          const toolDefs = JSON.parse(rawText) as Array<{
            name:        string
            description?: string
            inputSchema?: unknown
          }>

          const metaToolMap = new Map<string, string>()
          entry.tools = toolDefs.map((t) => t.name)

          // Resolve schemas sequentially so TOOL_GET fallbacks don't race.
          const resolvedSchemas: LMStudioTool[] = []
          for (const t of toolDefs) {
            metaToolMap.set(t.name, 'TOOL_CALL')
            const resolvedSchema = await this._resolveInputSchema(entry.client!, t.name, t.inputSchema)
            resolvedSchemas.push(this._mapToolSchema(name, { ...t, inputSchema: resolvedSchema }))
          }
          entry.schemas      = resolvedSchemas
          entry.metaToolMap  = metaToolMap
          entry.metaCallKeys = { toolNameKey, argumentsKey }
          console.log(`[McpServerManager] ✅ "${name}" meta-MCP expanded — tools: ${entry.tools.join(', ')}`)
        } catch (err) {
          // TOOL_LIST failed — fall back to exposing the raw meta tools so the
          // server is still usable (just with the extra round-trip at runtime).
          console.warn(`[McpServerManager] ⚠️ "${name}" TOOL_LIST failed, falling back to raw tools:`, err)
          entry.tools   = tools.map((t) => t.name)
          entry.schemas = tools.map((t) => this._mapToolSchema(name, t))
        }
      } else {
        entry.tools   = tools.map((t) => t.name)
        entry.schemas = tools.map((t) => this._mapToolSchema(name, t))
      }

      entry.status  = 'running'
      entry.error   = undefined

      console.log(`[McpServerManager] ✅ "${name}" running — tools: ${entry.tools.join(', ') || '(none)'}`)
    } catch (err) {
      try { await entry.client?.close() } catch { /* ignore */ }
      entry.client = null
      entry.releaseSandbox?.()
      entry.releaseSandbox = undefined
      entry.status = 'error'
      entry.error  = err instanceof Error ? err.message : String(err)
      console.error(`[McpServerManager] ❌ "${name}" failed to start:`, entry.error)
    }

    this._emitStatus(name)
  }

  private async _stopServer(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return
    if (entry.stopMemoryWatch) {
      entry.stopMemoryWatch()
      entry.stopMemoryWatch = undefined
    }
    try {
      await entry.client?.close()
    } catch { /* ignore */ }
    entry.releaseSandbox?.()
    entry.releaseSandbox = undefined
    entry.client  = null
    entry.status  = 'stopped'
    entry.tools   = []
    entry.schemas = []
    this._emitStatus(name)
  }

  // ── Private: permission request ──────────────────────────────

  protected async _requestPermission(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
    chatId:     string,
  ): Promise<{ approved: boolean; userNote: string }> {
    if (this.bypassAllPermissions) return { approved: true, userNote: '' }
    const entry = this.servers.get(serverName)
    if (!entry?.requiresApproval) return { approved: true, userNote: '' }
    const sessionKey = `${chatId}__${serverName}__${toolName}`
    if (this.sessionAllowList.has(sessionKey)) return { approved: true, userNote: '' }
    return this._awaitPermissionDialog(serverName, toolName, args, chatId)
  }

  async _awaitPermissionDialog(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
    chatId:     string,
    options:    { agent?: McpToolPermissionRequest['agent']; timeoutMs?: number } = {},
  ): Promise<{ approved: boolean; userNote: string }> {
    const requestId = randomUUID()
    const timeoutMs = options.timeoutMs ?? PERMISSION_TIMEOUT_MS
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId)
        this.emit('permissionExpired', requestId)
        // Agents get a reason they can act on; single-model keeps its silent deny.
        resolve({ approved: false, userNote: options.agent ? 'Approval timed out' : '' })
      }, timeoutMs)
      this.pendingPermissions.set(requestId, {
        serverName,
        toolName,
        chatId,
        agentKey: options.agent ? agentKey(options.agent.runId, options.agent.agentId) : undefined,
        resolve,
        timer,
      })
      const request: McpToolPermissionRequest = {
        serverName, toolName, args, requestId, chatId,
        ...(options.agent ? { agent: options.agent } : {}),
        timeoutMs,
      }
      this.emit('permissionRequest', request)
    })
  }

  /** Deny every pending dialog raised for one multi-agent run (it ended). */
  cancelRunPermissions(runId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (!pending.agentKey?.startsWith(`${runId}\u0000`)) continue
      clearTimeout(pending.timer)
      this.pendingPermissions.delete(requestId)
      this.emit('permissionExpired', requestId)
      pending.resolve({ approved: false, userNote: 'Run ended' })
    }
  }

  // ── Private: schema mapping ──────────────────────────────────

  private async _resolveInputSchema(
    client: Client,
    toolName: string,
    rawSchema: unknown,
  ): Promise<{ type: string; properties?: Record<string, unknown>; required?: string[] }> {
    const empty = { type: 'object', properties: {} as Record<string, unknown>, required: [] as string[] }

    // Case (b): JSON string — parse it
    if (typeof rawSchema === 'string' && rawSchema.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(rawSchema)
        if (typeof parsed === 'object' && parsed !== null) return parsed as typeof empty
      } catch (err) {
        console.warn(`[McpServerManager] ⚠️ inputSchema string parse failed for "${toolName}":`, err)
      }
      return empty
    }

    // Case (a): already a real object with at least one property
    if (
      typeof rawSchema === 'object' &&
      rawSchema !== null &&
      typeof (rawSchema as Record<string, unknown>).type === 'string'
    ) {
      return rawSchema as typeof empty
    }

    // Case (c): missing / null / empty — try TOOL_GET
    try {
      const result = await this._withTimeout(
        client.callTool({ name: 'TOOL_GET', arguments: { tool_name: toolName } }),
        8_000,
        `TOOL_GET for "${toolName}" timed out`,
      )
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')
      const parsed = JSON.parse(text)
      // TOOL_GET may return the full tool definition or just the schema —
      // handle both shapes.
      const schema = parsed?.inputSchema ?? parsed?.parameters ?? parsed
      if (typeof schema === 'string') return JSON.parse(schema) as typeof empty
      if (typeof schema === 'object' && schema !== null) return schema as typeof empty
    } catch (err) {
      console.warn(`[McpServerManager] ⚠️ TOOL_GET fallback failed for "${toolName}":`, err)
    }

    return empty
  }

  private _mapToolSchema(
    serverName: string,
    tool: { name: string; description?: string; inputSchema?: unknown },
  ): LMStudioTool {
    // inputSchema is guaranteed to be a resolved object by the call site —
    // either from TOOL_LIST (already parsed) or from TOOL_GET fallback.
    // The null-coalesce is a last-resort guard only.
    const schema = (
      typeof tool.inputSchema === 'object' && tool.inputSchema !== null
        ? tool.inputSchema
        : { type: 'object', properties: {}, required: [] }
    ) as { type: string; properties?: Record<string, unknown>; required?: string[] }

    return {
      type: 'function',
      function: {
        name:        `${serverName}__${tool.name}`,
        description: tool.description ?? `Tool "${tool.name}" from MCP server "${serverName}"`,
        parameters:  {
          type:       'object',
          properties: (schema.properties ?? {}) as Record<string, LMStudioToolParam>,
          required:   schema.required ?? [],
        },
      },
    }
  }

  // ── Private: timeout wrapper ─────────────────────────────────

  private _withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(msg)), ms)
      promise.then(
        (v) => { clearTimeout(timer); resolve(v) },
        (e) => { clearTimeout(timer); reject(e) },
      )
    })
  }

  // ── Private: emit status changed ────────────────────────────

  private _emitStatus(name: string): void {
    const entry = this.servers.get(name)
    if (!entry) return
    this.emit('statusChanged', {
      name:             entry.name,
      status:           entry.status,
      tools:            entry.tools,
      error:            entry.error,
      disabledTools:    entry.config.disabledTools ?? [],
      requiresApproval: entry.requiresApproval,
      needsSandboxReview: needsSandboxReview(entry.config),
    } as McpServerRuntimeInfo)
  }

  private _persistServerApprovalMode(serverName: string, requiresApproval: boolean): void {
    this.readConfig().then((config) => {
      if (config[serverName]) {
        config[serverName].requiresApproval = requiresApproval
        this.writeConfig(config).catch((err) =>
          console.error('[McpServerManager] Failed to persist approval mode:', err)
        )
      }
    }).catch(() => {})
  }
}

export const mcpServerManager = new McpServerManager()

export class McpServerManagerTestable extends McpServerManager {
  // Override configPath so tests never touch the real mcp.json on disk
  protected configPath(): string { return '' }

  // Seed a fake running server entry for tests — no real process or client
  seedServer(name: string, opts: { requiresApproval?: boolean }): void {
    (this as unknown as { servers: Map<string, unknown> }).servers.set(name, {
      name,
      config: { command: 'test', enabled: true, requiresApproval: opts.requiresApproval ?? true },
      client: null,
      status: 'running',
      tools: [],
      schemas: [],
      error: undefined,
      requiresApproval: opts.requiresApproval ?? true,
    })
  }

  // Queue a response for the next _awaitPermissionDialog call
  private _nextDialogResponse: {
    approved:    boolean
    alwaysAllow?: 'session' | 'forever' | false
    userNote:    string
  } | null = null

  mockNextDialogResponse(r: {
    approved:    boolean
    alwaysAllow?: 'session' | 'forever' | false
    userNote:    string
  }): void {
    this._nextDialogResponse = r
  }

  // Override dialog to return the mocked response synchronously
  async _awaitPermissionDialog(
    serverName: string,
    toolName:   string,
    _args:      Record<string, unknown>,
    chatId:     string,
  ): Promise<{ approved: boolean; userNote: string }> {
    const r = this._nextDialogResponse ?? { approved: false, userNote: '' }
    this._nextDialogResponse = null
    if (r.approved && r.alwaysAllow === 'forever') {
      const entry = (this as unknown as { servers: Map<string, { requiresApproval: boolean }> }).servers.get(serverName)
      if (entry) entry.requiresApproval = false
    } else if (r.approved && r.alwaysAllow === 'session') {
      this.getSessionAllowList().add(`${chatId}__${serverName}__${toolName}`)
    }
    return { approved: r.approved, userNote: r.userNote }
  }

  // Expose _requestPermission for direct testing
  async testRequestPermission(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
    chatId:     string,
  ): Promise<{ approved: boolean; userNote: string }> {
    return this._requestPermission(serverName, toolName, args, chatId)
  }

  // Accessors for private state
  getBypassFlag(): boolean {
    return (this as unknown as { bypassAllPermissions: boolean }).bypassAllPermissions
  }
  getSessionAllowList(): Set<string> {
    return (this as unknown as { sessionAllowList: Set<string> }).sessionAllowList
  }
  getServerRequiresApproval(name: string): boolean {
    return (this as unknown as { servers: Map<string, { requiresApproval: boolean }> }).servers.get(name)?.requiresApproval ?? true
  }
  getPendingCount(): number {
    return (this as unknown as { pendingPermissions: Map<string, unknown> }).pendingPermissions.size
  }
}
