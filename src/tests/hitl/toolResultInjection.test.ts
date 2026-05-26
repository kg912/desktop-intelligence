import { describe, it, expect } from 'vitest'
import { buildDeniedToolMessage, buildApprovedToolResult } from '../../main/services/McpServerManager'

describe('buildApprovedToolResult', () => {
  it('prepends user note when note is non-empty', () => {
    const result = buildApprovedToolResult('tool output', 'use /tmp instead')
    expect(result).toBe('[User note: "use /tmp instead"]\n\ntool output')
  })
  it('returns raw result when note is empty string', () => {
    expect(buildApprovedToolResult('tool output', '')).toBe('tool output')
  })
})

describe('buildDeniedToolMessage', () => {
  it('includes base denial text when note is empty', () => {
    const msg = buildDeniedToolMessage('')
    expect(msg).toContain('Tool call denied by user.')
    expect(msg).toContain('Do not attempt this tool call again')
  })
  it('includes user reason line when note is non-empty', () => {
    const msg = buildDeniedToolMessage('wrong repo')
    expect(msg).toContain('User reason: "wrong repo"')
  })
  it('does not include User reason line when note is empty', () => {
    expect(buildDeniedToolMessage('')).not.toContain('User reason')
  })
})
