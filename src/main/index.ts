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
import { DEFAULT_MODEL_ID } from '../shared/types'

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

  // Register all IPC handlers before loading content
  registerIpcHandlers(() => mainWindow?.webContents ?? null)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()

    // Start the daemon — pass DEFAULT_MODEL_ID so `lms load` is invoked on
    // startup if the model isn't already loaded in LM Studio.
    lmsDaemonManager.start(DEFAULT_MODEL_ID).catch((err) => {
      console.error('[App] LMSDaemon unhandled error:', err)
    })

    // HTTP polling starts regardless — works with or without lms CLI
    modelConnectionManager.start()
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
}

// ----------------------------------------------------------------
// App lifecycle
// ----------------------------------------------------------------
app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})
