#!/usr/bin/env tsx
/**
 * spike-sandbox-yf-hosts.ts
 *
 * Empirical determination of the minimum hostnames yfinance needs.
 * Tests yfinance history() inside the srt sandbox with progressively
 * narrower allowlists until the minimum set is found.
 */

import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { spawn } from 'child_process'
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const YFINANCE_CODE = `import yfinance as yf
try:
    t = yf.Ticker("AAPL")
    h = t.history(period="1d")
    print("OK:", len(h), "rows")
except Exception as e:
    print("FAIL:", e)
`

function makeConfig(allowedDomains: string[]): SandboxRuntimeConfig {
  return {
    network: { allowedDomains, deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false
  }
}

async function testHosts(hosts: string[]): Promise<boolean> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'spike-sandbox-'))
  const codeFile = join(tmpDir, '_yf_test.py')
  writeFileSync(codeFile, YFINANCE_CODE, 'utf8')

  await SandboxManager.initialize(makeConfig(hosts))

  const sandboxedCommand = await SandboxManager.wrapWithSandbox(
    `python3 ${codeFile}`,
    undefined,
    makeConfig(hosts)
  )

  return new Promise<boolean>((resolve) => {
    const child = spawn(sandboxedCommand, { shell: true })
    let stdout = ''

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (_d: Buffer) => {
      // Suppress yfinance debug noise
    })

    child.on('close', async (code) => {
      const ok = code === 0 && stdout.includes('OK:')
      try { unlinkSync(codeFile) } catch {}
      await SandboxManager.reset()
      resolve(ok)
    })
  })
}

async function main(): Promise<void> {
  console.log('[spike] Testing yfinance hostname requirements…\n')

  const testCases: Array<[string, string[]]> = [
    ['deny-all (empty)', []],
    ['query1 only', ['query1.finance.yahoo.com']],
    ['query1+query2', ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']],
    ['query1+fc', ['query1.finance.yahoo.com', 'fc.yahoo.com']],
    ['query1+query2+fc', ['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'fc.yahoo.com']],
  ]

  for (const [label, hosts] of testCases) {
    process.stdout.write(`[spike] ${label.padEnd(30)} … `)
    try {
      const ok = await testHosts(hosts)
      console.log(ok ? 'PASS' : 'FAIL')
    } catch (err) {
      console.log(`ERROR: ${err}`)
    }
  }
}

main().catch((err) => {
  console.error('[spike] Fatal:', err)
  process.exit(1)
})