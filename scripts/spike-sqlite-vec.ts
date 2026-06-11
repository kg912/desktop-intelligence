/**
 * Phase 0 spike: sqlite-vec validation
 *
 * Proves that the sqlite-vec native extension loads correctly with better-sqlite3
 * in dev, inside the Vitest harness, and inside a packaged arm64 Electron build.
 *
 * Run:   npm run spike:vec
 *
 * TEMPORARY — Phase 0 spike, removed in RAG v2 Phase 5.
 */

import path from 'path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

// ── Exported canonical loader (becomes DatabaseService.loadSqliteVec in Phase 1) ──

/**
 * Load the sqlite-vec extension into a better-sqlite3 Database instance.
 *
 * Primary path: delegates to sqlite-vec's own load() helper.
 * Fallback path: resolves the dylib manually, rewrites app.asar → app.asar.unpacked,
 * and strips the .dylib suffix before calling loadExtension().
 * This fixes electron-builder issue #8824 where better-sqlite3/SQLite appends the
 * platform suffix, producing vec0.dylib.dylib inside the ASAR virtual filesystem.
 *
 * Returns true if the extension loaded successfully, false otherwise.
 */
export function loadSqliteVec(db: Database.Database): boolean {
  // Primary: use the sqlite-vec package's own load helper
  try {
    sqliteVec.load(db)
    return true
  } catch {
    // fall through to manual fallback
  }

  // Fallback: manual path resolution with ASAR rewrite + extension strip
  try {
    let extPath = sqliteVec.getLoadablePath()

    // Rewrite app.asar → app.asar.unpacked so dlopen sees a real on-disk path.
    // Electron patches require() to redirect ASAR paths but sqlite3_load_extension
    // calls dlopen() directly, which has no knowledge of ASAR.
    if (extPath.includes('app.asar' + path.sep)) {
      extPath = extPath.split('app.asar' + path.sep).join('app.asar.unpacked' + path.sep)
    }

    // Strip .dylib: better-sqlite3 passes the path to sqlite3_load_extension which
    // appends the platform suffix on macOS when the path does not already have it.
    // When the resolved path already ends in .dylib and the suffix is added again,
    // the resulting vec0.dylib.dylib does not exist → ENOENT.
    if (extPath.endsWith('.dylib')) {
      extPath = extPath.slice(0, -'.dylib'.length)
    }

    db.loadExtension(extPath)
    return true
  } catch (fallbackErr) {
    console.error('[loadSqliteVec] Fallback loader failed:', fallbackErr)
    return false
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomFloat32Array(dim: number): Float32Array {
  const arr = new Float32Array(dim)
  for (let i = 0; i < dim; i++) arr[i] = Math.random() * 2 - 1
  return arr
}

function vecBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

// ── Main probe (re-exported so index.ts can call it) ─────────────────────────

export async function runSqliteVecSpike(
  log: (msg: string) => void = console.log
): Promise<boolean> {
  const db = new Database(':memory:')

  // Step a: load extension
  const loaded = loadSqliteVec(db)
  if (!loaded) {
    log('[Spike][sqlite-vec] FATAL: extension failed to load — aborting spike')
    db.close()
    return false
  }

  // Step b: vec_version()
  const versionRow = db.prepare('SELECT vec_version() AS v').get() as { v: string }
  const version = versionRow.v
  log(`[Spike][sqlite-vec] vec_version() = ${version}`)

  // Step c: create vec0 table
  db.exec('CREATE VIRTUAL TABLE spike_vec USING vec0(embedding float[384])')
  log('[Spike][sqlite-vec] Created spike_vec USING vec0(embedding float[384])')

  // Step d: insert 1 000 random 384-dim vectors.
  // NOTE: vec0 requires either auto-assigned rowid (omit from INSERT) or an explicit
  // BigInt rowid — passing a JS Number for the rowid raises "Only integers are allowed
  // for primary key values" in v0.1.9.
  const insertStmt = db.prepare('INSERT INTO spike_vec(embedding) VALUES (?)')
  const insertAll = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) {
      insertStmt.run(vecBuffer(randomFloat32Array(384)))
    }
  })
  const t0 = performance.now()
  insertAll(1000)
  log(`[Spike][sqlite-vec] Inserted 1 000 vectors in ${(performance.now() - t0).toFixed(1)} ms`)

  // Step e: KNN timings (10 rounds, k=20)
  const knnStmt = db.prepare(
    'SELECT rowid, distance FROM spike_vec WHERE embedding MATCH ? AND k = 20'
  )
  const timings: number[] = []
  for (let r = 0; r < 10; r++) {
    const q = vecBuffer(randomFloat32Array(384))
    const ts = performance.now()
    knnStmt.all(q) as Array<{ rowid: number; distance: number }>
    timings.push(performance.now() - ts)
  }
  const knnMin = Math.min(...timings)
  const knnMedian = median(timings)
  log(
    `[Spike][sqlite-vec] KNN k=20 over 1 000 × 384-dim:` +
    ` min=${knnMin.toFixed(2)} ms  median=${knnMedian.toFixed(2)} ms`
  )

  // Step f: probe metadata / partition-key support
  log('[Spike][sqlite-vec] --- Metadata/filtering capability probe ---')

  let partitionKeyOk = false
  let partitionFilterOk = false

  try {
    db.exec(
      'CREATE VIRTUAL TABLE vec_pk_test USING vec0(chat_id text partition key, embedding float[384])'
    )
    log('[Spike][sqlite-vec] partition key syntax: ACCEPTED')
    partitionKeyOk = true

    const ins = db.prepare('INSERT INTO vec_pk_test(chat_id, embedding) VALUES (?, ?)')
    for (let i = 0; i < 5; i++)
      ins.run('chat-a', vecBuffer(randomFloat32Array(384)))
    for (let i = 0; i < 5; i++)
      ins.run('chat-b', vecBuffer(randomFloat32Array(384)))

    const q = vecBuffer(randomFloat32Array(384))
    try {
      const rows = db.prepare(
        "SELECT rowid, distance FROM vec_pk_test WHERE chat_id = 'chat-a' AND embedding MATCH ? AND k = 5"
      ).all(q) as Array<{ rowid: number; distance: number }>
      partitionFilterOk = rows.length > 0 && rows.length <= 5
      log(
        `[Spike][sqlite-vec] partition key filtered KNN: ACCEPTED — ` +
        `${rows.length} rows, chat-a only: ${partitionFilterOk}`
      )
    } catch (filterErr) {
      log(
        `[Spike][sqlite-vec] partition key filtered KNN: REJECTED — ` +
        `${(filterErr as Error).message}`
      )
    }
  } catch (err) {
    log(`[Spike][sqlite-vec] partition key syntax: REJECTED — ${(err as Error).message}`)
  }

  let auxColOk = false
  let auxFilterOk = false

  try {
    db.exec(
      'CREATE VIRTUAL TABLE vec_aux_test USING vec0(embedding float[384], +chat_id text)'
    )
    log('[Spike][sqlite-vec] auxiliary column syntax (+chat_id text): ACCEPTED')
    auxColOk = true

    const ins = db.prepare('INSERT INTO vec_aux_test(embedding, chat_id) VALUES (?, ?)')
    for (let i = 0; i < 5; i++)
      ins.run(vecBuffer(randomFloat32Array(384)), 'chat-a')
    for (let i = 0; i < 5; i++)
      ins.run(vecBuffer(randomFloat32Array(384)), 'chat-b')

    const q = vecBuffer(randomFloat32Array(384))

    // Try WHERE filter on auxiliary column directly in KNN
    try {
      const rows = db.prepare(
        "SELECT rowid, distance FROM vec_aux_test WHERE chat_id = 'chat-a' AND embedding MATCH ? AND k = 5"
      ).all(q) as Array<{ rowid: number; distance: number }>
      auxFilterOk = true
      log(
        `[Spike][sqlite-vec] auxiliary column WHERE filter in KNN: ACCEPTED — ` +
        `${rows.length} rows`
      )
    } catch (filterErr) {
      log(
        `[Spike][sqlite-vec] auxiliary column WHERE filter in KNN: REJECTED — ` +
        `${(filterErr as Error).message}`
      )
      // Demonstrate over-fetch + post-filter as fallback
      const allRows = db.prepare(
        'SELECT rowid, distance, chat_id FROM vec_aux_test WHERE embedding MATCH ? AND k = 10'
      ).all(q) as Array<{ rowid: number; distance: number; chat_id: string }>
      const filtered = allRows.filter(r => r.chat_id === 'chat-a')
      log(
        `[Spike][sqlite-vec] auxiliary column over-fetch k=10 + post-filter: ` +
        `${allRows.length} total → ${filtered.length} chat-a`
      )
    }
  } catch (err) {
    log(`[Spike][sqlite-vec] auxiliary column syntax: REJECTED — ${(err as Error).message}`)
  }

  // Step g: verdict
  const pass = loaded && knnMin < 20
  const capabilities = [
    `vec_version=${version}`,
    `knn_min_ms=${knnMin.toFixed(2)}`,
    `knn_median_ms=${knnMedian.toFixed(2)}`,
    `partition_key_syntax=${partitionKeyOk}`,
    `partition_key_filter=${partitionFilterOk}`,
    `aux_col_syntax=${auxColOk}`,
    `aux_col_where_filter=${auxFilterOk}`,
  ].join(' | ')

  log(`\n[Spike][sqlite-vec] ${pass ? 'PASS' : 'FAIL'} — ${capabilities}`)

  db.close()
  return pass
}

// ── Entry point (when run directly via npm run spike:vec) ─────────────────────
// Guard: only execute when this file is the Node.js entry point (process.argv[1]
// contains the script path). When imported by Vitest, argv[1] is the Vitest runner
// binary — not this script — so the block is entirely inert.
if (process.argv[1]?.includes('spike-sqlite-vec')) {
  runSqliteVecSpike().then(ok => {
    process.exit(ok ? 0 : 1)
  }).catch(err => {
    console.error('[Spike][sqlite-vec] Unhandled error:', err)
    process.exit(1)
  })
}
