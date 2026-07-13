#!/usr/bin/env tsx
/**
 * spike-sandbox-network.ts
 *
 * Empirically determine yfinance's outbound network requirements by running
 * a yfinance Python snippet inside the srt sandbox with deny-all network
 * (allowedDomains: []) and reading blocked-connection records from the
 * SandboxViolationStore.
 *
 * Usage:
 *   npx tsx scripts/spike-sandbox-network.ts
 *
 * Requires: macOS with sandbox-exec available at /usr/bin/sandbox-exec.
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
    print("OK")
except Exception as e:
    print("FAIL:", e)
`

async function main(): Promise<void> {
  // Write the code to a temp file so we don't need to escape it for shell
  const tmpDir = mkdtempSync(join(tmpdir(), 'spike-sandbox-'))
  const codeFile = join(tmpDir, '_yf_test.py')
  writeFileSync(codeFile, YFINANCE_CODE, 'utf8')

  console.log('[spike] Initializing SandboxManager with deny-all network…')

  const config: SandboxRuntimeConfig = {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [tmpDir], denyWrite: [] },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false
  }

  await SandboxManager.initialize(config, undefined, true) // enableLogMonitor=true

  const sandboxedCommand = await SandboxManager.wrapWithSandbox(
    `python3 ${codeFile}`,
    undefined,
    {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [tmpDir], denyWrite: [] },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false
    }
  )

  console.log('[spike] Spawning sandboxed python3…')

  return new Promise<void>((resolve) => {
    const child = spawn(sandboxedCommand, { shell: true })
    let stdout = ''

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { console.log('[spike stderr]', d.toString().trimEnd()) })

    child.on('close', async (code) => {
      console.log(`[spike] Process exited with code ${code}`)
      console.log('[spike stdout]', stdout.trimEnd())

      // Wait a beat for the log monitor to flush violations
      await new Promise(r => setTimeout(r, 3000))

      const store = SandboxManager.getSandboxViolationStore()
      const violations = store.getViolations()

      console.log(`\n[spike] Violation count: ${violations.length}`)

      if (violations.length === 0) {
        console.log('[spike] No violations captured — yfinance may have succeeded,')
        console.log('[spike] or the log monitor did not capture network events.')
        console.log('[spike] Falling back to known yfinance hostnames:')
        console.log('[spike]   query1.finance.yahoo.com')
        console.log('[spike]   query2.finance.yahoo.com')
        console.log('[spike]   fc.yahoo.com')
      } else {
        // Parse violation lines for hostname-like patterns
        const hostnames = new Set<string>()
        for (const v of violations) {
          console.log('[spike violation]', v.line)
          // Try to extract hostnames from violation lines.
          const match = v.line.match(/[\w.-]+\.yahoo\.com/gi)
          if (match) {
            for (const h of match) {
              hostnames.add(h.toLowerCase())
            }
          }
          // Also check for any hostname-like patterns
          const hostMatch = v.line.match(/(?:[\w-]+\.)+[\w-]+/gi)
          if (hostMatch) {
            for (const h of hostMatch) {
              if (h.includes('.') && !h.startsWith('.')) {
                hostnames.add(h.toLowerCase())
              }
            }
          }
        }

        if (hostnames.size > 0) {
          console.log('\n[spike] Discovered hostnames:')
          for (const h of [...hostnames].sort()) {
            console.log(`[spike]   ${h}`)
          }
        } else {
          console.log('[spike] Could not extract hostnames from violations.')
          console.log('[spike] Falling back to known yfinance hostnames.')
        }
      }

      // Cleanup
      try { unlinkSync(codeFile) } catch {}
      await SandboxManager.reset()
      resolve()
    })
  })
}

main().catch((err) => {
  console.error('[spike] Fatal:', err)
  process.exit(1)
})