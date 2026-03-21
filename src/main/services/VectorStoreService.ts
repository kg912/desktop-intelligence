/**
 * VectorStoreService — Main process
 *
 * Thin wrapper around hnswlib-node.
 * Persists the index to disk after every mutation.
 *
 * Space: cosine (normalised L2 ≡ cosine similarity for normalised vectors)
 * Dim:   384   (all-MiniLM-L6-v2 output size)
 */

import { app } from 'electron'
import path    from 'path'
import fs      from 'fs'

const SPACE        = 'cosine' as const
const DIM          = 384
const MAX_ELEMENTS = 10_000

// Minimal interface so we don't import the type at the top level
interface HNSWIndex {
  initIndex(maxElements: number): void
  addPoint(vector: number[], id: number): void
  searchKnn(
    vector: number[],
    k:      number
  ): { neighbors: number[]; distances: number[] }
  // Sync variants required — async versions do not reliably persist state (hnswlib-node v3)
  readIndexSync(path: string): void
  writeIndexSync(path: string): void
  getCurrentCount(): number
}

let _index: HNSWIndex | null = null

function indexPath(): string {
  return path.join(app.getPath('userData'), 'vectors.hnsw')
}

async function getIndex(): Promise<HNSWIndex> {
  if (_index) return _index

  // Dynamic import — keeps hnswlib-node out of the startup require chain
  const { HierarchicalNSW } = await import('hnswlib-node')
  const inst = new HierarchicalNSW(SPACE, DIM) as HNSWIndex
  const p    = indexPath()

  // initIndex must be called before readIndexSync
  inst.initIndex(MAX_ELEMENTS)
  if (fs.existsSync(p)) {
    // Sync variants are required — the async writeIndex/readIndex
    // methods do not properly persist/restore state in hnswlib-node v3.
    inst.readIndexSync(p)
  }

  _index = inst
  return _index
}

/** Add multiple vectors at once, then flush to disk. */
export async function addVectors(
  ids:     number[],
  vectors: number[][]
): Promise<void> {
  const index = await getIndex()
  for (let i = 0; i < ids.length; i++) {
    index.addPoint(vectors[i], ids[i])
  }
  index.writeIndexSync(indexPath())
}

/**
 * Return the k nearest neighbours by cosine similarity.
 * Returns [] if the index is empty.
 */
export async function searchNN(
  vector: number[],
  k:      number
): Promise<{ id: number; distance: number }[]> {
  const index = await getIndex()
  const n     = index.getCurrentCount()
  if (n === 0) return []

  const result = index.searchKnn(vector, Math.min(k, n))
  return result.neighbors.map((id, i) => ({
    id,
    distance: result.distances[i],
  }))
}
