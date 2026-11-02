// Sandboxed fs worker entry (spec 2.5). A thin NDJSON loop over fsOps, spawned
// by FsToolService through sandboxService.spawnPersistent() with
// ELECTRON_RUN_AS_NODE=1. No Electron imports (it cannot load them).
//
// Policy: DI_FS_POLICY = { grants (union of every chat's grants), blockedNames,
// homedir, userDataDir, credentialEntries, testDisableOwnCheck? }. The worker
// re-checks every path against it (defence in depth: a main-process bug alone
// cannot reach outside the union). testDisableOwnCheck exists only so the
// integration test can prove Seatbelt is the last layer; FsToolService sets it
// only when constructed with its test-only option.
//
// Protocol: first line {"ready":true}; then request {id, op, args} →
//   {id, ok: true, result} | {id, ok: false, error, kind: 'op' | 'system', code?}

import { createInterface } from 'readline'
import { fsRead, fsList, fsGlob, fsGrep, fsEdit, fsWrite, FsOpError, type FsOpsContext } from './fsOps'
import { realFsDeps, type FsGrant } from './pathPolicy'

interface Policy {
  grants: FsGrant[]
  blockedNames: string[]
  homedir: string
  userDataDir: string
  credentialEntries: string[]
  testDisableOwnCheck?: boolean
}

const policy = JSON.parse(process.env.DI_FS_POLICY ?? '{}') as Policy
const deps = realFsDeps({ homedir: policy.homedir, userDataDir: policy.userDataDir, credentialEntries: policy.credentialEntries ?? [] })
const ctx: FsOpsContext = policy.testDisableOwnCheck
  ? { grants: [{ path: '/', access: 'write', askBeforeEdit: false }], blockedNames: [], deps: { ...deps, credentialEntries: [], userDataDir: '/nonexistent-di-test' } }
  : { grants: policy.grants ?? [], blockedNames: policy.blockedNames ?? [], deps }

const OPS = { read: fsRead, list: fsList, glob: fsGlob, grep: fsGrep, edit: fsEdit, write: fsWrite } as const

const reply = (msg: unknown): void => {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let id: unknown = null
  try {
    const req = JSON.parse(line) as { id: unknown; op: keyof typeof OPS; args: Record<string, unknown> }
    id = req.id
    const fn = OPS[req.op] as ((c: FsOpsContext, a: Record<string, unknown>) => Promise<unknown>) | undefined
    if (!fn) throw new FsOpError(`Unknown operation ${String(req.op)}.`)
    const out = await fn(ctx, req.args ?? {})
    reply({ id, ok: true, result: typeof out === 'string' ? { text: out } : out })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    reply({ id, ok: false, error: e?.message ?? String(err), kind: err instanceof FsOpError ? 'op' : 'system', code: e?.code })
  }
})

// Parent gone → stdin closes → exit (never outlive the app).
process.stdin.on('end', () => process.exit(0))
reply({ ready: true })
