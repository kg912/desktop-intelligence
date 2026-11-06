/**
 * Exa spec 8a item 4: the Exa key (settings and EXA_API_KEY) is scrubbed from multi-agent run logs,
 * and SettingsStore no longer prints API keys on save. Real SettingsStore and ObservabilityService
 * on a temp userData folder; the whole log tree is grepped for the test keys.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, afterAll } from 'vitest'

const USER_DATA = mkdtempSync(join(tmpdir(), 'di-exa-secrets-'))
vi.mock('electron', () => ({ app: { getPath: () => USER_DATA }, shell: {} }))
afterAll(() => rmSync(USER_DATA, { recursive: true, force: true }))

const SETTINGS_KEY = 'exa-settings-key-SECRET-1234'
const ENV_KEY = 'exa-env-key-SECRET-5678'
writeFileSync(join(USER_DATA, 'app-settings.json'), JSON.stringify({ exaApiKey: SETTINGS_KEY, observabilityEnabled: true }))

import { writeSettings, readSettings, redactSettings } from '../SettingsStore'
import { ObservabilityService } from '../ObservabilityService'
import type { CallRecord } from '../MultiAgentRunLogger'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? allFiles(join(dir, n)) : [join(dir, n)]))
}

describe('Exa key never reaches a log', () => {
  it('multi-agent run logs scrub the saved Exa key and EXA_API_KEY', async () => {
    process.env.EXA_API_KEY = ENV_KEY
    try {
      const obs = new ObservabilityService()
      obs.multiAgentRuns.begin({ runId: 'run-s', chatId: 'chat-s', chatTitle: 't', task: `task ${SETTINGS_KEY}`, config: DEFAULT_MULTI_AGENT_CONFIG })
      obs.multiAgentRuns.record('run-s', {
        schema: 1, runId: 'run-s', chatId: 'chat-s', seq: 0, kind: 'search_call', role: 'worker', agentId: '1.1', attempt: 0, toolRound: 0, callId: 'c',
        name: 'builtin__web_search', timing: { startedAt: 1, endedAt: 2, ms: 1 },
        search: { rawResponse: { leaked: SETTINGS_KEY, env: ENV_KEY } },
      } as unknown as CallRecord)
      obs.multiAgentRuns.event({ runId: 'run-s', seq: 1, ts: 3, type: 'task_complete', finalOutput: ENV_KEY, totalCostUsd: 0, totalTokens: 0 } as never)
      await obs.multiAgentRuns.flush()
      const files = allFiles(join(USER_DATA, 'observability-logs'))
      expect(files.some((f) => f.endsWith('agent-1.1.jsonl'))).toBe(true)
      for (const f of files) {
        const text = readFileSync(f, 'utf8')
        expect(text).not.toContain(SETTINGS_KEY)
        expect(text).not.toContain(ENV_KEY)
      }
      expect(readFileSync(files.find((f) => f.endsWith('agent-1.1.jsonl'))!, 'utf8')).toContain('"leaked":"[redacted]"')
    } finally {
      delete process.env.EXA_API_KEY
    }
  })

  it('writeSettings logs the merged settings with every key redacted (and still saves them)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      writeSettings({ braveSearchApiKey: 'BSA-secret', openrouterApiKey: 'sk-or-secret', nvidiaApiKey: 'nvapi-secret', ollamaApiKey: 'oll-secret', temperature: 0.5 })
      const printed = JSON.stringify(log.mock.calls)
      for (const k of [SETTINGS_KEY, 'BSA-secret', 'sk-or-secret', 'nvapi-secret', 'oll-secret']) expect(printed).not.toContain(k)
      expect(log).toHaveBeenCalledWith('[SettingsStore] Saved:', expect.objectContaining({ exaApiKey: '[redacted]', braveSearchApiKey: '[redacted]', temperature: 0.5 }))
      expect(readSettings()).toMatchObject({ exaApiKey: SETTINGS_KEY, braveSearchApiKey: 'BSA-secret', temperature: 0.5 })
    } finally {
      log.mockRestore()
    }
  })

  it('redactSettings leaves empty keys and other fields alone', () => {
    expect(redactSettings({ exaApiKey: '', braveSearchApiKey: 'x', maxSearchLoops: 4 })).toEqual({ exaApiKey: '', braveSearchApiKey: '[redacted]', maxSearchLoops: 4 })
  })
})
