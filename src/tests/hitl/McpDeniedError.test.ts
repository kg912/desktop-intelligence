import { describe, it, expect } from 'vitest'
import { McpDeniedError } from '../../main/services/McpServerManager'

describe('McpDeniedError', () => {
  it('is instanceof Error', () => {
    expect(new McpDeniedError('')).toBeInstanceOf(Error)
  })
  it('has name McpDeniedError', () => {
    expect(new McpDeniedError('').name).toBe('McpDeniedError')
  })
  it('carries the userNote string', () => {
    expect(new McpDeniedError('stop this').userNote).toBe('stop this')
  })
  it('userNote is empty string when constructed with empty string', () => {
    expect(new McpDeniedError('').userNote).toBe('')
  })
})
