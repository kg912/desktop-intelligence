// usage: CDP_PORT=9222 node scripts/perf-gpu-dump.mjs <out.txt>  — navigates the app's page to chrome://gpu (the app's own GPU
// process; Target.createTarget is not supported in Electron) and dumps the report text, shadow DOM included.
// The page is gone afterwards: relaunch the app.
import { WebSocket } from 'ws'
import { writeFileSync } from 'fs'
const page = (await (await fetch(`http://localhost:${process.env.CDP_PORT || '9222'}/json`)).json()).find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.on('open', r))
let id = 0; const pend = new Map()
ws.on('message', m => { m = JSON.parse(m); pend.get(m.id)?.(m) })
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Page.navigate', { url: 'chrome://gpu' })
await new Promise(r => setTimeout(r, 10000))
const expr = `(() => {
  const walk = n => {
    let t = ''
    if (n.shadowRoot) t += walk(n.shadowRoot)
    for (const c of n.childNodes) {
      if (c.nodeType === 3) t += c.textContent
      else if (c.nodeType === 1 || c.nodeType === 11) {
        if (c.tagName === 'SCRIPT' || c.tagName === 'STYLE') continue
        t += walk(c)
        if (/^(TR|DIV|LI|H[1-6]|P|BR)$/.test(c.tagName || '')) t += '\\n'
        else if (/^(TD|TH)$/.test(c.tagName || '')) t += '\\t'
      }
    }
    return t
  }
  return location.href + '\\n' + walk(document.documentElement)
})()`
const ev = await send('Runtime.evaluate', { returnByValue: true, expression: expr })
const txt = (ev.result?.result?.value ?? JSON.stringify(ev)).replace(/\n\s*\n+/g, '\n')
writeFileSync(process.argv[2], txt); console.log(txt.length, txt.slice(0, 300))
process.exit(0)
