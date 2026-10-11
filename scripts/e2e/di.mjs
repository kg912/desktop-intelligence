#!/usr/bin/env node
/**
 * di.mjs — drive the running Desktop Intelligence app over CDP for manual-style
 * end-to-end checks (used by .claude/skills/e2e-smoke). Zero dependencies:
 * Node's global fetch + WebSocket.
 *
 *   renderer  → Chromium remote debugging, port 9222
 *   main      → Node inspector,             port 9229 (dialog stubs, main-eval)
 *
 * Every launch uses a throwaway profile (--user-data-dir under /tmp/di-e2e),
 * seeded from .env.e2e.local, so the real app profile is never touched.
 * Keys are never printed.
 *
 * Run `node scripts/e2e/di.mjs help` for commands.
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = '/tmp/di-e2e'
const LOG = join(WORK, 'app.log')
const PIDFILE = join(WORK, 'pid')
const RENDERER_PORT = 9222
const MAIN_PORT = 9229
const PROVIDERS = ['lmstudio', 'openrouter', 'ollama', 'mtplx', 'nvidia']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1) }

// ── env file ────────────────────────────────────────────────────────────────
function loadEnv() {
  const p = join(ROOT, '.env.e2e.local')
  if (!existsSync(p)) die(`missing ${p} — copy .env.e2e.example and fill it in`)
  const env = {}
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

function seedSettings(provider, env) {
  const s = { backendProvider: provider, contextLength: Number(env.LMSTUDIO_CONTEXT || 32768) }
  const need = (k) => env[k] || die(`${k} is empty in .env.e2e.local (needed for ${provider})`)
  if (provider === 'lmstudio') s.modelId = need('LMSTUDIO_MODEL')
  if (provider === 'openrouter') Object.assign(s, { openrouterApiKey: need('OPENROUTER_API_KEY'), openrouterModel: need('OPENROUTER_MODEL') })
  if (provider === 'ollama') Object.assign(s, { ollamaApiKey: env.OLLAMA_API_KEY || '', ollamaBaseUrl: env.OLLAMA_BASE_URL || 'https://ollama.com', ollamaModel: need('OLLAMA_MODEL') })
  if (provider === 'mtplx') Object.assign(s, { mtplxBaseUrl: env.MTPLX_BASE_URL || 'http://localhost:8000', mtplxModel: need('MTPLX_MODEL') })
  if (provider === 'nvidia') Object.assign(s, { nvidiaApiKey: need('NVIDIA_API_KEY'), nvidiaModel: need('NVIDIA_MODEL') })
  // FirstLaunchModal shows while modelId is unset; cloud providers use their model as modelId.
  s.modelId ??= s.openrouterModel ?? s.ollamaModel ?? s.mtplxModel ?? s.nvidiaModel
  if (env.BRAVE_SEARCH_API_KEY) Object.assign(s, { braveSearchEnabled: true, braveSearchApiKey: env.BRAVE_SEARCH_API_KEY })
  return s
}

// ── CDP ─────────────────────────────────────────────────────────────────────
async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`)
  return r.json()
}

async function rendererTarget() {
  const list = await targets(RENDERER_PORT).catch(() => die('app not reachable on :9222 — run `launch` first'))
  // The app window, not DevTools / the hidden PDF print window.
  const page = list.find((t) => t.type === 'page' && /^(http:\/\/localhost:\d+\/|file:\/\/)/.test(t.url) && !t.url.includes('print='))
  return page ?? die(`no app page among targets: ${list.map((t) => `${t.type} ${t.url}`).join(', ')}`)
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot connect ${wsUrl}`)) })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
    }
  }
  const send = (method, params = {}) => new Promise((res, rej) => {
    pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params }))
  })
  return { send, close: () => ws.close() }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

async function withRenderer(fn) {
  const cdp = await connect((await rendererTarget()).webSocketDebuggerUrl)
  try { return await fn(cdp) } finally { cdp.close() }
}

async function withMain(fn) {
  const list = await targets(MAIN_PORT).catch(() => die('main-process inspector not reachable on :9229'))
  const cdp = await connect(list[0].webSocketDebuggerUrl)
  try { return await fn(cdp) } finally { cdp.close() }
}

// In-page helpers, injected before each renderer evaluation.
const PAGE_HELPERS = `
  const __vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const __label = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '').trim();
  const __state = () => {
    const btn = document.querySelector('button[aria-label="Stop generating"], button[aria-label="Send message"]');
    const chat = document.querySelector('[data-testid="chat-scroll"]');
    const text = chat ? chat.innerText : '';
    return {
      streaming: btn?.getAttribute('aria-label') === 'Stop generating',
      sendEnabled: btn ? !btn.disabled : null,
      alerts: [...document.querySelectorAll('[role="alert"]')].filter(__vis).map((e) => e.innerText.trim()).slice(0, 5),
      dialogs: [...document.querySelectorAll('[role="dialog"], .fixed.inset-0')].filter(__vis).map((e) => e.innerText.trim().slice(0, 300)).filter(Boolean).slice(0, 3),
      chatTail: text.slice(-1500),
    };
  };
`

const page = (cdp, body) => evaluate(cdp, `(async () => { ${PAGE_HELPERS} ${body} })()`)

// ── commands ────────────────────────────────────────────────────────────────
const commands = {
  async launch(args) {
    const provider = args.find((a) => PROVIDERS.includes(a))
    const fresh = args.includes('--fresh')
    const pi = args.indexOf('--packaged')
    const packaged = pi >= 0 ? args[pi + 1] : null
    if (!provider && !fresh) die(`launch <${PROVIDERS.join('|')}> | launch --fresh   [--packaged <path.app>]`)
    await commands.stop([], true)

    const profile = join(WORK, `profile-${fresh ? 'fresh' : provider}`)
    rmSync(profile, { recursive: true, force: true })
    mkdirSync(profile, { recursive: true })
    if (!fresh) {
      const s = seedSettings(provider, loadEnv())
      writeFileSync(join(profile, 'app-settings.json'), JSON.stringify(s, null, 2))
      console.log(`seeded ${profile}/app-settings.json: provider=${provider} model=${s.modelId} brave=${!!s.braveSearchEnabled}`)
    } else {
      console.log(`fresh profile ${profile} (first-launch flow)`)
    }

    let cmd, cmdArgs
    if (packaged) {
      const macos = join(packaged, 'Contents', 'MacOS')
      if (!existsSync(macos)) die(`no ${macos}`)
      const bin = execSync(`ls "${macos}"`).toString().trim().split('\n')[0]
      cmd = join(macos, bin)
      cmdArgs = [`--remote-debugging-port=${RENDERER_PORT}`, `--inspect=${MAIN_PORT}`, `--user-data-dir=${profile}`]
    } else {
      // `npm test` leaves better-sqlite3 built for Node with a stale Electron
      // .forge-meta marker, so install-app-deps would skip it. Anaconda's libtool
      // breaks the native build, so it is stripped from PATH.
      console.log('rebuilding native modules for Electron…')
      rmSync(join(ROOT, 'node_modules/better-sqlite3/build/Release/.forge-meta'), { force: true })
      const PATH = process.env.PATH.split(':').filter((p) => !p.includes('anaconda')).join(':')
      execSync('npx electron-builder install-app-deps', { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PATH } })
      cmd = join(ROOT, 'node_modules', '.bin', 'electron-vite')
      cmdArgs = ['dev', '--remoteDebuggingPort', String(RENDERER_PORT), '--inspect', String(MAIN_PORT), '--', `--user-data-dir=${profile}`]
    }
    const out = openSync(LOG, 'w')
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, detached: true, stdio: ['ignore', out, out] })
    child.unref()
    writeFileSync(PIDFILE, String(child.pid))
    console.log(`started pid ${child.pid}; log → ${LOG}`)

    for (let i = 0; i < 180; i++) {
      await sleep(1000)
      try {
        const list = await targets(RENDERER_PORT)
        if (list.some((t) => t.type === 'page' && /^(http:\/\/localhost|file:)/.test(t.url))) {
          await sleep(3000) // let React mount
          console.log('READY')
          return commands.state()
        }
      } catch { /* not up yet */ }
    }
    die(`app did not open a window within 180s — see ${LOG}`)
  },

  async stop(_args, quiet = false) {
    if (existsSync(PIDFILE)) {
      const pid = Number(readFileSync(PIDFILE, 'utf8'))
      try { process.kill(-pid, 'SIGTERM') } catch { /* gone */ }
      rmSync(PIDFILE, { force: true })
    }
    // Any Electron still holding an e2e profile (electron-vite can leave it orphaned).
    try { execSync(`pkill -f -- 'user-data-dir=(/private)?${WORK}/profile-'`) } catch { /* none */ }
    for (let i = 0; i < 20; i++) {
      try { await targets(RENDERER_PORT); await sleep(500) } catch { break }
    }
    if (!quiet) console.log('stopped')
  },

  state: () => withRenderer(async (cdp) => console.log(JSON.stringify(await page(cdp, 'return __state()'), null, 2))),

  async eval([expr]) {
    await withRenderer(async (cdp) => console.log(JSON.stringify(await page(cdp, `return (${expr})`), null, 2)))
  },

  async 'main-eval'([expr]) {
    // Main bundle is CJS: reach modules through process.mainModule.require.
    await withMain(async (cdp) => console.log(JSON.stringify(await evaluate(cdp,
      `(async () => { const require = process.mainModule.require; return (${expr}) })()`), null, 2)))
  },

  async send([text]) {
    if (!text) die('send "<message>"')
    await withRenderer(async (cdp) => {
      const ok = await page(cdp, `const t = document.querySelector('textarea'); if (!t) return false; t.focus(); return true`)
      if (!ok) die('no textarea on screen')
      await cdp.send('Input.insertText', { text })
      await sleep(150)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    })
    console.log('sent')
  },

  async 'wait-idle'([secs = '180']) {
    const deadline = Date.now() + Number(secs) * 1000
    let sawStreaming = false
    await withRenderer(async (cdp) => {
      const start = Date.now()
      while (Date.now() < deadline) {
        const s = await page(cdp, 'return __state()')
        if (s.streaming) sawStreaming = true
        // Idle once streaming has finished, or if it never started within 10 s.
        if (!s.streaming && (sawStreaming || Date.now() - start > 10_000)) {
          console.log(JSON.stringify({ sawStreaming, ...s }, null, 2)); return
        }
        await sleep(1000)
      }
      die(`still streaming after ${secs}s`)
    })
  },

  async 'wait-streaming'([secs = '60']) {
    await withRenderer(async (cdp) => {
      for (let i = 0; i < Number(secs) * 2; i++) {
        if ((await page(cdp, 'return __state()')).streaming) { console.log('streaming'); return }
        await sleep(500)
      }
      die(`never started streaming within ${secs}s`)
    })
  },

  async 'wait-text'([text, secs = '60']) {
    await withRenderer(async (cdp) => {
      for (let i = 0; i < Number(secs); i++) {
        if (await page(cdp, `return document.body.innerText.includes(${JSON.stringify(text)})`)) { console.log('found'); return }
        await sleep(1000)
      }
      die(`"${text}" not on screen after ${secs}s`)
    })
  },

  // click "<text>" — matches aria-label, title or visible text of a clickable element.
  // Exact match wins over substring; ambiguity is reported, not guessed.
  async click([text]) {
    if (!text) die('click "<label or text>"')
    const r = await withRenderer((cdp) => page(cdp, `
      const want = ${JSON.stringify(text)}.toLowerCase();
      const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], label, input[type="radio"], input[type="checkbox"]')].filter(__vis);
      const exact = els.filter((e) => __label(e).toLowerCase() === want);
      const partial = els.filter((e) => __label(e).toLowerCase().includes(want));
      const hits = exact.length ? exact : partial;
      if (hits.length === 0) return { error: 'no match', candidates: els.map(__label).filter(Boolean).slice(0, 60) };
      if (hits.length > 1 && !exact.length) return { error: 'ambiguous', matches: hits.map(__label).slice(0, 10) };
      if (hits[0].disabled) return { error: 'disabled', label: __label(hits[0]) };
      hits[0].click();
      return { clicked: __label(hits[0]).slice(0, 80) };
    `))
    console.log(JSON.stringify(r, null, 2))
    if (r.error) process.exit(1)
  },

  // type "<css selector>" "<text>"   |   type "<css selector>" --env VAR   (value never printed)
  async type([selector, ...rest]) {
    let text = rest[0]
    if (rest[0] === '--env') {
      text = loadEnv()[rest[1]] ?? die(`${rest[1]} not in .env.e2e.local`)
    }
    if (!selector || text === undefined) die('type "<selector>" "<text>" | type "<selector>" --env VAR')
    await withRenderer(async (cdp) => {
      const ok = await page(cdp, `const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.focus(); if ('select' in e) e.select(); return true`)
      if (!ok) die(`no element for ${selector}`)
      await cdp.send('Input.insertText', { text })
    })
    console.log(rest[0] === '--env' ? `typed $${rest[1]} into ${selector}` : `typed into ${selector}`)
  },

  async key([key]) {
    const codes = { Enter: 13, Escape: 27, Tab: 9 }
    if (!codes[key]) die(`key ${Object.keys(codes).join('|')}`)
    await withRenderer(async (cdp) => {
      for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: codes[key] })
    })
    console.log(`pressed ${key}`)
  },

  async attach([file]) {
    const abs = resolve(file ?? die('attach <file>'))
    if (!existsSync(abs)) die(`no file ${abs}`)
    await withRenderer(async (cdp) => {
      const { root } = await cdp.send('DOM.getDocument')
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' })
      if (!nodeId) die('no file input on screen')
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [abs] })
    })
    console.log(`attached ${abs}`)
  },

  async screenshot([out]) {
    const path = out ?? join(WORK, `shot-${Date.now()}.png`)
    await withRenderer(async (cdp) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path, Buffer.from(data, 'base64'))
    })
    console.log(path)
  },

  // Native save dialogs can't be clicked; make the next ones answer with <path>.
  async 'stub-save-dialog'([path]) {
    const target = resolve(path ?? join(WORK, 'export.pdf'))
    await commands['main-eval']([`(() => {
      const { dialog } = require('electron');
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(target)} });
      return 'showSaveDialog → ${target}';
    })()`])
  },

  async log([pattern, tail = '40']) {
    if (!existsSync(LOG)) die(`no ${LOG}`)
    const lines = readFileSync(LOG, 'utf8').split('\n')
    const hits = pattern ? lines.filter((l) => l.includes(pattern)) : lines
    console.log(hits.slice(-Number(tail)).join('\n') || `(no lines matching "${pattern}")`)
  },

  help() {
    console.log(`node scripts/e2e/di.mjs <command>
  launch <${PROVIDERS.join('|')}> [--packaged <path.app>]   fresh seeded profile, waits for the window
  launch --fresh [--packaged <path.app>]                 empty profile → first-launch modal
  stop
  state                         streaming / alerts / dialogs / last 1500 chars of chat
  send "<msg>"                  type into the composer and press Enter
  wait-streaming [secs]         until the stop button shows
  wait-idle [secs]              until streaming ends (prints state)
  wait-text "<text>" [secs]
  click "<label|title|text>"    exact match preferred; lists candidates on miss
  type "<css>" "<text>" | type "<css>" --env VAR
  key Enter|Escape|Tab
  attach <file>                 into the composer's file input
  screenshot [path.png]
  stub-save-dialog [path]       next native save dialogs return <path>
  eval "<js expr>"  |  main-eval "<js expr>"   (main: require() available)
  log [substring] [tail=40]     main-process log (${LOG})`)
  },
}

mkdirSync(WORK, { recursive: true })
const [cmd, ...rest] = process.argv.slice(2)
await (commands[cmd ?? 'help'] ?? (() => die(`unknown command ${cmd}`)))(rest)
process.exit(0)
