// Rectification R6: errors from step and assess actions as plain sentences. Electron wraps an IPC handler's error as
// "Error invoking remote method '<channel>': Error: <message>"; the wrapper is stripped by its fixed prefix, then the
// exact messages our own main process and sidecar produce are mapped (an exact table, not a guess). Anything else
// shows its stripped message.

const IPC_WRAPPER = "Error invoking remote method '"

const NO_STATE = 'This run has no saved state to continue from, so it cannot be re-run or resumed.'
const IN_PROGRESS = 'A run is already in progress in this chat. Wait for it to finish, then try again.'
const SIDECAR_DOWN = 'The multi-agent service is not running. Try again in a moment, or restart the app.'

/** Exact messages (MultiAgentRunCoordinator, MultiAgentSidecarManager, the sidecar's HTTP details, useMultiAgentRun). */
const EXACT: Record<string, string> = {
  'no saved state for this run': NO_STATE,
  'No saved run to continue': NO_STATE,
  'Only the latest run of a chat can be resumed or re-run': 'Re-run is only available for the latest run of this chat.',
  'A multi-agent run is already in progress for this chat': IN_PROGRESS,
  'This run is already in progress': IN_PROGRESS,
  'The run is still in progress.': IN_PROGRESS,
  'the run is already running': IN_PROGRESS,
  'That agent is not running': 'This agent is no longer running, so it cannot be steered.',
  'No such live run': 'This run is no longer running.',
  'This run is not waiting for an assess decision': 'This decision has already been made.',
}
/** Messages that end with a variable detail (an error from the system). */
const PREFIX: Array<[string, string]> = [
  ['OpenRouter API key is not configured', 'Add your OpenRouter API key in Settings → Backend first.'],
  ['Multi-agent sidecar unavailable', SIDECAR_DOWN],
  ['Could not reach the multi-agent sidecar', SIDECAR_DOWN],
]

export function describeActionError(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err)
  if (message.startsWith(IPC_WRAPPER)) {
    const end = message.indexOf("': ", IPC_WRAPPER.length)
    if (end >= 0) message = message.slice(end + 3)
  }
  if (message.startsWith('Error: ')) message = message.slice('Error: '.length)
  return EXACT[message] ?? PREFIX.find(([prefix]) => message.startsWith(prefix))?.[1] ?? message
}
