// Built-in file system access — settings shape and pure helpers shared by
// main (policy, sanitising saves) and the renderer (Settings tab validation).
// See specs/builtin-file-system-access.md section 2.1.

export type FsAccessLevel = 'read' | 'write'

export interface FsRoot {
  /** Absolute, symlink-resolved directory. */
  path: string
  access: FsAccessLevel
  /** Ask before fs_edit / fs_write change a file under this root. */
  askBeforeEdit: boolean
  addedAt: number
}

export interface FsAccessSettings {
  enabled: boolean
  roots: FsRoot[]
  blockedNames: string[]
}

export const DEFAULT_BLOCKED_NAMES: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  '.netrc',
  '.npmrc',
  '.pypirc',
]

export function defaultFsAccessSettings(): FsAccessSettings {
  return { enabled: true, roots: [], blockedNames: [...DEFAULT_BLOCKED_NAMES] }
}

export function describeAccess(access: FsAccessLevel): string {
  return access === 'write' ? 'read and write' : 'read-only'
}

/** Reason a blocked-name pattern is invalid, or null when it is fine. */
export function validateBlockedName(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || pattern.trim() === '') return 'Enter a file name pattern.'
  if (pattern.length > 100) return 'Keep the pattern under 100 characters.'
  if (pattern.includes('\0')) return 'The pattern contains an invalid character.'
  if (/[/\\]/.test(pattern)) return 'Use a file or folder name, not a path (no "/").'
  if (/[[\]{}]/.test(pattern)) return 'Only * and ? are supported as wildcards.'
  return null
}

function compileSegmentGlob(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${body}$`, 's')
}

/**
 * Compile a blocked-name list once. The returned function tells whether one
 * path segment matches, returning the pattern that matched (for the error
 * message) or null. Segment-level: `*` never spans a "/".
 */
export function blockedNameMatcher(patterns: string[]): (segment: string) => string | null {
  const compiled = patterns.map((p) => [p, compileSegmentGlob(p)] as const)
  return (segment) => compiled.find(([, re]) => re.test(segment))?.[0] ?? null
}

function trimTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** Fill defaults, drop malformed entries, merge duplicate roots by path. */
export function sanitizeFsAccessSettings(raw: unknown): FsAccessSettings {
  const out = defaultFsAccessSettings()
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (r.enabled === false) out.enabled = false

  if (Array.isArray(r.roots)) {
    const byPath = new Map<string, FsRoot>()
    for (const item of r.roots) {
      if (!item || typeof item !== 'object') continue
      const e = item as Record<string, unknown>
      if (typeof e.path !== 'string' || !e.path.startsWith('/')) continue
      if (e.access !== 'read' && e.access !== 'write') continue
      const root: FsRoot = {
        path: trimTrailingSlash(e.path),
        access: e.access,
        askBeforeEdit: e.askBeforeEdit !== false,
        addedAt: typeof e.addedAt === 'number' && Number.isFinite(e.addedAt) ? e.addedAt : 0,
      }
      const prev = byPath.get(root.path)
      if (!prev) {
        byPath.set(root.path, root)
        continue
      }
      prev.access = prev.access === 'write' || root.access === 'write' ? 'write' : 'read'
      prev.askBeforeEdit = prev.askBeforeEdit || root.askBeforeEdit
      prev.addedAt = Math.min(prev.addedAt, root.addedAt)
    }
    out.roots = [...byPath.values()]
  }

  if (Array.isArray(r.blockedNames)) {
    out.blockedNames = [
      ...new Set(r.blockedNames.filter((n): n is string => validateBlockedName(n) === null)),
    ]
  }
  return out
}

// ── IPC shapes (main ↔ renderer) ─────────────────────────────────────────────

/** FS_ACCESS_REQUEST (main → renderer): one fs_request_access dialog. */
export interface FsAccessRequestEvent {
  requestId: string
  chatId: string
  /** Real path of the requested folder. */
  path: string
  access: FsAccessLevel
  /** The model's reason, cut to 300 characters. */
  reason: string
  timeoutMs: number
}

/** FS_ACCESS_RESPONSE (renderer → main). `path` differs when the person picked another folder. */
export interface FsAccessResponse {
  requestId: string
  decision: 'deny' | 'chat' | 'always'
  access: FsAccessLevel
  path: string
}

/** FS_GET_SETTINGS result. */
export interface FsSettingsView {
  settings: FsAccessSettings
  /** DI's own data folder (always blocked). */
  dataFolder: string
  /** Home folder, to show paths as ~/… */
  home: string
}

/** FS_SAVE_SETTINGS result: what was saved, and roots main refused. */
export interface FsSaveResult {
  settings: FsAccessSettings
  rejected: Array<{ path: string; reason: string }>
}

/** FS_PICK_FOLDER result. */
export type FsPickResult = { ok: true; root: FsRoot } | { ok: false; reason: string } | { ok: false; cancelled: true }

/** FS_LIST_CHAT_GRANTS row. */
export interface FsChatGrantView {
  chatId: string
  chatTitle: string
  path: string
  access: FsAccessLevel
  addedAt: number
}

/** Show a path as ~/… under home, cut in the middle when longer than `max`. */
export function displayPath(path: string, home: string, max = 56): string {
  const p = home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path
  if (p.length <= max) return p
  const parts = p.split('/')
  const tail = parts.slice(-2).join('/')
  const head = parts[0] === '' ? '/' + parts[1] : parts[0]
  return tail.length + head.length + 3 > max ? `…/${parts.at(-1)}` : `${head}/…/${tail}`
}

/** The built-in file tool names (main's fsToolSchemas is the source; a test keeps them equal). */
export const FS_TOOL_NAME_LIST: readonly string[] = ['fs_request_access', 'fs_list', 'fs_glob', 'fs_grep', 'fs_read', 'fs_edit', 'fs_write']
