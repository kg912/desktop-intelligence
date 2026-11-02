import { describe, it, expect } from 'vitest'
import { spawn, execSync } from 'child_process'
import { killProcessTree } from '../ResourceGovernor'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const childrenOf = (pid: number): number[] =>
  execSync('ps -A -o pid=,ppid=')
    .toString()
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([, pp]) => pp === pid)
    .map(([p]) => p)

describe('killProcessTree', () => {
  it('kills a shell and the children it forked (they would otherwise be re-parented and live on)', async () => {
    const sh = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30 & wait'])
    await new Promise((r) => setTimeout(r, 300))
    const kids = childrenOf(sh.pid!)
    expect(kids.length).toBe(2)
    await killProcessTree(sh.pid!)
    await new Promise((r) => setTimeout(r, 200))
    expect([sh.pid!, ...kids].filter(alive)).toEqual([])
  })

  it('resolves for a pid that is already gone', async () => {
    await expect(killProcessTree(999_999)).resolves.toBeUndefined()
  })
})
