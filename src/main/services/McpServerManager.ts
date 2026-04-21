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
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type {
  McpServerConfig,
  McpServerSettings,
  McpServerRuntimeInfo,
} from '../../shared/types'

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
}

// ── Permission promise map ────────────────────────────────────────

interface PendingPermission {
  serverName: string
  resolve:    (approved: boolean) => void
  timer:      ReturnType<typeof setTimeout>
}

// ── McpServerManager ─────────────────────────────────────────────

export class McpServerManager extends EventEmitter {
  private servers            = new Map<string, ServerEntry>()
  private pendingPermissions = new Map<string, PendingPermission>()

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
      name:   e.name,
      status: e.status,
      tools:  e.tools,
      error:  e.error,
    }))
  }

  getToolSchemas(): LMStudioTool[] {
    const result: LMStudioTool[] = []
    for (const entry of this.servers.values()) {
      if (entry.status === 'running') {
        result.push(...entry.schemas)
      }
    }
    return result
  }

  // ── Tool call dispatch ────────────────────────────────────────

  async callTool(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
  ): Promise<string> {
    const entry = this.servers.get(serverName)
    if (!entry || entry.status !== 'running' || !entry.client) {
      throw new Error(`MCP server "${serverName}" is not running`)
    }

    // Permission check
    if (entry.requiresApproval) {
      const approved = await this._requestPermission(serverName, toolName, args)
      if (!approved) throw new Error('Tool call denied by user')
    }

    // Meta-MCP translation: if this server uses a TOOL_LIST/TOOL_CALL proxy
    // layer, the model was given expanded tool names (e.g. "TIME_SERIES_DAILY").
    // We must translate back to the real executor ("TOOL_CALL") and pass the
    // logical tool name as an argument so the server knows what to invoke.
    let resolvedToolName = toolName
    let resolvedArgs     = args
    if (entry.metaToolMap?.has(toolName)) {
      resolvedToolName = entry.metaToolMap.get(toolName)! // always 'TOOL_CALL'
      resolvedArgs     = { tool_name: toolName, ...args }
    }

    const result = await entry.client.callTool({ name: resolvedToolName, arguments: resolvedArgs })

    if (result.isError) {
      const msg = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n')
      throw new Error(msg || 'MCP tool returned an error')
    }

    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')

    return text
  }

  // ── Permission resolution (called by IPC handler) ────────────

  resolvePermission(requestId: string, approved: boolean, alwaysAllow: boolean): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingPermissions.delete(requestId)

    if (alwaysAllow) {
      const entry = this.servers.get(pending.serverName)
      if (entry) entry.requiresApproval = false
    }

    pending.resolve(approved)
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
        requiresApproval: false,
      })
      return
    }

    const entry: ServerEntry = {
      name, config, client: null,
      status: 'starting', tools: [], schemas: [], error: undefined,
      requiresApproval: false,  // permission dialog not yet implemented — allow all calls
    }
    this.servers.set(name, entry)
    this._emitStatus(name)

    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args:    config.args ?? [],
        env:     { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
      })

      const client = new Client(
        { name: 'desktop-intelligence', version: '1.0.0' },
        { capabilities: { tools: {} } },
      )

      await this._withTimeout(
        client.connect(transport),
        10_000,
        `Server "${name}" did not connect within 10 s`,
      )

      entry.client = client

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
          entry.tools   = toolDefs.map((t) => t.name)
          entry.schemas = toolDefs.map((t) => {
            metaToolMap.set(t.name, 'TOOL_CALL')
            return this._mapToolSchema(name, t)
          })
          entry.metaToolMap = metaToolMap
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
      entry.status = 'error'
      entry.error  = err instanceof Error ? err.message : String(err)
      console.error(`[McpServerManager] ❌ "${name}" failed to start:`, entry.error)
    }

    this._emitStatus(name)
  }

  private async _stopServer(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return
    try {
      await entry.client?.close()
    } catch { /* ignore */ }
    entry.client  = null
    entry.status  = 'stopped'
    entry.tools   = []
    entry.schemas = []
    this._emitStatus(name)
  }

  // ── Private: permission request ──────────────────────────────

  private _requestPermission(
    serverName: string,
    toolName:   string,
    args:       Record<string, unknown>,
  ): Promise<boolean> {
    const requestId = randomUUID()

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId)
        resolve(false) // timeout = implicit denial
      }, 60_000)

      this.pendingPermissions.set(requestId, { serverName, resolve, timer })

      // The handlers.ts listener on 'permissionRequest' forwards this to the renderer
      this.emit('permissionRequest', { serverName, toolName, args, requestId })
    })
  }

  // ── Private: schema mapping ──────────────────────────────────

  private _mapToolSchema(
    serverName: string,
    tool: { name: string; description?: string; inputSchema?: unknown },
  ): LMStudioTool {
    const schema = (tool.inputSchema ?? { type: 'object', properties: {}, required: [] }) as {
      type:        string
      properties?: Record<string, unknown>
      required?:   string[]
    }

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
      name:   entry.name,
      status: entry.status,
      tools:  entry.tools,
      error:  entry.error,
    } as McpServerRuntimeInfo)
  }
}

export const mcpServerManager = new McpServerManager()
