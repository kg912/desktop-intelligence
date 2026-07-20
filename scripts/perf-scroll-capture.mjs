/**
 * perf-scroll-capture.mjs
 *
 * Deterministic fast up/down scroll repro for the M1/M5 Pro jank issue.
 *
 * 1. Connects to a running Electron renderer via CDP (default port 9222,
 *    override with CDP_PORT env var so baseline + sandbox-branch instances
 *    can run concurrently on different ports).
 * 2. Opens a fixed chat (heavy on message count + inline chart images —
 *    the exact repro shape implicated in row 251's ResizeObserver notes)
 *    via the sidebar so both profile runs exercise identical DOM content.
 * 3. Starts a Tracing session + CPU profile.
 * 4. Synthesizes a fast alternating down/up wheel-scroll burst over the
 *    virtualized message list (CDP Input.dispatchMouseEvent, type
 *    mouseWheel) — not a real trackpad gesture, but deterministic and
 *    identical across both branches, which a human-driven repro can't be.
 * 5. Stops profiling, writes:
 *      scripts/<OUT_NAME>.json — full trace (traceEvents + inline cpuProfile)
 *
 * Usage:
 *   CDP_PORT=9222 OUT_NAME=perf-sandbox-branch node scripts/perf-scroll-capture.mjs
 *   CDP_PORT=9223 OUT_NAME=perf-baseline       node scripts/perf-scroll-capture.mjs
 */

import { WebSocket } from 'ws'
import { writeFileSync } from 'fs'

const CDP_PORT = process.env.CDP_PORT || '9222'
const CDP_BASE = `http://localhost:${CDP_PORT}`
const OUT_NAME = process.env.OUT_NAME || 'perf-scroll-capture'
// Distinctive substring of the target chat's title (13 messages, 103 inline
// chart images per plot_store — heaviest chart-density chat in the dev DB).
const CHAT_TITLE_SNIPPET = process.env.CHAT_TITLE_SNIPPET || 'what is -log(p)'

async function getRendererTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${CDP_BASE}/json`)
      const tabs = await res.json()
      const page = tabs.find(t => t.type === 'page' && !t.url.includes('devtools') && !t.url.includes('worker'))
      if (page) { console.log(`[CDP:${CDP_PORT}] Target: ${page.url}`); return page }
    } catch {}
    console.log(`[CDP:${CDP_PORT}] Waiting for app… (${i + 1}/20)`)
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`Could not connect to renderer on port ${CDP_PORT}`)
}

function createSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let msgId = 1
    const pending = new Map()
    const listeners = new Map()
    ws.on('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = msgId++
          pending.set(id, { res, rej })
          ws.send(JSON.stringify({ id, method, params }))
        })
      },
      on(event, cb) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(cb)
      },
      close() { ws.close() }
    }))
    ws.on('message', raw => {
      const msg = JSON.parse(raw)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
      } else if (msg.method) {
        ;(listeners.get(msg.method) ?? []).forEach(cb => cb(msg.params))
      }
    })
    ws.on('error', reject)
  })
}

async function openTargetChat(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const els = Array.from(document.querySelectorAll('[data-chat-item]'))
        const target = els.find(e => e.textContent && e.textContent.includes(${JSON.stringify(CHAT_TITLE_SNIPPET)}))
        if (!target) return { found: false, sample: els.slice(0, 10).map(e => e.textContent.trim().slice(0, 40)) }
        target.scrollIntoView({ block: 'center' })
        const r = target.getBoundingClientRect()
        return { found: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), winH: window.innerHeight }
      })()
    `,
    returnByValue: true,
  })
  const hit = result?.value
  console.log('[Chat] Sidebar scan:', JSON.stringify(hit))
  if (!hit?.found) throw new Error(`Target chat not found in sidebar. Sample rows: ${JSON.stringify(hit?.sample)}`)

  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: hit.x, y: hit.y, button: 'left', clickCount: 1 })
  }

  // Wait for messages to mount (virtualized rows with data-index appear)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300))
    const { result: r2 } = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelectorAll('[data-index]').length`,
      returnByValue: true,
    })
    if ((r2?.value ?? 0) > 0) { console.log(`[Chat] Loaded, ${r2.value} virtualized rows mounted`); return }
  }
  throw new Error('Chat did not load (no [data-index] rows mounted after 6s)')
}

async function getScrollTarget(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const row = document.querySelector('[data-index]')
        const container = row ? row.closest('.overflow-y-auto') : document.querySelector('.overflow-y-auto.relative.no-drag')
        if (!container) return null
        const r = container.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), scrollHeight: container.scrollHeight, clientHeight: container.clientHeight }
      })()
    `,
    returnByValue: true,
  })
  if (!result?.value) throw new Error('Could not locate scroll container')
  return result.value
}

// Fast alternating down/up wheel bursts — deterministic, identical across runs.
async function fastScrollBurst(cdp, point, { cycles = 4, eventsPerLeg = 15, deltaY = 700, delayMs = 12 } = {}) {
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < eventsPerLeg; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY })
      await new Promise(r => setTimeout(r, delayMs))
    }
    for (let i = 0; i < eventsPerLeg; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -deltaY })
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
}

async function main() {
  console.log(`[Perf] Connecting to Electron renderer on port ${CDP_PORT}…`)
  const target = await getRendererTarget()
  const cdp = await createSession(target.webSocketDebuggerUrl)

  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })

  await openTargetChat(cdp)
  await new Promise(r => setTimeout(r, 500)) // let charts finish decoding/mounting
  const point = await getScrollTarget(cdp)
  console.log('[Perf] Scroll container:', JSON.stringify(point))

  const traceEvents = []
  cdp.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value))

  console.log('[Perf] Starting trace…')
  await cdp.send('Tracing.start', {
    traceConfig: {
      recordMode: 'recordContinuously',
      // Excludes disabled-by-default-v8.cpu_profiler(.hires) — that's what
      // blew up trace size last run; the separate Profiler.start/stop below
      // already gives us CPU samples without duplicating them as trace events.
      includedCategories: [
        'devtools.timeline',
        'blink.user_timing',
        'v8.execute',
        'disabled-by-default-devtools.timeline',
        'blink', 'renderer', 'cc', 'toplevel',
      ],
    },
    transferMode: 'ReportEvents',
  })
  await cdp.send('Profiler.start')

  console.log('[Perf] Running fast up/down scroll burst…')
  await fastScrollBurst(cdp, point)

  await new Promise(r => setTimeout(r, 500))

  console.log('[Perf] Stopping profiler…')
  const { profile: cpuProfile } = await cdp.send('Profiler.stop')
  await new Promise(resolve => {
    cdp.on('Tracing.tracingComplete', resolve)
    cdp.send('Tracing.end')
  })
  cdp.close()

  console.log(`[Perf] ${traceEvents.length} trace events, ${cpuProfile?.samples?.length ?? 0} CPU samples — writing…`)

  // Write trace + CPU profile as separate files (matches perf-capture.mjs's
  // existing convention) — combining them into one JSON.stringify call blew
  // past V8's max string length on the previous run.
  const tracePath = `scripts/${OUT_NAME}.json`
  writeFileSync(tracePath, JSON.stringify({ traceEvents, metadata: {} }))

  const cpuPath = `scripts/${OUT_NAME}-cpu-profile.json`
  writeFileSync(cpuPath, JSON.stringify(cpuProfile))

  const metaPath = `scripts/${OUT_NAME}-meta.json`
  writeFileSync(metaPath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    cdpPort: CDP_PORT,
    repro: { chatTitleSnippet: CHAT_TITLE_SNIPPET, scrollPoint: point },
    traceEventCount: traceEvents.length,
    cpuSampleCount: cpuProfile?.samples?.length ?? 0,
  }, null, 2))

  console.log(`\n[Perf] Wrote ${tracePath}, ${cpuPath}, ${metaPath}`)
}

main().catch(e => { console.error('[Perf] Fatal:', e); process.exit(1) })
