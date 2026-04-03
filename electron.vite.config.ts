import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    },
    // Bake DEV_MODE into the main-process bundle at build time.
    // We use __DEV_MODE__ (not process.env.DEV_MODE) because Rollup treats
    // process.env as a real Node.js runtime object in the main process and
    // will NOT replace individual property accesses on it. The double-underscore
    // naming convention is the standard signal to Rollup that this is a
    // compile-time constant, not a runtime variable.
    define: {
      __DEV_MODE__: JSON.stringify(process.env.DEV_MODE === 'true'),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    // Bake DEV_MODE into the renderer bundle at build time.
    // import.meta.env.DEV_MODE is true in `npm run package:dev`, false otherwise.
    define: {
      'import.meta.env.DEV_MODE': JSON.stringify(process.env.DEV_MODE === 'true'),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
