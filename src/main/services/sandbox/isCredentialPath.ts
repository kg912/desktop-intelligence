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
import { BASELINE_DENY_READ } from './BASELINE_DENY_READ'
import { matchCredentialPath } from '../../../shared/credentialPathMatch'
import type { SandboxViolationTraceEvent } from '../../../shared/types'

/** True when `target` (an absolute path) matches a BASELINE_DENY_READ entry. */
export function isCredentialPath(target: string): boolean {
  return matchCredentialPath(target, BASELINE_DENY_READ, homedir()) !== null
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
