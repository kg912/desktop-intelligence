// Microsandbox go/no-go benchmark harness — SANDBOX_ARCHITECTURE_SPEC.html
// section 14 (B1–B6). Run on BOTH machines (M5 Pro and M1 Pro) BEFORE any
// MicrosandboxBackend internals are written (DoD D13), then record the CSV
// and the go/no-go decision in progress.md.
//
//   npm i --no-save microsandbox      # SDK is deliberately NOT a dependency
//   npx tsx scripts/bench-microsandbox.ts [--tasks B1,B2] [--runs 20]
//
// The SDK calls follow the spec's section 19 shape (Sandbox.create / exec /
// snapshot / restore / destroy). microsandbox is pre-1.0: if the installed
// SDK's names differ, adapt the four adapter functions below — nothing else.
// Results: scripts/bench-results/microsandbox-<machine>.csv
//   machine,task,run,cold_or_warm,latency_ms,rss_mb,notes

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { cpus, totalmem } from 'os'
import { join } from 'path'
import { execFileSync, execSync } from 'child_process'

type Sb = {
  exec: (cmd: string, args: string[]) => Promise<unknown>
  snapshot?: () => Promise<{ restore: (name: string) => Promise<Sb> }>
  destroy: () => Promise<void>
}

const args = process.argv.slice(2)
const argValue = (flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
const TASKS = (argValue('--tasks') ?? 'B1,B2,B3,B4,B5,B6').split(',')
const RUNS = Number(argValue('--runs') ?? 20)
const IMAGE = process.env.BENCH_IMAGE ?? 'python:3.12-slim'
const DEVKIT_IMAGE = process.env.BENCH_DEVKIT_IMAGE ?? IMAGE
const REPO = process.env.BENCH_REPO ?? 'https://github.com/pallets/itsdangerous'

const machine = `${cpus()[0].model.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${Math.round(totalmem() / 2 ** 30)}gb`
const outDir = join(__dirname, 'bench-results')
const outFile = join(outDir, `microsandbox-${machine}.csv`)

function record(task: string, run: number, coldOrWarm: string, latencyMs: number, rssMb: number | '', notes = ''): void {
  const row = [machine, task, run, coldOrWarm, latencyMs.toFixed(1), rssMb, JSON.stringify(notes)].join(',')
  appendFileSync(outFile, row + '\n')
  console.log(row)
}

async function loadSdk(): Promise<{ create: (name: string, opts: Record<string, unknown>) => Promise<Sb> }> {
  try {
    const mod = (await import('microsandbox' as string)) as { Sandbox: { create: (n: string, o: unknown) => Promise<Sb> } }
    return { create: (name, opts) => mod.Sandbox.create(name, opts) }
  } catch {
    console.error('microsandbox SDK not installed. Run: npm i --no-save microsandbox')
    process.exit(2)
  }
}

// ── Adapters (the only SDK-shape-dependent code) ───────────────────────────
const create = (sdk: Awaited<ReturnType<typeof loadSdk>>, name: string, image = IMAGE, allow: string[] = []): Promise<Sb> =>
  sdk.create(name, { image, network: { allow } })
const echo = (sb: Sb): Promise<unknown> => sb.exec('echo', ['hello'])
const fork = async (sb: Sb, name: string): Promise<Sb> => {
  if (!sb.snapshot) throw new Error('installed SDK has no snapshot() — B3 not measurable')
  return (await sb.snapshot()).restore(name)
}

/** Sum RSS of hypervisor/guest processes (libkrun/krunvm/msb), in MB. */
function hypervisorRssMb(): number {
  try {
    const out = execSync(`ps -A -o rss=,comm= | grep -Ei 'krun|microsandbox|msb' | grep -v grep || true`).toString()
    return Math.round(out.split('\n').filter(Boolean).reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0]), 0) / 1024)
  } catch {
    return 0
  }
}

const now = (): number => performance.now()
let seq = 0
const uniq = (p: string): string => `${p}-${process.pid}-${seq++}`

async function main(): Promise<void> {
  const sdk = await loadSdk()
  mkdirSync(outDir, { recursive: true })
  if (!existsSync(outFile)) writeFileSync(outFile, 'machine,task,run,cold_or_warm,latency_ms,rss_mb,notes\n')

  if (TASKS.includes('B1')) {
    // First run after the image is pulled fresh counts as cold; the rest warm.
    for (let run = 1; run <= RUNS; run++) {
      const t0 = now()
      const sb = await create(sdk, uniq('b1'))
      await echo(sb)
      record('B1', run, run === 1 ? 'cold' : 'warm', now() - t0, hypervisorRssMb())
      await sb.destroy()
    }
  }

  if (TASKS.includes('B2')) {
    for (let run = 1; run <= Math.min(RUNS, 5); run++) {
      const t0 = now()
      const sbs = await Promise.all([0, 1, 2, 3].map(async (i) => {
        const sb = await create(sdk, uniq(`b2-${i}`))
        await echo(sb)
        return sb
      }))
      record('B2', run, 'warm', now() - t0, hypervisorRssMb(), '4 concurrent to all ready')
      await Promise.all(sbs.map((sb) => sb.destroy()))
    }
  }

  if (TASKS.includes('B3')) {
    const base = await create(sdk, uniq('b3-base'), DEVKIT_IMAGE, ['pypi.org', 'files.pythonhosted.org'])
    await base.exec('pip', ['install', '--quiet', 'numpy', 'pandas'])
    for (let i = 1; i <= 4; i++) {
      const t0 = now()
      const forked = await fork(base, uniq('b3-fork'))
      await echo(forked)
      record('B3', i, 'warm', now() - t0, hypervisorRssMb(), 'fork-to-ready')
      await forked.destroy()
    }
    await base.destroy()
  }

  if (TASKS.includes('B4')) {
    const steps = `git clone --depth 1 ${REPO} /workspace/repo && cd /workspace/repo && pip install --quiet -e . pytest && python -m pytest -q`
    const t0 = now()
    const sb = await create(sdk, uniq('b4'), DEVKIT_IMAGE, ['github.com', 'codeload.github.com', 'pypi.org', 'files.pythonhosted.org'])
    await sb.exec('sh', ['-c', `apt-get update -qq && apt-get install -y -qq git >/dev/null && ${steps}`])
    record('B4', 1, 'sandboxed', now() - t0, hypervisorRssMb(), REPO)
    await sb.destroy()

    // Same steps unsandboxed, in a throwaway venv, for the real overhead delta.
    const dir = `/tmp/bench-b4-${process.pid}`
    const u0 = now()
    execFileSync('sh', ['-c', `python3 -m venv ${dir}/venv && . ${dir}/venv/bin/activate && mkdir -p ${dir} && git clone --depth 1 ${REPO} ${dir}/repo && cd ${dir}/repo && pip install --quiet -e . pytest && python -m pytest -q`], { stdio: 'ignore' })
    record('B4', 1, 'unsandboxed', now() - u0, '', REPO)
    execSync(`rm -rf ${dir}`)
  }

  if (TASKS.includes('B5')) {
    const one = await create(sdk, uniq('b5'))
    await echo(one)
    record('B5', 1, 'idle-1', 0, hypervisorRssMb(), '1 idle sandbox')
    const more = await Promise.all([0, 1, 2].map((i) => create(sdk, uniq(`b5-${i}`))))
    record('B5', 2, 'idle-4', 0, hypervisorRssMb(), '4 idle sandboxes')
    await Promise.all([one, ...more].map((sb) => sb.destroy()))
  }

  if (TASKS.includes('B6')) {
    // Grow the concurrent count until boot latency degrades 3× over n=1 or
    // creation fails. UI stutter must be judged by eye with the app open —
    // note it in progress.md alongside the ceiling this prints.
    const live: Sb[] = []
    let baseline = 0
    for (let n = 1; n <= 16; n++) {
      const t0 = now()
      try {
        const sb = await create(sdk, uniq('b6'))
        await echo(sb)
        live.push(sb)
      } catch (err) {
        record('B6', n, 'ceiling', now() - t0, hypervisorRssMb(), `create failed: ${(err as Error).message}`)
        break
      }
      const ms = now() - t0
      if (n === 1) baseline = ms
      record('B6', n, 'concurrent', ms, hypervisorRssMb())
      if (ms > baseline * 3) {
        record('B6', n, 'ceiling', ms, hypervisorRssMb(), '>3x n=1 boot latency')
        break
      }
    }
    await Promise.all(live.map((sb) => sb.destroy()))
  }

  console.log(`\nResults appended to ${outFile}. Record them + the go/no-go decision in progress.md (spec section 14).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
