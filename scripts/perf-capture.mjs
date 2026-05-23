/**
 * perf-capture.mjs
 *
 * 1. Connects to running Electron renderer via CDP on port 9222
 * 2. Clicks the "Explain the math behind transformer self-attention" suggestion button
 * 3. Starts a V8 CPU profile + timeline trace immediately after the click
 * 4. Captures the entire streaming response (up to 30s)
 * 5. Stops profiling when streaming ends (detected via DOM signal or timeout)
 * 6. Writes:
 *      scripts/perf-trace.json       — raw trace (chrome://tracing)
 *      scripts/perf-cpu-profile.json — V8 CPU samples
 *      scripts/perf-report.json      — top JS functions by self-time + re-render counts
 */

import { WebSocket } from 'ws'
import { writeFileSync } from 'fs'

const CDP_BASE = 'http://localhost:9222'

async function getRendererTarget() {
  for (let i = 0; i < 15; i++) {
    try {
      const res  = await fetch(`${CDP_BASE}/json`)
      const tabs = await res.json()
      const page = tabs.find(t =>
        t.type === 'page' &&
        !t.url.includes('devtools') &&
        !t.url.includes('worker')
      )
      if (page) { console.log(`[CDP] Target: ${page.url}`); return page }
    } catch {}
    console.log(`[CDP] Waiting for app… (${i + 1}/15)`)
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('Could not connect to renderer on port 9222')
}

function createSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let msgId = 1
    const pending   = new Map()
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

// Click the first suggestion button by finding it in the DOM
async function clickSuggestionButton(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        // Find all buttons, look for one whose text matches a suggestion
        const buttons = Array.from(document.querySelectorAll('button'))
        const target = buttons.find(b =>
          b.textContent.includes('transformer self-attention') ||
          b.textContent.includes('Rust async') ||
          b.textContent.includes('RLHF') ||
          b.textContent.includes('RAG pipeline')
        )
        if (!target) return { found: false, buttons: buttons.map(b => b.textContent.trim().slice(0, 60)) }
        const r = target.getBoundingClientRect()
        return {
          found: true,
          text: target.textContent.trim().slice(0, 80),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        }
      })()
    `,
    returnByValue: true,
  })

  const btn = result?.value
  console.log('[Click] Button scan:', JSON.stringify(btn))

  if (!btn?.found) {
    throw new Error(`Suggestion buttons not found. Visible buttons: ${JSON.stringify(btn?.buttons)}`)
  }

  console.log(`[Click] Clicking "${btn.text}" at (${btn.x}, ${btn.y})`)

  // Dispatch a real mouse click sequence
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: btn.x,
      y: btn.y,
      button: 'left',
      clickCount: 1,
    })
  }

  return btn.text
}

// Poll until streaming ends: check if the abort button is gone (streaming=false)
// or the stats bar has appeared, or timeout after maxMs
async function waitForStreamingEnd(cdp, maxMs = 30000) {
  const startedAt = Date.now()
  let firstTokenSeen = false

  while (Date.now() - startedAt < maxMs) {
    await new Promise(r => setTimeout(r, 400))

    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          // The abort button appears during streaming (InputBar)
          const abortBtn = document.querySelector('[data-streaming="true"], button[aria-label*="abort"], button[aria-label*="stop"], button[title*="Stop"]')
          // A simpler signal: look for the blinking cursor span
          const cursor = document.querySelector('.cursor-blink')
          // Stats bar appears after streaming ends
          const statsBar = document.querySelector('[class*="StatsBar"], [class*="stats"]')
          // Count rendered message bubbles
          const bubbles = document.querySelectorAll('[class*="space-y-6"] > div, [class*="message"]').length
          return {
            cursorVisible: !!cursor,
            bubblesCount: bubbles,
            elapsed: ${Date.now()} - ${startedAt},
          }
        })()
      `,
      returnByValue: true,
    })

    const state = result?.value
    if (state) {
      if (!firstTokenSeen && state.bubblesCount > 0) {
        firstTokenSeen = true
        console.log(`[Stream] First tokens visible (${state.bubblesCount} bubbles)`)
      }
      if (firstTokenSeen && !state.cursorVisible) {
        console.log(`[Stream] Streaming ended after ${Math.round((Date.now() - startedAt) / 1000)}s`)
        return true
      }
      process.stdout.write(`\r[Stream] ${state.bubblesCount} bubbles, cursor=${state.cursorVisible}, ${Math.round((Date.now() - startedAt) / 1000)}s elapsed`)
    }
  }

  console.log('\n[Stream] Timeout reached — stopping profile anyway')
  return false
}

function parseTopFunctions(traceEvents, cpuProfile) {
  const frameMap = new Map()

  const processSamples = (nodes, samples, deltas) => {
    const nodeMap = new Map((nodes ?? []).map(n => [n.id, n]))
    for (let i = 0; i < (samples ?? []).length; i++) {
      const node = nodeMap.get(samples[i])
      if (!node) continue
      const fn   = node.callFrame?.functionName || '(anonymous)'
      const url  = node.callFrame?.url || ''
      const line = node.callFrame?.lineNumber ?? -1
      const key  = `${fn}@@${url.replace(/.*\//, '')}:${line}`
      const prev = frameMap.get(key) ?? { fn, src: url.replace(/.*\//, '') + (line >= 0 ? `:${line}` : ''), us: 0 }
      frameMap.set(key, { ...prev, us: prev.us + (deltas?.[i] ?? 0) })
    }
  }

  // From inline CpuProfile events in the trace
  for (const ev of traceEvents) {
    if (ev.name === 'CpuProfile' || ev.name === 'ProfileChunk') {
      const p = ev.args?.data?.cpuProfile ?? ev.args?.data
      if (p?.nodes) processSamples(p.nodes, p.samples, p.timeDeltas)
    }
  }

  // From the explicit Profiler.stop result
  if (cpuProfile?.nodes) {
    processSamples(cpuProfile.nodes, cpuProfile.samples, cpuProfile.timeDeltas)
  }

  return [...frameMap.values()]
    .sort((a, b) => b.us - a.us)
    .slice(0, 40)
    .map(({ fn, src, us }) => ({
      function: fn,
      source: src,
      selfTime_ms: (us / 1000).toFixed(2),
    }))
}

// Count how many times each named function appears in samples
// (frequency = how many 100µs samples it was on the stack = hot path indicator)
function countCallFrequency(cpuProfile) {
  if (!cpuProfile?.nodes || !cpuProfile?.samples) return []
  const nodeMap = new Map(cpuProfile.nodes.map(n => [n.id, n]))
  const freq = new Map()
  for (const id of cpuProfile.samples) {
    const node = nodeMap.get(id)
    if (!node) continue
    const fn = node.callFrame?.functionName || '(anonymous)'
    freq.set(fn, (freq.get(fn) ?? 0) + 1)
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([fn, count]) => ({ function: fn, sampleCount: count }))
}

async function main() {
  console.log('[Perf] Connecting to Electron renderer…')
  const target = await getRendererTarget()
  const cdp    = await createSession(target.webSocketDebuggerUrl)

  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Profiler.enable')
  console.log('[Perf] 🚀 Activating 20x CPU Slowdown via Emulation.setCPUThrottlingRate...')
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 })
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 }) // sample every 100µs

  // Click the suggestion button to trigger a real LLM streaming response
  const clickedText = await clickSuggestionButton(cdp)
  console.log(`[Perf] Triggered: "${clickedText}"`)

  // Small delay to let the first render commit before we start profiling
  await new Promise(r => setTimeout(r, 200))

  // Start trace + CPU profile
  const traceEvents = []
  cdp.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value))

  console.log('[Perf] Starting trace…')
  await cdp.send('Tracing.start', {
    traceConfig: {
      recordMode: 'recordContinuously',
      includedCategories: [
        'devtools.timeline',
        'blink.user_timing',
        'v8.execute',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-v8.cpu_profiler',
        'disabled-by-default-v8.cpu_profiler.hires',
        'blink', 'renderer', 'cc',
      ],
    },
    transferMode: 'ReportEvents',
  })
  await cdp.send('Profiler.start')

  // Wait for the full streaming response to complete
  await waitForStreamingEnd(cdp, 35000)

  // Extra 500ms to catch any post-stream renders (stats bar, context update)
  await new Promise(r => setTimeout(r, 500))

  console.log('\n[Perf] Stopping profiler…')
  const { profile: cpuProfile } = await cdp.send('Profiler.stop')

  await new Promise(resolve => {
    cdp.on('Tracing.tracingComplete', resolve)
    cdp.send('Tracing.end')
  })

  cdp.close()

  // Write raw outputs
  writeFileSync('scripts/perf-trace.json',
    JSON.stringify({ traceEvents, metadata: {} }))
  writeFileSync('scripts/perf-cpu-profile.json',
    JSON.stringify(cpuProfile, null, 2))

  // Parse
  const topFunctions = parseTopFunctions(traceEvents, cpuProfile)
  const callFrequency = countCallFrequency(cpuProfile)

  const report = {
    capturedAt:   new Date().toISOString(),
    trigger:      clickedText,
    topJsFunctionsBySelfTime: topFunctions,
    topFunctionsByCallFrequency: callFrequency,
  }
  writeFileSync('scripts/perf-report.json', JSON.stringify(report, null, 2))

  console.log('\n── Top 20 JS functions by self-time (during streaming) ──')
  topFunctions.slice(0, 20).forEach(({ function: fn, source, selfTime_ms }) =>
    console.log(`  ${String(selfTime_ms).padStart(9)} ms  ${fn.padEnd(40)} (${source})`)
  )

  console.log('\n── Top 20 by call frequency (on-stack sample count) ──')
  callFrequency.slice(0, 20).forEach(({ function: fn, sampleCount }) =>
    console.log(`  ${String(sampleCount).padStart(6)} samples  ${fn}`)
  )

  console.log('\nFull report → scripts/perf-report.json')
  console.log('Raw trace  → scripts/perf-trace.json  (open in chrome://tracing)')
}

main().catch(e => { console.error('[Perf] Fatal:', e); process.exit(1) })
