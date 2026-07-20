import { readFileSync } from 'fs'

const NAME = process.argv[2]
if (!NAME) { console.error('usage: node perf-analyze.mjs <perf-sandbox-branch|perf-baseline>'); process.exit(1) }

const trace = JSON.parse(readFileSync(`scripts/${NAME}.json`, 'utf8')).traceEvents
const cpuProfile = JSON.parse(readFileSync(`scripts/${NAME}-cpu-profile.json`, 'utf8'))
const meta = JSON.parse(readFileSync(`scripts/${NAME}-meta.json`, 'utf8'))

console.log(`\n════════ ${NAME} ════════`)
console.log(`captured: ${meta.capturedAt}  cdpPort: ${meta.cdpPort}  traceEvents: ${meta.traceEventCount}  cpuSamples: ${meta.cpuSampleCount}`)

// ---- Process/thread breakdown ----
const procNames = new Map() // pid -> name
const threadNames = new Map() // `${pid}:${tid}` -> name
for (const e of trace) {
  if (e.name === 'process_name' && e.args?.name) procNames.set(e.pid, e.args.name)
  if (e.name === 'thread_name' && e.args?.name) threadNames.set(`${e.pid}:${e.tid}`, e.args.name)
}
console.log('\n-- Processes seen in trace --')
for (const [pid, name] of procNames) console.log(`  pid=${pid}  ${name}`)
console.log('-- Threads seen in trace --')
for (const [key, name] of threadNames) console.log(`  ${key}  ${name}`)

// ---- Duration of complete/begin-end events by name, grouped by pid:tid ----
// Use 'X' (complete) events which carry dur directly; also pair B/E for others.
const durByKey = new Map() // `${pid}:${tid}::${name}` -> {count,totalUs,maxUs}
function bump(pid, tid, name, us) {
  const key = `${pid}:${tid}::${name}`
  const prev = durByKey.get(key) ?? { pid, tid, name, count: 0, totalUs: 0, maxUs: 0 }
  prev.count++; prev.totalUs += us; prev.maxUs = Math.max(prev.maxUs, us)
  durByKey.set(key, prev)
}
for (const e of trace) {
  if (e.ph === 'X' && typeof e.dur === 'number') bump(e.pid, e.tid, e.name, e.dur)
}

const rows = [...durByKey.values()].sort((a, b) => b.totalUs - a.totalUs).slice(0, 25)
console.log('\n-- Top 25 event types by total duration (X/complete events) --')
for (const r of rows) {
  const proc = procNames.get(r.pid) ?? r.pid
  const thread = threadNames.get(`${r.pid}:${r.tid}`) ?? r.tid
  console.log(`  ${(r.totalUs/1000).toFixed(1).padStart(9)} ms total  max=${(r.maxUs/1000).toFixed(1).padStart(7)} ms  n=${String(r.count).padStart(6)}  ${r.name.padEnd(28)} [${proc} / ${thread}]`)
}

// ---- Longest single tasks overall ----
const longest = trace.filter(e => e.ph === 'X' && typeof e.dur === 'number').sort((a, b) => b.dur - a.dur).slice(0, 15)
console.log('\n-- Longest 15 individual tasks --')
for (const e of longest) {
  const proc = procNames.get(e.pid) ?? e.pid
  const thread = threadNames.get(`${e.pid}:${e.tid}`) ?? e.tid
  console.log(`  ${(e.dur/1000).toFixed(2).padStart(9)} ms  ${e.name.padEnd(28)} [${proc} / ${thread}]  ts=${e.ts}`)
}

// ---- Layout/Style recalc clustering ----
const layoutEvents = trace.filter(e => e.ph === 'X' && (e.name === 'Layout' || e.name === 'UpdateLayoutTree' || e.name === 'RecalculateStyles'))
console.log(`\n-- Layout / RecalculateStyles / UpdateLayoutTree events: ${layoutEvents.length} total, ${(layoutEvents.reduce((s,e)=>s+e.dur,0)/1000).toFixed(1)} ms combined --`)

// ---- CPU profile top functions by self time ----
function parseTopFunctions(cpuProfile) {
  const nodeMap = new Map((cpuProfile.nodes ?? []).map(n => [n.id, n]))
  const frameMap = new Map()
  const samples = cpuProfile.samples ?? []
  const deltas = cpuProfile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const node = nodeMap.get(samples[i])
    if (!node) continue
    const fn = node.callFrame?.functionName || '(anonymous)'
    const url = (node.callFrame?.url || '').replace(/.*\//, '')
    const line = node.callFrame?.lineNumber ?? -1
    const key = `${fn}@@${url}:${line}`
    const prev = frameMap.get(key) ?? { fn, src: url + (line >= 0 ? `:${line}` : ''), us: 0, count: 0 }
    prev.us += deltas[i] ?? 0
    prev.count++
    frameMap.set(key, prev)
  }
  return [...frameMap.values()].sort((a, b) => b.us - a.us).slice(0, 25)
}
console.log('\n-- Top 25 JS functions by self-time (CPU profile) --')
for (const { fn, src, us, count } of parseTopFunctions(cpuProfile)) {
  console.log(`  ${(us/1000).toFixed(1).padStart(9)} ms  n=${String(count).padStart(6)}  ${fn.padEnd(35)} (${src})`)
}
