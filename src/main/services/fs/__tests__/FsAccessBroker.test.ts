import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FsAccessBroker, type FsAccessRequestEvent, type FsAccessTrace } from '../FsAccessBroker'
import { FsGrantStore } from '../FsGrantStore'
import { mergeGrants, realFsDeps, type FsPolicyDeps, type FsGrant } from '../pathPolicy'
import { FsToolError } from '../FsToolService'

// A fake home inside a real temp folder, so grants are real directories.
let base: string
let home: string
let deps: FsPolicyDeps
let grants: FsGrantStore
let persistent: FsGrant[]
let traces: FsAccessTrace[]
let requests: FsAccessRequestEvent[]
let expired: string[]
let broker: FsAccessBroker
let ids: number

function make(timeoutMs = 120_000): FsAccessBroker {
  broker = new FsAccessBroker({
    policyDeps: deps,
    grants,
    effectiveGrants: (chatId) => mergeGrants(persistent, grants.getGrants(chatId)),
    blockedNames: () => ['.env'],
    addPersistentRoot: (path, access) => persistent.push({ path, access, askBeforeEdit: true }),
    observe: (t) => traces.push(t),
    timeoutMs,
    newId: () => `r${++ids}`,
  })
  broker.on('request', (r: FsAccessRequestEvent) => requests.push(r))
  broker.on('expired', (id: string) => expired.push(id))
  return broker
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const fail = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(FsToolError)
    return (e as Error).message
  }
  throw new Error('expected FsToolError')
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'di-broker-')))
  home = join(base, 'Users', 'u')
  for (const d of ['projects/foo/src', 'projects/bar', 'other', '.ssh', 'Library/Application Support/DI']) mkdirSync(join(home, d), { recursive: true })
  writeFileSync(join(home, 'projects/foo/file.txt'), 'x')
  // os.tmpdir() is under /private, a refused system folder; narrow that list here.
  deps = {
    ...realFsDeps({ homedir: home, userDataDir: join(home, 'Library/Application Support/DI'), credentialEntries: ['~/.ssh', '~/.aws'] }),
    systemDirs: ['/System'],
  }
  grants = new FsGrantStore()
  persistent = []
  traces = []
  requests = []
  expired = []
  ids = 0
})
afterEach(() => {
  broker?.cancelAll()
  rmSync(base, { recursive: true, force: true })
})

const foo = (): string => join(home, 'projects/foo')

describe('FsAccessBroker — refused before any dialog', () => {
  it('S9: home, an ancestor of home, a credential folder, DI data, a file, a missing or relative path', async () => {
    make()
    expect(await fail(broker.request('c1', { path: '~', access: 'read', reason: 'r' }))).toBe(`${home} is your home folder. Choose a specific project folder inside it.`)
    expect(await fail(broker.request('c1', { path: join(base, 'Users'), access: 'read', reason: 'r' }))).toBe(
      `${join(base, 'Users')} contains your home folder. Choose a specific project folder inside your home folder.`
    )
    expect(await fail(broker.request('c1', { path: '~/.ssh', access: 'read', reason: 'r' }))).toMatch(/is or contains a credential path/)
    expect(await fail(broker.request('c1', { path: '~/Library/Application Support/DI', access: 'read', reason: 'r' }))).toMatch(/own data/)
    expect(await fail(broker.request('c1', { path: '~/Library', access: 'read', reason: 'r' }))).toBe(
      `${join(home, 'Library')} contains Desktop Intelligence's own data. Choose a project folder.`
    )
    expect(await fail(broker.request('c1', { path: '~/projects/foo/file.txt', access: 'read', reason: 'r' }))).toMatch(/is a file, not a folder/)
    expect(await fail(broker.request('c1', { path: '~/projects/nope', access: 'read', reason: 'r' }))).toMatch(/does not exist/)
    expect(await fail(broker.request('c1', { path: 'projects/foo', access: 'read', reason: 'r' }))).toBe('Use an absolute path (for example /Users/you/project/src/app.ts).')
    expect(requests).toEqual([])
  })

  it('S9: "/" is refused', async () => {
    make()
    expect(await fail(broker.request('c1', { path: '/', access: 'read', reason: 'r' }))).toBe('/ is the whole disk. Choose a specific project folder.')
  })

  it('refuses a bad access level and a missing reason', async () => {
    make()
    expect(await fail(broker.request('c1', { path: foo(), access: 'admin', reason: 'r' }))).toBe('access must be "read" or "write".')
    expect(await fail(broker.request('c1', { path: foo(), access: 'read' }))).toBe('Give a short reason; it is shown to the user.')
  })

  it('says when the folder is already covered at that level, naming the root', async () => {
    persistent.push({ path: foo(), access: 'write', askBeforeEdit: true })
    make()
    expect(await broker.request('c1', { path: join(foo(), 'src'), access: 'write', reason: 'r' })).toBe(
      `${join(foo(), 'src')} is already accessible (read and write) through ${foo()}. Use the fs_ tools directly; no request is needed.`
    )
    expect(requests).toEqual([])
  })
})

describe('FsAccessBroker — dialog', () => {
  it('emits one request with the real path, reason (≤300 chars) and timeout, and grants for this chat', async () => {
    make()
    const p = broker.request('c1', { path: '~/projects/foo', access: 'write', reason: 'x'.repeat(400) })
    await flush()
    expect(requests).toEqual([{ requestId: 'r1', chatId: 'c1', path: foo(), access: 'write', reason: 'x'.repeat(300), timeoutMs: 120_000 }])
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'write', path: foo() })
    expect(await p).toBe(
      `Access granted: ${foo()} (read and write, this chat only). You can now use fs_list, fs_glob, fs_grep, fs_read, fs_edit and fs_write inside it.`
    )
    expect(grants.getGrants('c1')).toEqual([{ path: foo(), access: 'write', askBeforeEdit: true }])
    expect(persistent).toEqual([])
    expect(traces).toEqual([{ chatId: 'c1', path: foo(), requested: 'write', decision: 'chat', scope: 'chat', granted: 'write' }])
  })

  it('read grant lists only the read tools', async () => {
    make()
    const p = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'read', path: foo() })
    expect(await p).toBe(`Access granted: ${foo()} (read-only, this chat only). You can now use fs_list, fs_glob, fs_grep and fs_read inside it.`)
  })

  it('"always" saves the root to Settings, not to the chat', async () => {
    make()
    const p = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    broker.respond({ requestId: 'r1', decision: 'always', access: 'read', path: foo() })
    expect(await p).toContain('(read-only, saved in Settings)')
    expect(persistent).toEqual([{ path: foo(), access: 'read', askBeforeEdit: true }])
    expect(grants.getGrants('c1')).toEqual([])
  })

  it('S10: a denial is recorded; asking again for it or a subfolder is auto-denied without a dialog', async () => {
    make()
    const p = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    broker.respond({ requestId: 'r1', decision: 'deny', access: 'read', path: foo() })
    expect(await p).toBe(`Access to ${foo()} was denied by the user. Do not request it again in this chat.`)
    expect(await broker.request('c1', { path: join(foo(), 'src'), access: 'read', reason: 'r' })).toBe(
      `Access to ${join(foo(), 'src')} was already denied in this chat. Do not request it again.`
    )
    expect(requests).toHaveLength(1)
    // another chat may still ask
    const q = broker.request('c2', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    expect(requests).toHaveLength(2)
    broker.respond({ requestId: 'r2', decision: 'deny', access: 'read', path: foo() })
    await q
    expect(traces.map((t) => t.decision)).toEqual(['deny', 'auto-denied', 'deny'])
  })

  it('S10b: a write request downgraded to read grants read and auto-denies later write requests', async () => {
    make()
    const p = broker.request('c1', { path: foo(), access: 'write', reason: 'r' })
    await flush()
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'read', path: foo() })
    expect(await p).toBe(
      `Access granted: ${foo()} (read-only, this chat only). You can now use fs_list, fs_glob, fs_grep and fs_read inside it. Write access was declined; do not request it again in this chat.`
    )
    expect(await broker.request('c1', { path: join(foo(), 'src'), access: 'write', reason: 'r' })).toBe(
      `Write access to ${join(foo(), 'src')} was declined in this chat; you have read-only access.`
    )
    expect(requests).toHaveLength(1)
    expect(grants.getGrants('c1')).toEqual([{ path: foo(), access: 'read', askBeforeEdit: true }])
  })

  it('upgrades read to write when the user chooses it in the dialog', async () => {
    make()
    const p = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'write', path: foo() })
    expect(await p).toContain('(read and write, this chat only)')
  })

  it('a folder picked in the dialog is re-validated and granted instead', async () => {
    make()
    const bar = join(home, 'projects/bar')
    const p = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'read', path: bar })
    expect(await p).toContain(`Access granted: ${bar} (read-only, this chat only).`)
    expect(grants.getGrants('c1').map((g) => g.path)).toEqual([bar])
  })

  it('a picked folder that fails validation grants nothing', async () => {
    make()
    const p = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'read', path: home })
    expect(await p).toBe(`The folder chosen in the dialog cannot be used: ${home} is your home folder. Choose a specific project folder inside it. Nothing was granted.`)
    expect(grants.getGrants('c1')).toEqual([])
  })

  it('one dialog per chat at a time, FIFO; a queued request re-checks coverage when its turn comes', async () => {
    make()
    const a = broker.request('c1', { path: foo(), access: 'read', reason: 'a' })
    const b = broker.request('c1', { path: join(foo(), 'src'), access: 'read', reason: 'b' })
    const c = broker.request('c2', { path: foo(), access: 'read', reason: 'c' })
    await flush()
    expect(requests.map((r) => [r.chatId, r.reason])).toEqual([
      ['c1', 'a'],
      ['c2', 'c'],
    ])
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'read', path: foo() })
    await a
    expect(await b).toBe(`${join(foo(), 'src')} is already accessible (read-only) through ${foo()}. Use the fs_ tools directly; no request is needed.`)
    expect(requests).toHaveLength(2)
    broker.respond({ requestId: 'r2', decision: 'deny', access: 'read', path: foo() })
    await c
  })

  it('times out with "No answer from the user." and does not record a denial', async () => {
    vi.useFakeTimers()
    try {
      make(1000)
      const p = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
      await vi.advanceTimersByTimeAsync(1001)
      expect(await p).toBe('No answer from the user.')
      expect(expired).toEqual(['r1'])
      const q = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
      await vi.advanceTimersByTimeAsync(0)
      expect(requests).toHaveLength(2)
      broker.cancelChat('c1')
      expect(await q).toBe('No answer from the user.')
      expect(traces.map((t) => t.decision)).toEqual(['no-answer', 'no-answer'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelAll (chat abort) answers pending and queued requests with no answer', async () => {
    make()
    const a = broker.request('c1', { path: foo(), access: 'read', reason: 'a' })
    const b = broker.request('c1', { path: join(home, 'projects/bar'), access: 'read', reason: 'b' })
    await flush()
    broker.cancelAll()
    expect(await a).toBe('No answer from the user.')
    expect(await b).toBe('No answer from the user.')
    expect(expired).toEqual(['r1'])
  })

  it('ignores unknown or malformed responses', async () => {
    make()
    const p = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    broker.respond({ requestId: 'nope', decision: 'chat', access: 'read', path: foo() })
    broker.respond({ requestId: 'r1', decision: 'maybe' as never, access: 'read', path: foo() })
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'all' as never, path: foo() })
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'read', path: foo() })
    expect(await p).toContain('Access granted')
  })

  it('never consults bypass-all: there is no auto-approval input at all', () => {
    make()
    expect(Object.keys((broker as unknown as { d: object }).d).sort()).toEqual(
      ['addPersistentRoot', 'blockedNames', 'effectiveGrants', 'grants', 'newId', 'observe', 'policyDeps', 'timeoutMs'].sort()
    )
  })
})

describe('FsAccessBroker — defaults and edge cases', () => {
  it('uses a random request id and the 120 s timeout by default', async () => {
    broker = new FsAccessBroker({ policyDeps: deps, grants, effectiveGrants: () => [], blockedNames: () => [], addPersistentRoot: () => {} })
    const seen: FsAccessRequestEvent[] = []
    broker.on('request', (r: FsAccessRequestEvent) => seen.push(r))
    const p = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    expect(seen[0].requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(seen[0].timeoutMs).toBe(120_000)
    broker.respond({ requestId: seen[0].requestId, decision: 'deny', access: 'read', path: foo() })
    await p
  })

  it('a relative picked path grants nothing', async () => {
    make()
    const p = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'read', path: 'projects/bar' })
    expect(await p).toBe('The folder chosen in the dialog cannot be used: Use an absolute path (for example /Users/you/project/src/app.ts). Nothing was granted.')
  })

  it('cancelChat leaves other chats\' dialogs open', async () => {
    make()
    const a = broker.request('c1', { path: foo(), access: 'read', reason: 'r' })
    await flush()
    broker.cancelChat('c2')
    broker.respond({ requestId: 'r1', decision: 'chat', access: 'read', path: foo() })
    expect(await a).toContain('Access granted')
  })
})
