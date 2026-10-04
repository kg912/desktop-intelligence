import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'di-chart-'))
const netFetch = vi.fn(async (url: string) => new Response(url))
vi.mock('electron', () => ({ app: { getPath: () => userData }, net: { fetch: (url: string) => netFetch(url) } }))

import { handleChartRequest } from '../chartProtocol'

beforeAll(() => {
  mkdirSync(join(userData, 'charts'))
  writeFileSync(join(userData, 'charts', 'NVDA_1.html'), '<html><head></head><body>chart</body></html>')
  writeFileSync(join(userData, 'secret.html'), '<head></head>secret')
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('di-chart protocol', () => {
  it('serves a chart with the shim injected first in <head>', async () => {
    const html = await (await handleChartRequest(new Request('di-chart://charts/NVDA_1.html'))).text()
    expect(html).toMatch(/^<html><head><script>/)
    expect(html).toContain('parent.postMessage')
    expect(html).toContain('chart</body>')
  })

  it('never reads outside the charts directory', async () => {
    const res = await handleChartRequest(new Request('di-chart://charts/..%2Fsecret.html'))
    expect(res.status).toBe(404)
  })

  it('proxies Yahoo chart requests', async () => {
    const res = await handleChartRequest(new Request('di-chart://charts/yahoo/NVDA?interval=1d&range=5d'))
    expect(await res.text()).toBe('https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1d&range=5d')
  })
})
