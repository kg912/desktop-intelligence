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
    // process.env.DEV_MODE is not available at runtime in a packaged app
    // because cross-env only sets it during the build command invocation.
    define: {
      'process.env.DEV_MODE': JSON.stringify(process.env.DEV_MODE === 'true'),
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
