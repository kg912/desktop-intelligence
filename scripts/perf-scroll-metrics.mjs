// usage: node scripts/perf-scroll-metrics.mjs scripts/<OUT_NAME>.json...  → one JSON line per perf-scroll-capture trace
import { readFileSync } from 'fs'

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const r1 = x => x == null ? null : Math.round(x * 10) / 10

function busy(trace, [pid, tid] = []) {
  // union of top-level task intervals on one thread
  const iv = trace.filter(e => e.ph === 'X' && e.pid === pid && e.tid === tid && (e.name === 'ThreadControllerImpl::RunTask' || e.name === 'RunTask') && e.dur)
    .map(e => [e.ts, e.ts + e.dur]).sort((a, b) => a[0] - b[0])
  let total = 0, cur = null, tops = []
  for (const [s, e] of iv) {
    if (!cur || s > cur[1]) { if (cur) { total += cur[1] - cur[0]; tops.push(cur[1] - cur[0]) } cur = [s, e] } else cur[1] = Math.max(cur[1], e)
  }
  if (cur) { total += cur[1] - cur[0]; tops.push(cur[1] - cur[0]) }
  return { ms: total / 1000, tops: tops.map(x => x / 1000) }
}

for (const f of process.argv.slice(2)) {
  const trace = JSON.parse(readFileSync(f, 'utf8')).traceEvents
  const th = {}
  for (const e of trace) if (e.name === 'thread_name') th[e.args.name] ??= [e.pid, e.tid]
  const main = busy(trace, th.CrRendererMain)
  const gpu = busy(trace, th.CrGpuMain), viz = busy(trace, th.VizCompositorThread), comp = busy(trace, th.Compositor)

  const open = new Map(), lat = {}
  for (const e of trace) {
    if (e.name !== 'EventLatency') continue
    const k = e.pid + ':' + e.id2?.local
    if (e.ph === 'b') open.set(k, e)
    else if (e.ph === 'e' && open.has(k)) { const b = open.get(k); open.delete(k); (lat[b.args.event_latency.event_type] ??= []).push((e.ts - b.ts) / 1000) }
  }
  const states = {}
  let smoothDropped = 0
  for (const e of trace) if (e.name === 'PipelineReporter' && e.ph === 'b') {
    const r = e.args?.frame_reporter ?? e.args?.chrome_frame_reporter ?? {}
    states[r.state] = (states[r.state] ?? 0) + 1
    if (r.affects_smoothness && /DROPPED/.test(r.state)) smoothDropped++
  }
  console.log(JSON.stringify({
    file: f.replace(/.*\//, ''),
    mainBusyMs: r1(main.ms), longTaskMaxMs: r1(Math.max(...main.tops)), tasksOver16: main.tops.filter(x => x > 16).length, tasksOver8_3: main.tops.filter(x => x > 8.33).length,
    gpuMainBusyMs: r1(gpu.ms), vizBusyMs: r1(viz.ms), compositorBusyMs: r1(comp.ms),
    wheelP50: r1(pct(lat.MOUSE_WHEEL ?? [], .5)), wheelP95: r1(pct(lat.MOUSE_WHEEL ?? [], .95)),
    firstScrollUpdP95: r1(pct(lat.FIRST_GESTURE_SCROLL_UPDATE ?? [], .95)), nWheel: lat.MOUSE_WHEEL?.length ?? 0,
    presented: (states.STATE_PRESENTED_ALL ?? 0) + (states.STATE_PRESENTED_PARTIAL ?? 0), dropped: states.STATE_DROPPED ?? 0, smoothDropped,
  }))
}
