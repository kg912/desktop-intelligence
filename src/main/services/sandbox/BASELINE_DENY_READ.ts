// BASELINE_DENY_READ — spec section 07 verbatim, plus the app's own settings file.
//
// srt's read access is ALLOW-BY-DEFAULT.  Forgetting to maintain this list means
// every file on disk is readable, including ~/.ssh/id_rsa, browser cookie
// databases, and cloud credential files.
//
// The last entry is the app's own settings file, which holds OpenRouter/NVIDIA
// API keys on disk.  We resolve it from the SAME path SettingsStore uses —
// join(app.getPath('userData'), 'app-settings.json') — rather than hardcoding a
// guessed path, so it stays correct in both dev and production app names.

import { app } from 'electron'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Resolve the app's own settings file path.
 *
 * Matches SettingsStore.settingsPath() which is:
 *   join(app.getPath('userData'), 'app-settings.json')
 *
 * settingsPath() is not exported from SettingsStore, and we are scoped to
 * src/main/services/sandbox/ only, so we replicate the logic here.
 *
 * Falls back to a homedir-relative path in non-Electron environments (vitest)
 * — same try/catch pattern as ObservabilityService constructor.
 */
export function resolveSettingsFilePath(): string {
  try {
    return join(app.getPath('userData'), 'app-settings.json')
  } catch {
    return join(homedir(), 'Library/Application Support/Desktop Intelligence/app-settings.json')
  }
}

export const BASELINE_DENY_READ: string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.config/gcloud',
  '~/.docker/config.json',
  '~/.kube/config',
  '~/.netrc',
  '~/.npmrc',
  '~/.pypirc',
  '~/.gnupg',
  '~/Library/Keychains',
  '~/Library/Application Support/Google/Chrome/*/Cookies',
  '~/Library/Application Support/Google/Chrome/*/Login Data',
  '~/Library/Cookies',
  '~/.gitconfig',
  '~/.docker',
  resolveSettingsFilePath()
]
