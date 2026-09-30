// Startup sandbox health, recorded by index.ts's dependency check and read by
// the SANDBOX_GET_STATUS IPC handler so Settings can surface it (spec section
// 16: "Dependency check on startup, surfaced in Settings if missing").

import type { SandboxStatusInfo } from '../../../shared/types'
import { BASELINE_DENY_READ } from './BASELINE_DENY_READ'
import { srtBackend } from './sandboxServiceInstance'

type StartupCheck = Pick<SandboxStatusInfo, 'supported' | 'ready' | 'errors' | 'warnings'>

let startupCheck: StartupCheck = {
  supported: false,
  ready: false,
  errors: ['Sandbox dependency check has not run yet'],
  warnings: [],
}

export function setSandboxStartupCheck(check: StartupCheck): void {
  startupCheck = check
}

export function getSandboxStatus(): SandboxStatusInfo {
  return {
    ...startupCheck,
    baselineDenyRead: [...BASELINE_DENY_READ],
    activePolicies: srtBackend.getActivePolicies(),
  }
}
