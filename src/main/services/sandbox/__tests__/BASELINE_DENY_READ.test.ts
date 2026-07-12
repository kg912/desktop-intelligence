import { describe, it, expect, vi } from 'vitest'

// ── Mock electron so BASELINE_DENY_READ can call app.getPath('userData') ──
// vi.hoisted ensures the mock fn exists before vi.mock's factory runs,
// which is critical because BASELINE_DENY_READ resolves the settings path
// at module-load time (inside the export const evaluation).
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => '/mock/sandbox-userdata'),
}))

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
  },
}))

// Import AFTER mocks are in place
import { BASELINE_DENY_READ, resolveSettingsFilePath } from '../BASELINE_DENY_READ'

describe('BASELINE_DENY_READ', () => {
  describe('resolveSettingsFilePath', () => {
    it('returns a path ending with app-settings.json', () => {
      const p = resolveSettingsFilePath()
      expect(p.endsWith('app-settings.json')).toBe(true)
    })

    it('uses app.getPath("userData") as the directory', () => {
      const p = resolveSettingsFilePath()
      expect(p.startsWith('/mock/sandbox-userdata')).toBe(true)
    })
  })

  describe('the constant array', () => {
    it('is non-empty', () => {
      expect(BASELINE_DENY_READ.length).toBeGreaterThan(0)
    })

    it('contains ~/.ssh', () => {
      expect(BASELINE_DENY_READ).toContain('~/.ssh')
    })

    it('contains ~/.aws', () => {
      expect(BASELINE_DENY_READ).toContain('~/.aws')
    })

    it('contains ~/.config/gcloud', () => {
      expect(BASELINE_DENY_READ).toContain('~/.config/gcloud')
    })

    it('contains ~/.docker/config.json', () => {
      expect(BASELINE_DENY_READ).toContain('~/.docker/config.json')
    })

    it('contains ~/.kube/config', () => {
      expect(BASELINE_DENY_READ).toContain('~/.kube/config')
    })

    it('contains ~/.netrc', () => {
      expect(BASELINE_DENY_READ).toContain('~/.netrc')
    })

    it('contains ~/.npmrc', () => {
      expect(BASELINE_DENY_READ).toContain('~/.npmrc')
    })

    it('contains ~/.pypirc', () => {
      expect(BASELINE_DENY_READ).toContain('~/.pypirc')
    })

    it('contains ~/.gnupg', () => {
      expect(BASELINE_DENY_READ).toContain('~/.gnupg')
    })

    it('contains ~/Library/Keychains', () => {
      expect(BASELINE_DENY_READ).toContain('~/Library/Keychains')
    })

    it('contains Chrome Cookies glob', () => {
      expect(BASELINE_DENY_READ).toContain(
        '~/Library/Application Support/Google/Chrome/*/Cookies'
      )
    })

    it('contains Chrome Login Data glob', () => {
      expect(BASELINE_DENY_READ).toContain(
        '~/Library/Application Support/Google/Chrome/*/Login Data'
      )
    })

    it('contains ~/Library/Cookies', () => {
      expect(BASELINE_DENY_READ).toContain('~/Library/Cookies')
    })

    it('contains ~/.gitconfig', () => {
      expect(BASELINE_DENY_READ).toContain('~/.gitconfig')
    })

    it('contains ~/.docker', () => {
      expect(BASELINE_DENY_READ).toContain('~/.docker')
    })

    it('includes the app own settings file path as the last entry', () => {
      const last = BASELINE_DENY_READ[BASELINE_DENY_READ.length - 1]
      expect(last).toBe(resolveSettingsFilePath())
    })

    it('settings path ends with app-settings.json (not settings.json)', () => {
      const last = BASELINE_DENY_READ[BASELINE_DENY_READ.length - 1]
      expect(last.endsWith('app-settings.json')).toBe(true)
    })
  })
})
