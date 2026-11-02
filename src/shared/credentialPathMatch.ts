// Pure credential-path matcher (no Electron imports), shared by
// isCredentialPath (main process, BASELINE_DENY_READ) and the fs worker
// (which receives the same list in its policy, since it cannot import
// Electron). Entries are tilde-relative or absolute; two contain a `*`
// segment (the Chrome Cookies / Login Data paths).

import { join } from 'path'

function expandTilde(p: string, home: string): string {
  return p.startsWith('~') ? join(home, p.slice(1)) : p
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

/** The expanded entry `target` (absolute) falls under, or null. */
export function matchCredentialPath(target: string, entries: readonly string[], home: string): string | null {
  for (const entry of entries) {
    const expanded = expandTilde(entry, home)
    if (expanded.includes('*')) {
      if (globToRegExp(expanded).test(target)) return expanded
    } else if (target === expanded || target.startsWith(expanded + '/')) {
      return expanded
    }
  }
  return null
}

/** Expanded entries, with each glob entry cut to its fixed prefix (the part before the first `*` segment). */
export function credentialPrefixes(entries: readonly string[], home: string): string[] {
  return entries.map((e) => {
    const expanded = expandTilde(e, home)
    const star = expanded.indexOf('*')
    return star === -1 ? expanded : expanded.slice(0, star).replace(/\/+$/, '')
  })
}
