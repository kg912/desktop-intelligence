#!/usr/bin/env tsx
/**
 * spike-fs-sandbox.ts — Phase 0 of specs/builtin-file-system-access.md.
 *
 * Through the real SrtBackend, spawn a Node-capable binary (dev Electron,
 * packaged Electron, system node) with ELECTRON_RUN_AS_NODE=1 and a tiny probe
 * script, under denyRead [home] + allowRead [grants…] + allowWrite [grantA],
 * and record what the OS sandbox actually allows. No product code: the
 * allowRead field is injected by patching buildPerSpecConfig in this script
 * only (Phase 3 adds it to SandboxRunSpec for real).
 *
 * Run: npx tsx scripts/spike-fs-sandbox.ts
 */
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { randomBytes } from 'crypto'
import { quote } from 'shell-quote'
import { SrtBackend } from '../src/main/services/sandbox/SrtBackend'
import type { SandboxRunSpec } from '../src/main/services/sandbox/types'

const REPO = resolve(__dirname, '..')
const base = join(homedir(), `.di-fs-spike-${randomBytes(4).toString('hex')}`)
const ws = join(base, 'ws')
const grantA = join(base, 'grantA')
const grantRO = join(base, 'grantRO')
const sibling = join(base, 'sibling')
// Mimics the dev layout of the real worker: <repo>/package.json + <repo>/out/main/fsWorker.js
const fakeRepo = join(base, 'app')
const fakeOutMain = join(fakeRepo, 'out', 'main')

function setup(): void {
  mkdirSync(fakeOutMain, { recursive: true })
  writeFileSync(join(fakeRepo, 'package.json'), '{"name":"fake","main":"out/main/index.js"}')
  for (const d of [ws, grantA, grantRO, sibling, join(grantA, '.ssh-like'), join(grantA, 'sub')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(grantA, 'a.txt'), 'inside-A')
  writeFileSync(join(grantRO, 'r.txt'), 'inside-RO')
  writeFileSync(join(sibling, 's.txt'), 'sibling-secret')
  writeFileSync(join(grantA, '.ssh-like', 'key'), 'nested-deny')
  writeFileSync(join(grantA, 'sub', '.env'), 'TOKEN=x')
  symlinkSync(join(sibling, 's.txt'), join(grantA, 'link'))
  symlinkSync(sibling, join(grantA, 'linkdir'))
}

// The probe runs inside the sandbox; every op reports ok/err code.
const PROBE = `
const fs = require('fs'); const path = require('path');
const [A, RO, SIB] = JSON.parse(process.argv[2]);
const out = { node: process.versions.node, glob: typeof fs.promises.glob, matchesGlob: typeof path.matchesGlob };
const t = (k, f) => { try { const v = f(); out[k] = 'ok' + (v === undefined ? '' : ':' + v); } catch (e) { out[k] = 'ERR:' + e.code; } };
t('2_readInsideA', () => fs.readFileSync(path.join(A, 'a.txt'), 'utf8'));
t('2_readSibling', () => fs.readFileSync(path.join(SIB, 's.txt'), 'utf8'));
t('2_readdirSibling', () => fs.readdirSync(SIB).join(','));
t('2_readNestedDeny', () => fs.readFileSync(path.join(A, '.ssh-like', 'key'), 'utf8'));
t('3_writeTmpRenameA', () => { const tmp = path.join(A, '.new.di-tmp-1'); fs.writeFileSync(tmp, 'w'); const fd = fs.openSync(tmp, 'r+'); fs.fsyncSync(fd); fs.closeSync(fd); fs.chmodSync(tmp, 0o644); fs.renameSync(tmp, path.join(A, 'new.txt')); return fs.readFileSync(path.join(A, 'new.txt'), 'utf8'); });
t('3_mkdirA', () => { fs.mkdirSync(path.join(A, 'made', 'deep'), { recursive: true }); });
t('3_readRO', () => fs.readFileSync(path.join(RO, 'r.txt'), 'utf8'));
t('3_writeRO', () => fs.writeFileSync(path.join(RO, 'x.txt'), 'w'));
t('4_readSymlinkOut', () => fs.readFileSync(path.join(A, 'link'), 'utf8'));
t('4_readdirSymlinkDirOut', () => fs.readdirSync(path.join(A, 'linkdir')).join(','));
t('5_readSubEnv', () => fs.readFileSync(path.join(A, 'sub', '.env'), 'utf8'));
t('x_statSibling', () => fs.statSync(SIB).isDirectory());
t('x_readEtcHosts', () => fs.readFileSync('/etc/hosts', 'utf8').length);
process.stdout.write(JSON.stringify(out));
`

const backend = new SrtBackend()
// Inject filesystem.allowRead (spike only — see header).
const proto = SrtBackend.prototype as unknown as { buildPerSpecConfig: (s: SandboxRunSpec & { allowRead?: string[] }) => { filesystem: Record<string, unknown> } }
const orig = proto.buildPerSpecConfig
proto.buildPerSpecConfig = function (this: unknown, s) {
  const cfg = orig.call(this, s)
  if (s.allowRead) cfg.filesystem.allowRead = s.allowRead
  return cfg
}

async function probe(label: string, bin: string, allowRead: string[], extraDeny: string[] = []): Promise<void> {
  const script = join(fakeOutMain, 'probe.js')
  writeFileSync(script, PROBE)
  const spec: SandboxRunSpec & { allowRead: string[] } = {
    workspaceDir: ws,
    command: quote([bin, script, JSON.stringify([grantA, grantRO, sibling])]),
    executionProfile: 'lightweight',
    allowedDomains: [],
    allowWrite: [grantA],
    denyRead: [homedir(), join(grantA, '.ssh-like'), ...extraDeny],
    allowRead,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs: 30_000,
    maxRssMb: 0,
    callerLabel: 'fs-spike',
  }
  const r = await backend.run(spec)
  console.log(`\n### ${label}`)
  console.log(`bin: ${bin}`)
  console.log(`allowRead: ${JSON.stringify(allowRead.map((p) => p.replace(homedir(), '~')))}`)
  console.log(`exit: ${r.exitCode}`)
  if (r.stdout) console.log(`result: ${r.stdout}`)
  if (r.exitCode !== 0) console.log(`stderr: ${r.stderr.trim().split("\n").slice(0, 12).join(" | ")}`)
  // reset write probe for the next variant
  rmSync(join(grantA, 'new.txt'), { force: true })
  rmSync(join(grantA, 'made'), { recursive: true, force: true })
  rmSync(join(grantRO, 'x.txt'), { force: true })
}

async function main(): Promise<void> {
  setup()
  const grants = [grantA, grantRO, ws]
  const devElectron = join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const devElectronApp = join(REPO, 'node_modules/electron/dist/Electron.app')
  const packaged = '/Applications/Desktop Intelligence.app/Contents/MacOS/Desktop Intelligence'
  try {
    const code = [fakeOutMain, join(fakeRepo, 'package.json')]
    await probe('A dev Electron, grants + worker dir + package.json, no Electron.app', devElectron, [...grants, ...code])
    await probe('B0 dev Electron, grants + Electron.app + worker dir, no package.json', devElectron, [...grants, devElectronApp, fakeOutMain])
    await probe('B dev Electron, grants + Electron.app + worker dir + package.json', devElectron, [...grants, devElectronApp, ...code])
    await probe('B5 as B, plus denyRead <grantA>/**/.env', devElectron, [...grants, devElectronApp, ...code], [`${grantA}/**/.env`])
    if (existsSync(packaged)) {
      await probe('C packaged app binary, grants + worker dir + package.json', packaged, [...grants, ...code])
    } else console.log('\n### C packaged app not installed — skipped')
    await probe('D system node (vitest runtime), grants + worker dir + package.json', process.execPath, [...grants, ...code])
  } finally {
    await backend.shutdown()
    rmSync(base, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
