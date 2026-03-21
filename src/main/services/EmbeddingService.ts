/**
 * EmbeddingService — Main process
 *
 * Lazy-initialised Xenova/all-MiniLM-L6-v2 pipeline.
 * First call triggers model download (~23 MB) to app userData.
 * Subsequent calls reuse the cached pipeline instance.
 *
 * Output: 384-dimensional normalised float vectors.
 */

import { app } from 'electron'
import path    from 'path'

// Type stub — real type comes from @xenova/transformers at runtime
type PipelineFn = (text: string, opts: {
  pooling:   string
  normalize: boolean
}) => Promise<{ data: Float32Array }>

let _pipeline:    PipelineFn | null   = null
let _initPromise: Promise<void> | null = null

async function ensureReady(): Promise<void> {
  if (_pipeline) return
  if (!_initPromise) {
    _initPromise = (async () => {
      const t0 = Date.now()
      console.log('[Embedding] 🔄 Loading all-MiniLM-L6-v2 via @xenova/transformers …')

      // Dynamic import keeps the heavy ONNX runtime out of the startup path
      const { pipeline, env } = await import('@xenova/transformers')

      // Cache models in app userData so they survive updates and asar re-packs
      const cacheDir = path.join(app.getPath('userData'), 'models')
      env.cacheDir   = cacheDir
      console.log(`[Embedding] 📂 Model cache dir: ${cacheDir}`)

      try {
        _pipeline = await pipeline(
          'feature-extraction',
          'Xenova/all-MiniLM-L6-v2'
        ) as PipelineFn
        console.log(`[Embedding] ✅ Pipeline ready in ${Date.now() - t0} ms`)
      } catch (err) {
        // Reset so the next call retries
        _initPromise = null
        console.error(`[Embedding] ❌ pipeline() FAILED after ${Date.now() - t0} ms:`, err)
        throw err
      }
    })()
  }
  await _initPromise
}

/** Returns a 384-dim normalised embedding for `text`. */
export async function embed(text: string): Promise<number[]> {
  await ensureReady()
  const out = await _pipeline!(text, { pooling: 'mean', normalize: true })
  return Array.from(out.data)
}

/** True once the pipeline has been initialised (model downloaded). */
export function isEmbedderReady(): boolean {
  return _pipeline !== null
}
