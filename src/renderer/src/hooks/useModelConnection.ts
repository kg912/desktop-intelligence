import { useEffect, useState, useCallback } from 'react'
import type { ConnectionState } from '../../../shared/types'

const INITIAL_STATE: ConnectionState = {
  status:        'loading',
  modelInfo:     null,
  lastChecked:   null,
  error:         null,
  pollIntervalMs: 3000
}

/**
 * useModelConnection
 *
 * Single source of truth for connection state in the renderer.
 * - Fetches initial state on mount
 * - Subscribes to push updates from the Main process
 * - Exposes a `retry` function for manual re-poll
 */
export function useModelConnection() {
  const [state, setState] = useState<ConnectionState>(INITIAL_STATE)

  useEffect(() => {
    // 1. Get current state immediately (handles page reloads / late mount)
    window.api.getModelStatus().then(setState).catch(console.error)

    // 2. Subscribe to real-time push updates from Main process
    const unsubscribe = window.api.onModelStatusChange((newState) => {
      setState(newState)
    })

    return unsubscribe
  }, [])

  const retry = useCallback(async () => {
    // Optimistically show 'connecting' while the poll runs
    setState((prev) => ({ ...prev, status: 'connecting', error: null }))
    try {
      const newState = await window.api.forcePoll()
      setState(newState)
    } catch (err) {
      console.error('Force poll failed:', err)
    }
  }, [])

  return { ...state, retry }
}
