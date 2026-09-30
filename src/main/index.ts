// Restore the full login-shell $PATH so `lms` and other CLI tools are
// discoverable when the app is launched as a packaged .app bundle
// (packaged Electron apps do not inherit the user's shell environment).
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call
; (require('fix-path') as () => void)()

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { registerRagSettingsHandlers } from './ipc/ragSettingsHandlers'
import { registerRagDiagnosticsHandlers } from './ipc/ragDiagnosticsHandlers'
import { modelConnectionManager, mtplxConnectionManager } from './managers/ModelConnectionManager'
import { lmsDaemonManager } from './managers/LMSDaemonManager'
import { mtplxDaemonManager } from './managers/MTPLXDaemonManager'
import { pythonWorker } from './services/PythonWorkerService'
import { mcpServerManager } from './services/McpServerManager'
import { DEFAULT_SIDECAR_PORT, multiAgentSidecar } from './services/MultiAgentSidecarManager'
import { observabilityService } from './services/ObservabilityService'
import { beginMultiAgentRun, getMultiAgentRun, saveMessage, saveMultiAgentTrace } from './services/DatabaseService'
import { MultiAgentRunCoordinator } from './services/MultiAgentRunCoordinator'
import { setMultiAgentCoordinator } from './services/multiAgentRuntime'
import { getOpenRouterCatalogue } from './services/OpenRouterCatalogue'
import { srtBackend } from './services/sandbox/sandboxServiceInstance'
import { shouldAlertForViolation } from './services/sandbox/isCredentialPath'
import { setSandboxStartupCheck } from './services/sandbox/sandboxStatus'
import { IPC_CHANNELS } from '../shared/types'
import type { McpServerRuntimeInfo, McpToolPermissionRequest, SandboxViolationTraceEvent } from '../shared/types'

// Baked in at build time by Rollup define — see electron.vite.config.ts + globals.d.ts.
// DO NOT use process.env.DEV_MODE — Rollup leaves process.env alone in Node.js code.
const DEV_MODE = __DEV_MODE__

if (DEV_MODE) {
  app.setName('[DEV] Desktop Intelligence')
  console.log('[App] DEV_MODE=true — DevTools will open automatically')
}

// ----------------------------------------------------------------
// Security: prevent renderer from loading arbitrary URLs
// ----------------------------------------------------------------
app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    const allowedOrigins = [
      'http://localhost:5173',
      'file://'
    ]
    if (!allowedOrigins.some((o) => url.startsWith(o))) {
      event.preventDefault()
    }
  })
})

// ----------------------------------------------------------------
// Zombie process cleanup — MUST be registered before createWindow
// so it fires even if the window never opens.
// ----------------------------------------------------------------
let isShuttingDown = false

async function gracefulShutdown(): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log('[App] Graceful shutdown initiated…')
  modelConnectionManager.stop()
  mtplxConnectionManager.stop()
  pythonWorker.stop()
  await multiAgentSidecar.stop()
  await mcpServerManager.stopAll()

  // Shut down the sandbox backend (resets SandboxManager).
  // Non-fatal: if it throws, we still proceed with the rest of shutdown.
  await srtBackend.shutdown().catch((err: Error) => {
    console.warn('[Sandbox] SrtBackend shutdown error:', err.message)
  })

  await lmsDaemonManager.shutdown()
  // Safe unconditionally: no-ops when start() was never called (mtplxBin stays
  // null) and when the MTPLX server was externally managed (spawnedByUs false).
  await mtplxDaemonManager.shutdown()
  console.log('[App] Shutdown complete.')
}

// before-quit fires when app.quit() is called (Cmd+Q, menu, etc.)
app.on('before-quit', (event) => {
  if (!isShuttingDown) {
    // Prevent the app from quitting instantly so we can async-cleanup
    event.preventDefault()
    gracefulShutdown().finally(() => app.exit(0))
  }
})

// window-all-closed fires when the last window closes (e.g. Cmd+W on non-macOS)
app.on('window-all-closed', () => {
  modelConnectionManager.stop()
  mtplxConnectionManager.stop()
  if (process.platform !== 'darwin') {
    gracefulShutdown().finally(() => app.quit())
  }
})

// ----------------------------------------------------------------
// Main Window
// ----------------------------------------------------------------
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f0f',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      webviewTag: true,
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    // Open DevTools after show() so the window + webContents are fully
    // initialised. 'undocked' docks to the bottom of the app window so
    // it's always visible — easier to spot than a detached floating window.
    if (DEV_MODE || is.dev) {
      mainWindow?.webContents.openDevTools({ mode: 'undocked' })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ----------------------------------------------------------------
// App lifecycle
// ----------------------------------------------------------------
app.whenReady().then(async () => {
  // Load React DevTools in DEV builds using electron-devtools-installer,
  // which downloads the correct extension version for this Electron/Chromium
  // build automatically — avoiding the version incompatibility that caused
  // the raw loadExtension approach to crash the extension renderer process.
  if (DEV_MODE) {
    try {
      const { default: installExtension, REACT_DEVELOPER_TOOLS } = await import('electron-devtools-installer')
      const name = await installExtension(REACT_DEVELOPER_TOOLS, {
        loadExtensionOptions: { allowFileAccess: true },
        forceDownload: false,
      })
      console.log(`[DevTools] Loaded: ${name}`)
    } catch (err) {
      console.warn('[DevTools] Failed to load React DevTools:', err)
    }
  }
  // IPC handlers are registered ONCE here, not inside createWindow.
  // On macOS, closing the window with ✕ keeps the app running; clicking the
  // Dock icon calls createWindow() again via 'activate'. Registering handlers
  // inside createWindow() would attempt to re-register the same ipcMain.handle
  // channels, which Electron rejects with "Attempted to register a second
  // handler" and crashes the main process.
  registerIpcHandlers(() => mainWindow?.webContents ?? null)
  registerRagSettingsHandlers()
  registerRagDiagnosticsHandlers()

  // ── Fullscreen state bridge ───────────────────────────────────
  // Renderer needs to know fullscreen state so TopBar can conditionally
  // add padding for the macOS traffic light buttons.
  const { ipcMain } = await import('electron')

  ipcMain.handle('window:isFullscreen', () => mainWindow?.isFullScreen() ?? false)

  // Forward enter/leave fullscreen events to the renderer
  app.on('browser-window-created', (_, win) => {
    win.on('enter-full-screen', () => {
      win.webContents.send('window:fullscreenChange', true)
    })
    win.on('leave-full-screen', () => {
      win.webContents.send('window:fullscreenChange', false)
    })
  })
  ipcMain.handle(IPC_CHANNELS.APP_RESTART, async () => {
    try {
      await lmsDaemonManager.shutdown()
    } catch { /* non-fatal */ }
    try {
      await mtplxDaemonManager.shutdown()
    } catch { /* non-fatal */ }
    app.relaunch()
    app.quit()
  })

  createWindow()

  // Start the daemon and connection polling once — they survive window
  // close/reopen cycles and do not need to be restarted per window.
  //
  // On first launch (no modelId saved), start the LM Studio server without
  // loading a model — the renderer will show FirstLaunchModal and call
  // APP_INITIALIZE once the user has chosen a model.
  // On subsequent launches, reload the saved model automatically.
  const { readSettings } = await import('./services/SettingsStore')
  const savedSettings = readSettings()

  const pythonResource = (file: string): string =>
    app.isPackaged ? join(process.resourcesPath, 'python', file) : join(app.getAppPath(), 'resources', 'python', file)
  multiAgentSidecar.configure({
    scriptPath: pythonResource('multi_agent_sidecar.py'),
    requirementsPath: pythonResource('requirements-multi-agent.txt'),
    workspaceDir: join(app.getPath('userData'), 'sandboxes', 'multi-agent-sidecar'),
    port: savedSettings.multiAgentSidecarPort ?? DEFAULT_SIDECAR_PORT,
    // Dev/test only (never in a packaged build): route the sidecar to a local OpenRouter fake.
    openRouterBaseUrl: app.isPackaged ? undefined : process.env.DI_OPENROUTER_BASE_URL,
  })
  multiAgentSidecar.on('status', (status) => console.log(`[Sidecar] status: ${status}`))
  setMultiAgentCoordinator(new MultiAgentRunCoordinator({
    sidecar: multiAgentSidecar,
    mcp: mcpServerManager,
    sendEvent: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.MULTI_AGENT_EVENT, event)
    },
    db: {
      begin: (chatId) => beginMultiAgentRun(chatId),
      saveTrace: (chatId, trace, status, steps) => saveMultiAgentTrace(chatId, trace, status, steps),
      saveAssistantMessage: (chatId, id, content) => saveMessage(chatId, id, 'assistant', content),
      getRun: (chatId) => getMultiAgentRun(chatId),
    },
    observe: (chatId, event) => observabilityService.emitMultiAgentEvent(chatId, event),
    settings: () => {
      const current = readSettings()
      return {
        backendProvider: current.backendProvider ?? 'lmstudio',
        openRouterApiKey: current.openrouterApiKey ?? '',
        openRouterModel: current.openrouterModel ?? '',
      }
    },
    catalogue: (apiKey) => getOpenRouterCatalogue(apiKey),
  }))

  const backendProvider = savedSettings.backendProvider ?? 'lmstudio'
  if (backendProvider === 'lmstudio') {
    lmsDaemonManager.start(savedSettings.modelId ?? undefined).catch((err: Error) => {
      console.error('[App] LMSDaemon unhandled error:', err)
    })
    modelConnectionManager.start()
  } else if (backendProvider === 'mtplx') {
    // MTPLX is local like LM Studio, but has its own daemon and its own poller.
    // No modelId is passed — MTPLX manages model selection in its own config.
    mtplxDaemonManager.start().catch((err: Error) => {
      console.error('[App] MTPLXDaemon unhandled error:', err)
    })
    mtplxConnectionManager.start()
  } else {
    // Cloud backend (NVIDIA, Ollama, OpenRouter) — skip all local daemon and
    // connection polling entirely. IPC handlers return a synthetic 'ready' state
    // so the UI shows immediately.
    console.log(`[App] Cloud backend active (${backendProvider}) — skipping local daemon and connection polling`)
  }

  // ── Sandbox dependency check ──────────────────────────────────────
  // Verifies that @anthropic-ai/sandbox-runtime can enforce sandboxing on
  // this platform, and — critically — runs BEFORE pythonWorker.start() /
  // mcpServerManager.startAll() so it actually gates the first sandboxed
  // spawn instead of racing it. srtBackend.initialize() is awaited here so
  // the lazy self-initialize guard inside SrtBackend.run()/spawnPersistent()
  // (`if (this.initialized) return`) is a no-op in the normal case.
  // Non-fatal for the app: if dependencies are missing, the result is
  // recorded for Settings (SANDBOX_GET_STATUS) and the backend is not
  // initialized. Sandboxed callers then fail closed on their own — the
  // Python worker cannot start and MCP stdio servers error — rather than
  // running unsandboxed; only an explicit per-server bypass runs unconfined.
  //
  // Dynamic import — @anthropic-ai/sandbox-runtime is ESM-only with no CJS
  // `exports` fallback; a static import here compiled to a top-level
  // require() in the CJS main-process bundle and crashed the packaged app
  // on launch (ERR_REQUIRE_ESM, found via a real .dmg run — see SrtBackend.ts's
  // header comment for the full writeup). This is already inside a try/catch,
  // so an import failure degrades the same way a dependency-check failure does.
  try {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
    if (SandboxManager.isSupportedPlatform()) {
      const depCheck = SandboxManager.checkDependencies()
      const errors = [...depCheck.errors]
      if (depCheck.errors.length > 0) {
        console.warn('[Sandbox] Dependency check errors:', depCheck.errors)
      }
      if (depCheck.warnings.length > 0) {
        console.warn('[Sandbox] Dependency check warnings:', depCheck.warnings)
      }
      if (depCheck.errors.length === 0) {
        // ── Sandbox violation observation (Phase 2) ──────────────────────
        // Every violation is logged to the observability panel (existing
        // main→standalone-JSONL pattern, see ObservabilityService). Only
        // credential-path READ denials additionally push an in-app alert —
        // same main→renderer push pattern already used for
        // MCP_SERVER_STATUS_CHANGED below.
        srtBackend.subscribeToViolations((violation: SandboxViolationTraceEvent) => {
          const attributed = mcpServerManager.attributeMultiAgentViolation(violation)
          observabilityService.emitSandboxViolation(attributed)
          if (shouldAlertForViolation(attributed) && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.SANDBOX_VIOLATION_ALERT, attributed)
          }
        })
        await srtBackend.initialize().catch((err: Error) => {
          console.warn('[Sandbox] SrtBackend initialize failed:', err.message)
          errors.push(`Sandbox backend failed to start: ${err.message}`)
        })
      } else {
        console.warn('[Sandbox] SrtBackend not initialized — dependency errors above')
      }
      setSandboxStartupCheck({
        supported: true,
        ready: errors.length === 0,
        errors,
        warnings: depCheck.warnings,
      })
    } else {
      console.warn('[Sandbox] Platform not supported by @anthropic-ai/sandbox-runtime')
      setSandboxStartupCheck({
        supported: false,
        ready: false,
        errors: ['This platform is not supported by @anthropic-ai/sandbox-runtime'],
        warnings: [],
      })
    }
  } catch (err) {
    console.warn('[Sandbox] Dependency check failed:', err)
    setSandboxStartupCheck({
      supported: false,
      ready: false,
      errors: [`Sandbox dependency check failed: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
    })
  }

  // Pre-warm the persistent Python worker so the first chart renders fast.
  // Non-fatal: if python3 is missing, render() will fall back to one-shot spawn.
  pythonWorker.start().catch((err: Error) => {
    console.warn('[PythonWorker] Failed to start at launch:', err.message)
  })

  // Start MCP servers and wire status/permission events to renderer.
  mcpServerManager.startAll().catch((err: Error) => {
    console.warn('[McpServerManager] startAll error:', err.message)
  })
  mcpServerManager.on('statusChanged', (info: McpServerRuntimeInfo) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, info)
    }
  })
  mcpServerManager.on('permissionRequest', (req: McpToolPermissionRequest) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.MCP_TOOL_PERMISSION_REQUEST, req)
    }
  })
  mcpServerManager.on('permissionExpired', (requestId: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.MCP_TOOL_PERMISSION_EXPIRED, requestId)
    }
  })

  app.on('activate', () => {
    // On macOS: re-create the window when the Dock icon is clicked and no
    // windows are open. IPC handlers and background services are already live.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })

  // TEMPORARY — Phase 0 spike, removed in RAG v2 Phase 5.
  // Launch with DI_SPIKE_SQLITE_VEC=1 to run the sqlite-vec probe in the packaged
  // Electron process and then quit. This validates the extension loads correctly
  // with the ASAR-unpacked dylib and Electron's Node.js ABI before the full rebuild.
  if (process.env['DI_SPIKE_SQLITE_VEC'] === '1') {
    const { runSqliteVecSpike } = await import('../../scripts/spike-sqlite-vec')
    const spikeLog = (msg: string): void => {
      console.log(msg)
    }
    const ok = await runSqliteVecSpike(spikeLog)
    console.log(`[Spike][sqlite-vec] Packaged-build probe: ${ok ? 'PASS' : 'FAIL'}`)
    app.quit()
  }
})
