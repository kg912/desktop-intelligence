/**
 * Standalone Vite config for browser preview / demo mode.
 * Runs the renderer without Electron so the mock API kicks in.
 */
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared':   resolve(__dirname, 'src/shared'),
      '@':         resolve(__dirname, 'src/renderer/src'),
    }
  },
  server: {
    port: 5174,
    strictPort: true,
  }
})
