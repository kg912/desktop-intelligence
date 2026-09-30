/**
 * Blocked ("unsafe") network ports.
 *
 * Both HTTP clients that carry real traffic in this app refuse these ports
 * outright, before any socket is opened:
 *
 *   - Node's global `fetch` (undici) — used by the SETTINGS_GET_*_MODELS IPC
 *     handlers. Fails with the message "fetch failed" and `err.cause.message`
 *     of "bad port".
 *   - Electron's `net.fetch` (Chromium's network stack) — used by ChatService
 *     for every chat completion. Fails with `net::ERR_UNSAFE_PORT`.
 *
 * `axios` and `curl` do NOT enforce the list, which is what makes this so
 * confusing in practice: `curl http://localhost:6000/v1/models` succeeds, the
 * axios-based health checks in ModelConnectionManager and MTPLXDaemonManager
 * report the backend as ready — and then every fetch-based call fails.
 *
 * The list below was derived empirically against this project's Node runtime
 * rather than copied from memory: every port 1–65535 was probed with `fetch`
 * and the ones rejected with cause "bad port" (as opposed to ECONNREFUSED)
 * were collected. It matches the WHATWG fetch spec's bad-ports list, and
 * Chromium's own restricted-port list is equivalent for our purposes.
 *
 * Notably NOT blocked, so unaffected: 1234 (LM Studio), 8000 (MTPLX default),
 * 11434 (Ollama). Blocked ports a user might plausibly pick by hand include
 * 6000 (X11), 6666–6669/6697 (IRC), and 10080.
 */

export const UNSAFE_PORTS: readonly number[] = [
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]

const UNSAFE_PORT_SET = new Set(UNSAFE_PORTS)

/** True when `fetch` / Electron's net.fetch will refuse this port outright. */
export function isUnsafePort(port: number): boolean {
  return UNSAFE_PORT_SET.has(port)
}

/**
 * Extracts the effective port from a base URL, or null when it cannot be parsed.
 * Falls back to the protocol default when the URL carries no explicit port.
 */
export function portFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url)
    if (parsed.port) return Number(parsed.port)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

/**
 * Returns an actionable message when `url`'s port is blocked, else null.
 *
 * Used to replace the useless raw failures ("fetch failed" / "bad port" /
 * "net::ERR_UNSAFE_PORT") with something a user can act on, since the fix is
 * always the same: serve on a different port.
 */
export function describeUnsafePort(url: string, backendLabel: string): string | null {
  const port = portFromUrl(url)
  if (port === null || !isUnsafePort(port)) return null
  return (
    `Port ${port} is on the browser/Node blocked-port list, so Desktop Intelligence ` +
    `cannot connect to it even though tools like curl can. ` +
    `Restart ${backendLabel} on a different port (e.g. 8000) and update the base URL here.`
  )
}
