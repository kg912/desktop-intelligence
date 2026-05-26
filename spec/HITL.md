# HITL Implementation — Claude Code Prompts

This file contains ready-to-paste prompts for Claude Code, in execution order.
Run them one at a time. Each prompt is self-contained — read the file(s), make
the changes, stop. Do not combine prompts.

---

## PROMPT 1 — Types and IPC channels

> Paste this into Claude Code first. It touches only `shared/types.ts` and has
> no dependencies on anything else.

```
Read src/shared/types.ts in full.

Make the following additions. Do not modify any existing types or values.

1. Add this interface after the existing McpToolPermissionRequest interface:

   export interface McpToolPermissionResponse {
     requestId:   string
     approved:    boolean
     alwaysAllow: 'session' | 'forever' | false
     userNote:    string
   }

2. In the IPC_CHANNELS object, add these four entries alongside the existing
   MCP_TOOL_PERMISSION_REQUEST and MCP_TOOL_PERMISSION_RESPONSE entries:

   MCP_BYPASS_PERMISSIONS_CHANGED: 'mcp:bypassPermissionsChanged',
   MCP_SET_SERVER_APPROVAL_MODE:   'mcp:setServerApprovalMode',

3. The existing McpServerConfig union types (StdioMcpServerConfig and
   HttpMcpServerConfig) both already have `disabledTools?: string[]`.
   Add `requiresApproval?: boolean` to both of them, directly after
   `disabledTools?: string[]`.

Do not change anything else. Do not reformat the file.
```

---

## PROMPT 2 — Write the test files (TDD — do this before implementing)

> These tests define the contract. Write them now so Claude Code can run them
> against the implementation in Prompt 3 and Prompt 4.

```
Create the directory src/tests/hitl/ if it does not exist.
Create the following six files exactly as specified. Use vitest syntax
(describe/it/expect/vi.fn). Do not implement any production code.

--- FILE: src/tests/hitl/McpDeniedError.test.ts ---

import { describe, it, expect } from 'vitest'
import { McpDeniedError } from '../../main/services/McpServerManager'

describe('McpDeniedError', () => {
  it('is instanceof Error', () => {
    expect(new McpDeniedError('')).toBeInstanceOf(Error)
  })
  it('has name McpDeniedError', () => {
    expect(new McpDeniedError('').name).toBe('McpDeniedError')
  })
  it('carries the userNote string', () => {
    expect(new McpDeniedError('stop this').userNote).toBe('stop this')
  })
  it('userNote is empty string when constructed with empty string', () => {
    expect(new McpDeniedError('').userNote).toBe('')
  })
})

--- FILE: src/tests/hitl/toolResultInjection.test.ts ---

import { describe, it, expect } from 'vitest'
import { buildDeniedToolMessage, buildApprovedToolResult } from '../../main/services/McpServerManager'

describe('buildApprovedToolResult', () => {
  it('prepends user note when note is non-empty', () => {
    const result = buildApprovedToolResult('tool output', 'use /tmp instead')
    expect(result).toBe('[User note: "use /tmp instead"]\n\ntool output')
  })
  it('returns raw result when note is empty string', () => {
    expect(buildApprovedToolResult('tool output', '')).toBe('tool output')
  })
})

describe('buildDeniedToolMessage', () => {
  it('includes base denial text when note is empty', () => {
    const msg = buildDeniedToolMessage('')
    expect(msg).toContain('Tool call denied by user.')
    expect(msg).toContain('Do not attempt this tool call again')
  })
  it('includes user reason line when note is non-empty', () => {
    const msg = buildDeniedToolMessage('wrong repo')
    expect(msg).toContain('User reason: "wrong repo"')
  })
  it('does not include User reason line when note is empty', () => {
    expect(buildDeniedToolMessage('')).not.toContain('User reason')
  })
})

--- FILE: src/tests/hitl/McpServerManager.permission.test.ts ---

import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test the permission logic via a testable subclass that exposes internals
// and replaces _awaitPermissionDialog with a controllable mock.
import { McpServerManagerTestable } from '../../main/services/McpServerManager'

describe('bypass flag', () => {
  it('is false on fresh instantiation', () => {
    const m = new McpServerManagerTestable()
    expect(m.getBypassFlag()).toBe(false)
  })
  it('auto-approves without emitting dialog when bypass=true', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.setBypassPermissions(true)
    const dialogSpy = vi.spyOn(m, '_awaitPermissionDialog')
    const result = await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(result.approved).toBe(true)
    expect(dialogSpy).not.toHaveBeenCalled()
  })
  it('re-gates after setBypassPermissions(false)', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.setBypassPermissions(true)
    m.setBypassPermissions(false)
    m.mockNextDialogResponse({ approved: false, userNote: '' })
    const result = await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(result.approved).toBe(false)
  })
})

describe('server requiresApproval flag', () => {
  it('auto-approves without dialog when requiresApproval=false', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: false })
    const dialogSpy = vi.spyOn(m, '_awaitPermissionDialog')
    const result = await m.testRequestPermission('srv', 'read_file', {}, 'chat1')
    expect(result.approved).toBe(true)
    expect(dialogSpy).not.toHaveBeenCalled()
  })
  it('triggers dialog when requiresApproval=true', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.mockNextDialogResponse({ approved: true, userNote: '' })
    const dialogSpy = vi.spyOn(m, '_awaitPermissionDialog')
    await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(dialogSpy).toHaveBeenCalledOnce()
  })
  it('alwaysAllow=forever sets requiresApproval=false in-memory', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.mockNextDialogResponse({ approved: true, alwaysAllow: 'forever', userNote: '' })
    await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(m.getServerRequiresApproval('srv')).toBe(false)
  })
  it('alwaysAllow=session adds compound key to sessionAllowList, does not change requiresApproval', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.mockNextDialogResponse({ approved: true, alwaysAllow: 'session', userNote: '' })
    await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(m.getSessionAllowList().has('chat1__srv__write_file')).toBe(true)
    expect(m.getServerRequiresApproval('srv')).toBe(true)
  })
  it('sessionAllowList is empty on fresh instantiation', () => {
    const m = new McpServerManagerTestable()
    expect(m.getSessionAllowList().size).toBe(0)
  })
})

describe('session allow list', () => {
  it('auto-approves on second call for same chatId+server+tool after session approval', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.mockNextDialogResponse({ approved: true, alwaysAllow: 'session', userNote: '' })
    await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    const dialogSpy = vi.spyOn(m, '_awaitPermissionDialog')
    const result = await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    expect(result.approved).toBe(true)
    expect(dialogSpy).not.toHaveBeenCalled()
  })
  it('still gates on second call for different chatId', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.mockNextDialogResponse({ approved: true, alwaysAllow: 'session', userNote: '' })
    await m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    m.mockNextDialogResponse({ approved: false, userNote: '' })
    const result = await m.testRequestPermission('srv', 'write_file', {}, 'chat2')
    expect(result.approved).toBe(false)
  })
})

describe('drainPendingPermissions', () => {
  it('resolves all pending promises with approved=false', async () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    // Do not mock dialog response — leaves promise pending
    const pending = m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    m.drainPendingPermissions()
    const result = await pending
    expect(result.approved).toBe(false)
  })
  it('clears the pendingPermissions map', () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.testRequestPermission('srv', 'write_file', {}, 'chat1')
    m.drainPendingPermissions()
    expect(m.getPendingCount()).toBe(0)
  })
  it('is safe to call when map is empty', () => {
    const m = new McpServerManagerTestable()
    expect(() => m.drainPendingPermissions()).not.toThrow()
  })
})

describe('resolvePermission', () => {
  it('is a no-op for unknown requestId', () => {
    const m = new McpServerManagerTestable()
    expect(() =>
      m.resolvePermission({ requestId: 'unknown', approved: true, alwaysAllow: false, userNote: '' })
    ).not.toThrow()
  })
})

--- FILE: src/tests/hitl/serverApprovalMode.test.ts ---

import { describe, it, expect } from 'vitest'
import { McpServerManagerTestable } from '../../main/services/McpServerManager'

describe('per-server approval mode', () => {
  it('defaults to requiresApproval=true when field absent in config', () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', {})
    expect(m.getServerRequiresApproval('srv')).toBe(true)
  })
  it('respects requiresApproval=false when explicitly set', () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: false })
    expect(m.getServerRequiresApproval('srv')).toBe(false)
  })
  it('setServerApprovalMode updates in-memory entry immediately', () => {
    const m = new McpServerManagerTestable()
    m.seedServer('srv', { requiresApproval: true })
    m.setServerApprovalMode('srv', false)
    expect(m.getServerRequiresApproval('srv')).toBe(false)
  })
})

--- FILE: src/tests/hitl/bypassToggle.test.tsx ---

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BypassPermissionsButton } from '../../renderer/src/components/layout/InputBar'

describe('BypassPermissionsButton', () => {
  it('renders in off state by default', () => {
    render(<BypassPermissionsButton active={false} onToggle={vi.fn()} />)
    expect(screen.getByText('Permissions')).toBeTruthy()
  })
  it('shows Bypassed label when active=true', () => {
    render(<BypassPermissionsButton active={true} onToggle={vi.fn()} />)
    expect(screen.getByText('Bypassed')).toBeTruthy()
  })
  it('calls onToggle with true when clicked in off state', () => {
    const onToggle = vi.fn()
    render(<BypassPermissionsButton active={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledWith(true)
  })
  it('calls onToggle with false when clicked in active state', () => {
    const onToggle = vi.fn()
    render(<BypassPermissionsButton active={true} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledWith(false)
  })
})

--- FILE: src/tests/hitl/ToolPermissionDialog.test.tsx ---

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolPermissionDialog } from '../../renderer/src/components/chat/ToolPermissionDialog'
import type { McpToolPermissionRequest } from '../../shared/types'

const req: McpToolPermissionRequest = {
  requestId:  'req-1',
  serverName: 'filesystem',
  toolName:   'write_file',
  args:       { path: '/tmp/test.txt', content: 'hello' },
  chatId:     'chat-abc',
}

describe('ToolPermissionDialog rendering', () => {
  it('renders server name and un-namespaced tool name', () => {
    render(<ToolPermissionDialog request={req} onRespond={vi.fn()} />)
    expect(screen.getByText('filesystem')).toBeTruthy()
    expect(screen.getByText('write_file')).toBeTruthy()
  })
  it('renders Deny, Allow this session, Allow buttons', () => {
    render(<ToolPermissionDialog request={req} onRespond={vi.fn()} />)
    expect(screen.getByText('Deny')).toBeTruthy()
    expect(screen.getByText('Allow this session')).toBeTruthy()
    expect(screen.getByText('Allow')).toBeTruthy()
  })
  it('shows collapsed args block by default', () => {
    render(<ToolPermissionDialog request={req} onRespond={vi.fn()} />)
    // Args section is present but collapsed — show-more button visible
    expect(screen.getByTestId('args-toggle')).toBeTruthy()
  })
})

describe('ToolPermissionDialog button actions', () => {
  it('Deny sends approved=false, alwaysAllow=false, userNote empty', () => {
    const onRespond = vi.fn()
    render(<ToolPermissionDialog request={req} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Deny'))
    expect(onRespond).toHaveBeenCalledWith({
      requestId: 'req-1', approved: false, alwaysAllow: false, userNote: ''
    })
  })
  it('Deny with typed note sends the note', () => {
    const onRespond = vi.fn()
    render(<ToolPermissionDialog request={req} onRespond={onRespond} />)
    fireEvent.change(screen.getByPlaceholderText('Optional: add context or reason...'), {
      target: { value: 'wrong repo' }
    })
    fireEvent.click(screen.getByText('Deny'))
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ approved: false, userNote: 'wrong repo' })
    )
  })
  it('Allow sends approved=true, alwaysAllow=false', () => {
    const onRespond = vi.fn()
    render(<ToolPermissionDialog request={req} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Allow'))
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ approved: true, alwaysAllow: false })
    )
  })
  it('Allow this session sends approved=true, alwaysAllow=session', () => {
    const onRespond = vi.fn()
    render(<ToolPermissionDialog request={req} onRespond={onRespond} />)
    fireEvent.click(screen.getByText('Allow this session'))
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ approved: true, alwaysAllow: 'session' })
    )
  })
})
```

---

## PROMPT 3 — McpServerManager: permission logic

> This is the largest single change. Run this after the test files exist.

```
Read src/main/services/McpServerManager.ts in full.
Read src/shared/types.ts in full.
Read src/tests/hitl/McpServerManager.permission.test.ts in full.
Read src/tests/hitl/McpDeniedError.test.ts in full.
Read src/tests/hitl/toolResultInjection.test.ts in full.
Read src/tests/hitl/serverApprovalMode.test.ts in full.

Make the following changes to McpServerManager.ts. Do not touch any other file.
Do not refactor unrelated code. All tests in the test files above must pass.

1. Export a new error class at the top of the file (after imports):

   export class McpDeniedError extends Error {
     constructor(public readonly userNote: string) {
       super('Tool call denied by user')
       this.name = 'McpDeniedError'
     }
   }

2. Export two pure helper functions (used by ChatService and tested directly):

   export function buildApprovedToolResult(result: string, userNote: string): string {
     if (!userNote) return result
     return `[User note: "${userNote}"]\n\n${result}`
   }

   export function buildDeniedToolMessage(userNote: string): string {
     const reasonLine = userNote ? `\nUser reason: "${userNote}"` : ''
     return `Tool call denied by user.${reasonLine}\nDo not attempt this tool call again in this conversation.`
   }

3. Add these three private fields to the McpServerManager class, after the
   existing `pendingPermissions` map declaration:

   private sessionAllowList    = new Set<string>()
   private bypassAllPermissions = false

4. In the existing ServerEntry interface, change:
     requiresApproval: boolean
   to keep it, but ensure it defaults to true when constructed. In _startServer,
   when creating the entry object, set requiresApproval to:
     config.requiresApproval ?? true

5. Rewrite the existing `_requestPermission` private method entirely:

   private async _requestPermission(
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

6. Rename the existing `_requestPermission` call inside `callTool` to pass
   chatId. Add chatId as a new parameter to callTool:

   async callTool(
     serverName: string,
     toolName:   string,
     args:       Record<string, unknown>,
     chatId:     string = '',
   ): Promise<McpToolResult>

   Inside callTool, change the permission check to:
     const perm = await this._requestPermission(serverName, toolName, args, chatId)
     if (!perm.approved) throw new McpDeniedError(perm.userNote)

7. Create a new private method `_awaitPermissionDialog` that replaces the
   old inline promise logic in `_requestPermission`:

   async _awaitPermissionDialog(
     serverName: string,
     toolName:   string,
     args:       Record<string, unknown>,
     chatId:     string,
   ): Promise<{ approved: boolean; userNote: string }> {
     const requestId = randomUUID()
     return new Promise((resolve) => {
       const timer = setTimeout(() => {
         this.pendingPermissions.delete(requestId)
         resolve({ approved: false, userNote: '' })
       }, 60_000)
       this.pendingPermissions.set(requestId, {
         serverName,
         toolName,
         chatId,
         resolve,
         timer,
       })
       this.emit('permissionRequest', { serverName, toolName, args, requestId, chatId })
     })
   }

8. Update the PendingPermission interface to match:

   interface PendingPermission {
     serverName: string
     toolName:   string
     chatId:     string
     resolve:    (result: { approved: boolean; userNote: string }) => void
     timer:      ReturnType<typeof setTimeout>
   }

9. Rewrite `resolvePermission` to accept McpToolPermissionResponse
   (imported from shared/types):

   resolvePermission(response: import('../../shared/types').McpToolPermissionResponse): void {
     const pending = this.pendingPermissions.get(response.requestId)
     if (!pending) return
     clearTimeout(pending.timer)
     this.pendingPermissions.delete(response.requestId)
     if (response.approved && response.alwaysAllow === 'forever') {
       this._persistServerApprovalMode(pending.serverName, false)
       const entry = this.servers.get(pending.serverName)
       if (entry) entry.requiresApproval = false
     } else if (response.approved && response.alwaysAllow === 'session') {
       this.sessionAllowList.add(`${pending.chatId}__${pending.serverName}__${pending.toolName}`)
     }
     pending.resolve({ approved: response.approved, userNote: response.userNote })
   }

10. Add these new public methods:

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

11. Add a private method `_persistServerApprovalMode`:

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

12. Export a testable subclass at the bottom of the file (after the singleton
    export) so the test files can construct isolated instances:

    export class McpServerManagerTestable extends McpServerManager {
      protected configPath(): string { return '' }  // no disk I/O in tests

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

      private _nextDialogResponse: { approved: boolean; alwaysAllow?: 'session' | 'forever' | false; userNote: string } | null = null

      mockNextDialogResponse(r: { approved: boolean; alwaysAllow?: 'session' | 'forever' | false; userNote: string }): void {
        this._nextDialogResponse = r
      }

      async _awaitPermissionDialog(
        serverName: string, toolName: string, _args: Record<string, unknown>, chatId: string
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

      async testRequestPermission(serverName: string, toolName: string, args: Record<string, unknown>, chatId: string) {
        return this._requestPermission(serverName, toolName, args, chatId)
      }

      getBypassFlag(): boolean { return (this as unknown as { bypassAllPermissions: boolean }).bypassAllPermissions }
      getSessionAllowList(): Set<string> { return (this as unknown as { sessionAllowList: Set<string> }).sessionAllowList }
      getServerRequiresApproval(name: string): boolean {
        return (this as unknown as { servers: Map<string, { requiresApproval: boolean }> }).servers.get(name)?.requiresApproval ?? true
      }
      getPendingCount(): number {
        return (this as unknown as { pendingPermissions: Map<string, unknown> }).pendingPermissions.size
      }
    }
```

---

## PROMPT 4 — ChatService: catch McpDeniedError, inject notes

```
Read src/main/services/ChatService.ts in full.
Read src/main/services/McpServerManager.ts — only the McpDeniedError,
buildApprovedToolResult, and buildDeniedToolMessage exports.
Read src/tests/hitl/toolResultInjection.test.ts in full.

Make the following targeted changes to ChatService.ts:

1. Import McpDeniedError, buildApprovedToolResult, and buildDeniedToolMessage
   from McpServerManager at the top of the file.

2. In the `abort()` method, add this line after the existing abort logic:
     mcpServerManager.drainPendingPermissions()

3. In the native tool call handler, find the MCP dispatch block — the branch
   that calls `mcpServerManager.callTool(serverName, mcpToolName, args)`.

   a. Pass chatId as the fourth argument:
        mcpServerManager.callTool(serverName, mcpToolName, args, payload.chatId ?? '')

   b. After the call succeeds, wrap toolResult before injecting into messages:
        const userNote = (perm as unknown as { userNote?: string })?.userNote ?? ''
        toolResult = buildApprovedToolResult(toolResult, userNote)
      Note: callTool does not currently return userNote. The cleanest approach
      is to catch the approved case and thread the note through. Do this by
      making callTool return { text, images, userNote } instead of just
      McpToolResult. Add userNote: string to the McpToolResult interface in
      McpServerManager.ts and set it from the perm result inside callTool.

   c. In the catch block for this MCP dispatch, distinguish McpDeniedError:

        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          const deniedMsg = err instanceof McpDeniedError
            ? buildDeniedToolMessage(err.userNote)
            : `Tool failed: ${errMsg}. Use training knowledge.`
          send(IPC_CHANNELS.CHAT_STREAM_TOOL_ERROR, { query: uiLabel, toolName, error: errMsg })
          currentMessages = [
            ...currentMessages,
            { role: 'tool', tool_call_id: id, content: deniedMsg } as { role: string; content: string },
          ]
        }

Do not change anything else in ChatService.ts.
```

---

## PROMPT 5 — handlers.ts: new IPC handlers

```
Read src/main/ipc/handlers.ts in full.
Read src/shared/types.ts — the IPC_CHANNELS object and McpToolPermissionResponse interface.

Make the following changes to handlers.ts only:

1. Find the existing MCP_TOOL_PERMISSION_RESPONSE handler:
     ipcMain.handle(IPC_CHANNELS.MCP_TOOL_PERMISSION_RESPONSE, async (_, { requestId, approved, alwaysAllow }) => {
       mcpServerManager.resolvePermission(requestId, approved, alwaysAllow)
     })
   Replace it with:
     ipcMain.handle(
       IPC_CHANNELS.MCP_TOOL_PERMISSION_RESPONSE,
       async (_, response: import('../../shared/types').McpToolPermissionResponse) => {
         mcpServerManager.resolvePermission(response)
       }
     )

2. After the MCP_RESTART_SERVER handler block, add:

   ipcMain.handle(
     IPC_CHANNELS.MCP_BYPASS_PERMISSIONS_CHANGED,
     async (_, bypass: boolean) => {
       const { mcpServerManager } = await import('../services/McpServerManager')
       mcpServerManager.setBypassPermissions(bypass)
     }
   )

   ipcMain.handle(
     IPC_CHANNELS.MCP_SET_SERVER_APPROVAL_MODE,
     async (_, { serverName, requiresApproval }: { serverName: string; requiresApproval: boolean }) => {
       const { mcpServerManager } = await import('../services/McpServerManager')
       mcpServerManager.setServerApprovalMode(serverName, requiresApproval)
     }
   )

3. After all the ipcMain.handle calls for MCP, find the block that wires up
   mcpServerManager events (the statusChanged listener). Add alongside it:

   mcpServerManager.on(
     'permissionRequest',
     (req: import('../../shared/types').McpToolPermissionRequest) => {
       send(IPC_CHANNELS.MCP_TOOL_PERMISSION_REQUEST, req)
     }
   )

Do not change anything else.
```

---

## PROMPT 6 — ToolPermissionDialog component

```
Read src/renderer/src/components/chat/ToolPermissionDialog.test.tsx in full.
Read src/renderer/src/components/layout/InputBar.tsx lines 1-30 (for import style reference).
Read src/shared/types.ts — McpToolPermissionRequest and McpToolPermissionResponse.

Create src/renderer/src/components/chat/ToolPermissionDialog.tsx.

Requirements:
- Export a named component: ToolPermissionDialog
  Props: { request: McpToolPermissionRequest; onRespond: (r: McpToolPermissionResponse) => void }
- The dialog is a fixed full-screen backdrop (bg-black/60, z-50) with a
  centered card (max-w-md, rounded-xl, bg matching the app's surface colour,
  border border-surface-border, p-6)
- Header: wrench icon (lucide-react Wrench) + "Tool Permission Required" text
- Two rows beneath: "Server: {serverName}" and "Tool: {toolName}" in small
  muted text. Strip the serverName__ prefix from toolName for display.
- Args block: a <pre> showing JSON.stringify(args, null, 2), collapsed to
  max-h-16 overflow-hidden by default. A button with data-testid="args-toggle"
  toggles it open/closed. Label: "Show arguments" / "Hide arguments".
- Textarea: placeholder "Optional: add context or reason...", rows=2,
  maxRows=4 (auto-grow), full width, monospace font, small text.
  Bound to local `note` state.
- Three buttons in a row at the bottom, left to right:
    Deny          — secondary/ghost style, red text on hover
    Allow this session — secondary style
    Allow         — primary accent style (same as send button)
  All three call onRespond with the appropriate McpToolPermissionResponse.
  Deny:                { requestId, approved: false, alwaysAllow: false, userNote: note }
  Allow this session:  { requestId, approved: true,  alwaysAllow: 'session', userNote: note }
  Allow:               { requestId, approved: true,  alwaysAllow: false, userNote: note }
- Use Tailwind CSS only. No Framer Motion. Use plain CSS transitions.
- The component does not manage its own visibility — the parent mounts/unmounts it.

Also export a ToolPermissionQueue component that wraps ToolPermissionDialog:
- Props: none
- Listens to window.api.onToolPermissionRequest (add this to preload if needed)
- Maintains a queue of pending requests in useState
- Renders ToolPermissionDialog for the first item in the queue only
- On onRespond: calls window.api.mcpToolPermissionResponse(response), shifts
  the queue
- If queue is empty, renders nothing
```

---

## PROMPT 7 — InputBar: Bypass Permissions toggle

```
Read src/renderer/src/components/layout/InputBar.tsx in full.
Read src/tests/hitl/bypassToggle.test.tsx in full.

Make the following changes to InputBar.tsx only:

1. Export a new named component BypassPermissionsButton:

   export function BypassPermissionsButton({
     active,
     onToggle,
   }: {
     active: boolean
     onToggle: (next: boolean) => void
   }) {
     // Renders a pill button identical in visual style to the Thinking button.
     // When active=false: Shield icon from lucide-react + label "Permissions", muted style
     // When active=true:  ShieldOff icon + label "Bypassed", same red/accent style as Thinking active
     // Clicking calls onToggle(!active)
   }

2. Inside the InputBar component, add local state:
     const [bypassPermissions, setBypassPermissions] = useState(false)

3. Add a handler:
     const handleBypassToggle = useCallback((next: boolean) => {
       setBypassPermissions(next)
       window.api.setBypassPermissions(next)
     }, [])

4. Render <BypassPermissionsButton active={bypassPermissions} onToggle={handleBypassToggle} />
   immediately after the Thinking pill button in the JSX, before the MCP
   activity indicator.

5. Add setBypassPermissions to the window.api type declaration in preload if
   it is not already there. It calls ipcRenderer.invoke(
     'mcp:bypassPermissionsChanged', bypass)

Do not change any other behaviour.
```

---

## PROMPT 8 — Wire ToolPermissionQueue into Layout and MCP settings slider

```
Read src/renderer/src/components/layout/Layout.tsx in full.
Read src/renderer/src/components/settings/ directory listing.
Then read whichever settings file contains the MCP server list UI.

Change 1 — Layout.tsx:
  Import ToolPermissionQueue from '../chat/ToolPermissionDialog'.
  Render <ToolPermissionQueue /> as the last child inside the outermost div,
  after all other content. It renders nothing when no requests are pending.

Change 2 — MCP settings panel:
  For each server row in the server list, add a two-state toggle immediately
  after the server status badge.
  States: "Ask Permission" (requiresApproval=true) and "Always Allow" (requiresApproval=false).
  Visual: a small pill toggle, similar to the enable/disable toggle already
  present. Default state comes from the server's requiresApproval field in
  the config returned by MCP_LIST_CUSTOM_SERVERS (you may need to include
  requiresApproval in that response — read the handler and add it if absent).
  On change: call window.api.setServerApprovalMode(serverName, requiresApproval)
  which invokes IPC channel 'mcp:setServerApprovalMode'.
  Add setServerApprovalMode to the preload window.api bindings if not present.
```

---

## PROMPT 9 — Run tests and fix failures

```
Run: npx vitest run src/tests/hitl/

For each failing test, read the test body, identify the exact assertion that
fails, fix only the production code required to make it pass. Do not modify
any test file. After each fix, re-run the suite and repeat until all tests
pass with no errors.
```

---

## Notes for running these prompts

- Run them in order 1 → 9. Each prompt assumes the previous ones are done.
- If Claude Code asks a clarifying question mid-prompt, answer it and continue
  — do not start a new prompt.
- After Prompt 3, run `npx vitest run src/tests/hitl/McpServerManager.permission.test.ts`
  before proceeding to Prompt 4. Fix any failures before moving on.
- The `McpServerManagerTestable` export in Prompt 3 is test infrastructure only
  — it is never imported by production code.
- `window.api` bindings (preload) may need updating alongside renderer changes.
  If Claude Code misses a preload binding, paste this addendum:
  "Also update src/preload/index.ts to expose [methodName] via contextBridge
  using ipcRenderer.invoke('[channel-name]', ...args)."