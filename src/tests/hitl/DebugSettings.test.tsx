/** Settings → Debug: multi-agent runs sit above the session list; the session list pages 25 at a time. */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DebugSettings, SESSIONS_PAGE } from '../../renderer/src/components/settings/DebugSettings'
import { observabilityMock } from '../../renderer/src/mocks/observabilityDemo'

const sessions = Array.from({ length: 100 }, (_, i) => ({
  sessionId: `s${i}`, chatId: 'c', modelId: 'm', provider: 'openrouter',
  startedAt: new Date(2026, 0, 1, 0, i).toISOString(), hasImages: false, sizeBytes: 1024, filePath: `/x/s${i}.log`,
}))

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    ...observabilityMock,
    obsListSessions: async () => sessions,
    obsTotalSize: async () => 100 * 1024,
    obsListSandboxViolations: async () => [],
  }
})

describe('DebugSettings', () => {
  it('renders the multi-agent runs panel before the session list', async () => {
    render(<DebugSettings />)
    await screen.findAllByTestId('obs-session-row')
    const panel = screen.getByTestId('ma-runs')
    const logs = screen.getByText('Observability Logs')
    expect(panel.compareDocumentPosition(logs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('100 sessions render as 25 rows plus a Show more button; the header keeps the full count', async () => {
    render(<DebugSettings />)
    expect(await screen.findAllByTestId('obs-session-row')).toHaveLength(SESSIONS_PAGE)
    expect(screen.getByText('100 sessions · 100.0 KB')).toBeTruthy()
    fireEvent.click(screen.getByText(/Show more/))
    expect(screen.getAllByTestId('obs-session-row')).toHaveLength(2 * SESSIONS_PAGE)
  })
})
