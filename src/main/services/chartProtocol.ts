/**
 * di-chart:// — serves the stock chart pages written by writeChartFile() to a
 * sandboxed <iframe> in the renderer (they used to load in a <webview>).
 *
 *   di-chart://charts/<NAME>.html      → userData/charts/<NAME>.html
 *   di-chart://charts/yahoo/<SYM>?...  → Yahoo Finance chart API (proxied)
 *
 * The page is served with a shim injected first in <head>, so files already on
 * disk keep working: its Yahoo fetches go through the same-origin proxy above
 * (as a file:// page in the webview it could call Yahoo directly; a framed page
 * on its own origin cannot — Yahoo sends no CORS headers), and its zoom
 * console.log messages, which only a <webview> could observe, are posted to the
 * host window instead.
 */
import { app, net } from 'electron'
import { promises as fs } from 'fs'
import { basename, join } from 'path'

export const CHART_SCHEME = 'di-chart'

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/'

const SHIM = `<script>(function () {
  var f = window.fetch;
  window.fetch = function (u, o) {
    if (typeof u === 'string' && u.indexOf('${YAHOO}') === 0) u = '/yahoo/' + u.slice(${YAHOO.length});
    return f.call(this, u, o);
  };
  var log = console.log;
  console.log = function (m) {
    try {
      var d = JSON.parse(m);
      if (d && (d.type === 'webview-zoom' || d.type === 'webview-zoom-wheel')) return parent.postMessage(m, '*');
    } catch (e) {}
    return log.apply(console, arguments);
  };
})();</script>`

export async function handleChartRequest(request: Request): Promise<Response> {
  const { pathname, search } = new URL(request.url)
  if (pathname.startsWith('/yahoo/')) {
    return net.fetch(YAHOO + pathname.slice('/yahoo/'.length) + search, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  }
  // basename() keeps every request inside the charts directory.
  const file = join(app.getPath('userData'), 'charts', basename(decodeURIComponent(pathname)))
  let html: string
  try {
    html = await fs.readFile(file, 'utf8')
  } catch {
    return new Response('Chart not found', { status: 404 })
  }
  return new Response(html.replace('<head>', `<head>${SHIM}`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
