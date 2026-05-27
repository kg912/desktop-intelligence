import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──
export const mockReadSettings = vi.fn().mockReturnValue({
  observabilityEnabled: true,
  includeImages: true,
})
export const mockWriteSettings = vi.fn()

vi.mock('../SettingsStore', () => ({
  readSettings: () => mockReadSettings(),
  writeSettings: (...args: any[]) => mockWriteSettings(...args),
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/mock/userData/${name}`,
  },
}))

export const mockWriteFile = vi.fn().mockResolvedValue(undefined)
export const mockMkdir = vi.fn().mockResolvedValue(undefined)
export const mockReaddir = vi.fn().mockResolvedValue([])
export const mockReadFile = vi.fn().mockResolvedValue('{}')
export const mockUnlink = vi.fn().mockResolvedValue(undefined)
export const mockRm = vi.fn().mockResolvedValue(undefined)
export const mockStat = vi.fn().mockResolvedValue({ size: 100 })

vi.mock('fs/promises', () => ({
  default: {
    writeFile: (...args: any[]) => mockWriteFile(...args),
    mkdir: (...args: any[]) => mockMkdir(...args),
    readdir: (...args: any[]) => mockReaddir(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    unlink: (...args: any[]) => mockUnlink(...args),
    rm: (...args: any[]) => mockRm(...args),
    stat: (...args: any[]) => mockStat(...args),
  },
}))

// Import the service
import { ObservabilityService } from '../ObservabilityService'

describe('ObservabilityService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadSettings.mockReturnValue({
      observabilityEnabled: true,
      includeImages: true,
    })
  })

  describe('Constructor & Preferences', () => {
    it('initializes and reads settings correctly', () => {
      const obs = new ObservabilityService()
      expect(obs.isEnabled()).toBe(true)
      expect(obs.includeImages()).toBe(true)
      expect(obs.getLogsDir()).toContain('observability-logs')
    })

    it('sets prefs and keeps in-memory state in sync', () => {
      const obs = new ObservabilityService()
      obs.setPrefs({ observabilityEnabled: false, includeImages: false })
      expect(obs.isEnabled()).toBe(false)
      expect(obs.includeImages()).toBe(false)
      expect(mockWriteSettings).toHaveBeenCalledWith({
        observabilityEnabled: false,
        includeImages: false,
      })
    })

    it('getPrefs returns current settings from store', () => {
      const obs = new ObservabilityService()
      const prefs = obs.getPrefs()
      expect(prefs).toEqual({
        observabilityEnabled: true,
        includeImages: true,
      })
    })
  })

  describe('Session Lifecycle & Event Capture', () => {
    it('does not start session or capture if disabled', () => {
      mockReadSettings.mockReturnValue({ observabilityEnabled: false })
      const obs = new ObservabilityService()
      
      const sId = obs.startSession('chat-123', 'qwen-model', 'lm-studio')
      expect(sId).toBe('')

      obs.capture('some-id', {
        type: 'system_prompt',
        payload: { text: 'prompt' },
        ts: Date.now()
      })
      expect(obs._getBuffer('some-id')).toBeUndefined()
    })

    it('creates active session buffer on startSession and updates on capture', () => {
      const obs = new ObservabilityService()
      const sId = obs.startSession('chat-123', 'qwen-model', 'lm-studio')
      expect(sId).toBeTruthy()

      const buf = obs._getBuffer(sId)
      expect(buf).toBeDefined()
      expect(buf!.chatId).toBe('chat-123')
      expect(buf!.modelId).toBe('qwen-model')

      // Capture system prompt
      obs.capture(sId, {
        type: 'system_prompt',
        payload: { text: 'You are helpful.' },
        ts: Date.now(),
      })
      expect(buf!.systemPrompt).toBe('You are helpful.')

      // Capture RAG Chunks
      obs.capture(sId, {
        type: 'rag_chunks',
        payload: { chunks: [{ source: 'doc.pdf', content: 'hello doc' }] },
        ts: Date.now(),
      })
      expect(buf!.ragChunks).toHaveLength(1)
      expect(buf!.ragChunks[0].source).toBe('doc.pdf')

      // Capture messages sent
      obs.capture(sId, {
        type: 'messages_sent',
        payload: { messages: [{ role: 'user', content: 'hi' }] },
        ts: Date.now(),
      })
      expect(buf!.messagesSent).toHaveLength(1)

      // Capture thinking deltas (should accumulate)
      obs.capture(sId, { type: 'thinking_delta', payload: { text: 'Th' }, ts: Date.now() })
      obs.capture(sId, { type: 'thinking_delta', payload: { text: 'ink' }, ts: Date.now() })
      expect(buf!.trace).toHaveLength(1)
      expect(buf!.trace[0]).toEqual({ kind: 'thinking', text: 'Think' })

      // Capture answer deltas (should accumulate)
      obs.capture(sId, { type: 'answer_delta', payload: { text: 'An' }, ts: Date.now() })
      obs.capture(sId, { type: 'answer_delta', payload: { text: 'swer' }, ts: Date.now() })
      expect(buf!.trace).toHaveLength(2)
      expect(buf!.trace[1]).toEqual({ kind: 'text', text: 'Answer' })

      // Capture tool calls and tool results
      obs.capture(sId, {
        type: 'tool_call',
        payload: { toolName: 'brave_search', args: { query: 'cats' } },
        ts: Date.now(),
      })
      expect(buf!.trace).toHaveLength(3)

      obs.capture(sId, {
        type: 'tool_result',
        payload: { toolName: 'brave_search', result: 'cats are cool' },
        ts: Date.now(),
      })
      expect(buf!.trace).toHaveLength(3)
      expect((buf!.trace[2] as any).result).toBe('cats are cool')

      // Capture session end
      obs.capture(sId, {
        type: 'session_end',
        payload: { finishReason: 'stop', durationMs: 1500, promptTokens: 10, outputTokens: 20 },
        ts: Date.now(),
      })
      expect(buf!.finishReason).toBe('stop')
      expect(buf!.durationMs).toBe(1500)
    })

    it('captureArtifact adds image/chart trace items', () => {
      const obs = new ObservabilityService()
      const sId = obs.startSession('chat-123', 'qwen-model', 'lm-studio')

      obs.captureArtifact({
        type: 'chart_image',
        payload: { label: 'my-chart', base64: 'abc', pySource: 'plt.plot()' },
        ts: Date.now()
      })

      obs.captureArtifact({
        type: 'image_artifact',
        payload: { label: 'my-img', ext: 'png', base64: 'xyz' },
        ts: Date.now()
      })

      const buf = obs._getBuffer(sId)
      expect(buf!.trace).toContainEqual({
        kind: 'chart_image',
        label: 'my-chart',
        base64: 'abc',
        pySource: 'plt.plot()',
      })
      expect(buf!.trace).toContainEqual({
        kind: 'image_artifact',
        label: 'my-img',
        ext: 'png',
        base64: 'xyz',
      })
    })
  })

  describe('File Writer & End Session', () => {
    it('endSession schedules sequential trace save to files (plain log)', async () => {
      // images disabled
      mockReadSettings.mockReturnValue({
        observabilityEnabled: true,
        includeImages: false,
      })

      const obs = new ObservabilityService()
      const sId = obs.startSession('chat-123', 'qwen-model', 'lm-studio')

      obs.capture(sId, { type: 'system_prompt', payload: { text: 'sys' }, ts: Date.now() })
      obs.capture(sId, { type: 'thinking_delta', payload: { text: 'thinking' }, ts: Date.now() })
      obs.capture(sId, { type: 'answer_delta', payload: { text: 'answer' }, ts: Date.now() })

      // Stub setImmediate
      const setImmediateSpy = vi.spyOn(global, 'setImmediate')

      await obs.endSession(sId)

      expect(setImmediateSpy).toHaveBeenCalled()
      setImmediateSpy.mockRestore()
    })

    it('endSession schedules sequential trace save to files (with images)', async () => {
      // images enabled
      mockReadSettings.mockReturnValue({
        observabilityEnabled: true,
        includeImages: true,
      })

      const obs = new ObservabilityService()
      const sId = obs.startSession('chat-123', 'qwen-model', 'lm-studio')

      obs.capture(sId, { type: 'system_prompt', payload: { text: 'sys' }, ts: Date.now() })
      obs.capture(sId, { type: 'thinking_delta', payload: { text: 'thinking' }, ts: Date.now() })
      obs.capture(sId, { type: 'answer_delta', payload: { text: 'answer' }, ts: Date.now() })
      obs.capture(sId, {
        type: 'tool_call',
        payload: { toolName: 'brave_search', args: { query: 'cats' } },
        ts: Date.now(),
      })
      obs.capture(sId, {
        type: 'tool_result',
        payload: { toolName: 'brave_search', result: 'cats are cool' },
        ts: Date.now(),
      })
      obs.captureArtifact({
        type: 'chart_image',
        payload: { label: 'my-chart', base64: 'abc', pySource: 'plt.plot()' },
        ts: Date.now()
      })
      obs.captureArtifact({
        type: 'image_artifact',
        payload: { label: 'my-img', ext: 'png', base64: 'xyz' },
        ts: Date.now()
      })

      // Stub setImmediate
      let callbackRun: () => void = () => {}
      const setImmediateMock = vi.spyOn(global, 'setImmediate').mockImplementation((cb: any) => {
        callbackRun = cb
        return {} as any
      })

      // Spy on private _writeSession to capture the async promise
      const originalWriteSession = (obs as any)._writeSession.bind(obs)
      let writeSessionPromise: Promise<void> | null = null
      const writeSpy = vi.spyOn(obs as any, '_writeSession').mockImplementation((...args: any[]) => {
        writeSessionPromise = originalWriteSession(...args)
        return writeSessionPromise
      })

      try {
        await obs.endSession(sId)
        expect(setImmediateMock).toHaveBeenCalled()
        
        // Trigger the write operation
        callbackRun()
        
        // Await the actual asynchronous file writes
        await writeSessionPromise
        
        expect(mockWriteFile).toHaveBeenCalled()
        expect(mockMkdir).toHaveBeenCalled()
      } finally {
        setImmediateMock.mockRestore()
        writeSpy.mockRestore()
      }
    })
  })

  describe('Session List, Delete & Clean APIs', () => {
    it('listSessions parses directory meta json metadata', async () => {
      const obs = new ObservabilityService()
      mockReaddir.mockResolvedValue([
        { isFile: () => true, isDirectory: () => false, name: 'sessionA.meta.json' } as any,
        { isFile: () => false, isDirectory: () => true, name: 'sessionB' } as any,
      ])

      mockReadFile.mockResolvedValue(JSON.stringify({
        sessionId: 'sessionA',
        chatId: 'chatA',
        modelId: 'qwen',
        provider: 'lms',
        startedAt: '2026-05-27T10:00:00Z',
        hasImages: false,
        sizeBytes: 100,
        filePath: 'sessionA.log'
      }))

      const list = await obs.listSessions()
      expect(list).toHaveLength(2)
      expect(list[0].sessionId).toBe('sessionA')
    })

    it('deleteSession unlinks logs and directories', async () => {
      const obs = new ObservabilityService()
      await obs.deleteSession('sess-123')
      expect(mockUnlink).toHaveBeenCalledTimes(2)
      expect(mockRm).toHaveBeenCalledOnce()
    })

    it('clearAllSessions unlinks the entire logs directory and remakes it', async () => {
      const obs = new ObservabilityService()
      await obs.clearAllSessions()
      expect(mockRm).toHaveBeenCalledOnce()
      expect(mockMkdir).toHaveBeenCalledOnce()
    })

    it('getTotalSizeBytes returns sum of file weights recursively', async () => {
      const obs = new ObservabilityService()
      mockReaddir.mockResolvedValueOnce([
        { isFile: () => true, isDirectory: () => false, name: 'a.log' } as any,
        { isFile: () => false, isDirectory: () => true, name: 'sub' } as any,
      ])
      mockReaddir.mockResolvedValueOnce([
        { isFile: () => true, isDirectory: () => false, name: 'b.png' } as any,
      ])

      const total = await obs.getTotalSizeBytes()
      expect(total).toBe(200) // 100 for a.log, 100 for b.png
    })

    it('listSessions handles directory read errors gracefully and returns empty array', async () => {
      const obs = new ObservabilityService()
      mockReaddir.mockRejectedValueOnce(new Error('Simulated readdir error'))
      const list = await obs.listSessions()
      expect(list).toEqual([])
    })

    it('getTotalSizeBytes handles directory read errors gracefully and returns 0', async () => {
      const obs = new ObservabilityService()
      mockReaddir.mockRejectedValueOnce(new Error('Simulated readdir error'))
      const total = await obs.getTotalSizeBytes()
      expect(total).toBe(0)
    })
  })
})
