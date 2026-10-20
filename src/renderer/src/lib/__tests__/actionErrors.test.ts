// Rectification R6: step and assess action errors are shown as plain sentences, never Electron's IPC wrapper.
import { describe, it, expect } from 'vitest'
import { describeActionError } from '../actionErrors'

const ipc = (channel: string, message: string): Error => new Error(`Error invoking remote method '${channel}': Error: ${message}`)

describe('describeActionError', () => {
  it('no saved run state', () => {
    expect(describeActionError('no saved state for this run')).toBe('This run has no saved state to continue from, so it cannot be re-run or resumed.')
    expect(describeActionError('No saved run to continue')).toBe('This run has no saved state to continue from, so it cannot be re-run or resumed.')
  })
  it('run not the latest', () => {
    expect(describeActionError('Only the latest run of a chat can be resumed or re-run')).toBe('Re-run is only available for the latest run of this chat.')
  })
  it('a run already in progress', () => {
    for (const m of ['A multi-agent run is already in progress for this chat', 'This run is already in progress', 'The run is still in progress.'])
      expect(describeActionError(m), m).toBe('A run is already in progress in this chat. Wait for it to finish, then try again.')
  })
  it('no OpenRouter key', () => {
    expect(describeActionError(ipc('multi-agent:rerun-step', 'OpenRouter API key is not configured — add it in Settings → Backend')))
      .toBe('Add your OpenRouter API key in Settings → Backend first.')
  })
  it('sidecar unavailable', () => {
    expect(describeActionError('Multi-agent sidecar unavailable: spawn ENOENT')).toBe('The multi-agent service is not running. Try again in a moment, or restart the app.')
    expect(describeActionError('Could not reach the multi-agent sidecar: fetch failed')).toBe('The multi-agent service is not running. Try again in a moment, or restart the app.')
  })
  it('steer and assess refusals', () => {
    expect(describeActionError(ipc('multi-agent:steer', 'That agent is not running'))).toBe('This agent is no longer running, so it cannot be steered.')
    expect(describeActionError(ipc('multi-agent:steer', 'No such live run'))).toBe('This run is no longer running.')
    expect(describeActionError(ipc('multi-agent:assess-finish', 'This run is not waiting for an assess decision'))).toBe('This decision has already been made.')
  })
  it('an unknown error shows its message with the IPC wrapper stripped', () => {
    expect(describeActionError(ipc('multi-agent:lock-step', 'Sidecar lock failed (404)'))).toBe('Sidecar lock failed (404)')
    expect(describeActionError(new Error('Something odd'))).toBe('Something odd')
    expect(describeActionError(42)).toBe('42')
  })
})
