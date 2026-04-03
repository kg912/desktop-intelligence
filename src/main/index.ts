// Restore the full login-shell $PATH so `lms` and other CLI tools are
// discoverable when the app is launched as a packaged .app bundle
// (packaged Electron apps do not inherit the user's shell environment).
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call
;(require('fix-path') as () => void)()

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { modelConnectionManager } from './managers/ModelConnectionManager'
import { lmsDaemonManager } from './managers/LMSDaemonManager'
import { pythonWorker } from './services/PythonWorkerService'

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
  pythonWorker.stop()

  // Kill child processes and stop LM Studio server
  await lmsDaemonManager.shutdown()
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
    width:            1280,
    height:           800,
    minWidth:         900,
    minHeight:        600,
    show:             false,
    titleBarStyle:    'hiddenInset',
    vibrancy:         'under-window',
    backgroundColor:  '#0f0f0f',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload:          join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      webSecurity:      true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Dev-mode debug build: open DevTools automatically
  if (process.env.DEV_MODE === 'true') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

// ----------------------------------------------------------------
// App lifecycle
// ----------------------------------------------------------------
app.whenReady().then(async () => {
  // IPC handlers are registered ONCE here, not inside createWindow.
  // On macOS, closing the window with ✕ keeps the app running; clicking the
  // Dock icon calls createWindow() again via 'activate'. Registering handlers
  // inside createWindow() would attempt to re-register the same ipcMain.handle
  // channels, which Electron rejects with "Attempted to register a second
  // handler" and crashes the main process.
  registerIpcHandlers(() => mainWindow?.webContents ?? null)

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
  lmsDaemonManager.start(savedSettings.modelId ?? undefined).catch((err) => {
    console.error('[App] LMSDaemon unhandled error:', err)
  })
  modelConnectionManager.start()

  // Pre-warm the persistent Python worker so the first chart renders fast.
  // Non-fatal: if python3 is missing, render() will fall back to one-shot spawn.
  pythonWorker.start().catch((err: Error) => {
    console.warn('[PythonWorker] Failed to start at launch:', err.message)
  })

  app.on('activate', () => {
    // On macOS: re-create the window when the Dock icon is clicked and no
    // windows are open. IPC handlers and background services are already live.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})
