// isCredentialPath — Phase 2 (spec section 11/16): decides whether a
// sandbox_violation's target matches BASELINE_DENY_READ (or a directory it
// covers), so credential-path denials can be escalated to an in-app
// notification while routine violations stay in the observability log only.
//
// BASELINE_DENY_READ entries are tilde-relative and two of them contain a
// `*` glob segment (the Chrome Cookies/Login Data paths). Violation targets
// observed from the sandbox are absolute paths, so entries are expanded and
// matched as: exact match, directory-prefix match, or (for the two glob
// entries) a translated regex.

import { homedir } from 'os'
import { join } from 'path'
import { BASELINE_DENY_READ } from './BASELINE_DENY_READ'
import type { SandboxViolationTraceEvent } from '../../../shared/types'

function expandTilde(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

/** True when `target` (an absolute path) matches a BASELINE_DENY_READ entry. */
export function isCredentialPath(target: string): boolean {
  for (const entry of BASELINE_DENY_READ) {
    const expanded = expandTilde(entry)
    if (expanded.includes('*')) {
      if (globToRegExp(expanded).test(target)) return true
    } else if (target === expanded || target.startsWith(expanded + '/')) {
      return true
    }
  }
  return false
}

/**
 * Notification decision for a sandbox_violation event (Phase 2, item 5):
 * only credential-path READ denials are escalated to an in-app alert.
 * Writes/network violations, and reads of non-credential paths, are logged
 * to the observability panel only — see ObservabilityService.emitSandboxViolation.
 *
 * Exported as a pure function (rather than inlined in index.ts) so it is
 * directly unit-testable without needing a real mainWindow/Electron runtime
 * or a real OS-level violation — see the finding in SrtBackend.ts's header
 * comment about why the latter can't be relied on in an automated test.
 */
export function shouldAlertForViolation(violation: SandboxViolationTraceEvent): boolean {
  return violation.kind === 'read' && isCredentialPath(violation.target)
}
