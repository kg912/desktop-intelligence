/**
 * Augments the global Window interface so TypeScript knows about
 * the contextBridge-exposed API without importing from the preload.
 */
import type { ElectronAPI } from '../../preload/index'

declare global {
  interface Window {
    api: ElectronAPI
  }
}
