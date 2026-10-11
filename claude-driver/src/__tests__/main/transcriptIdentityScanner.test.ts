import { describe, expect, it } from 'vitest'
import { TranscriptIdentityScanner } from '../../main/lib/pty/TranscriptIdentityScanner'

describe('bounded transcript identity scanner', () => {
  it('ignores nested and quoted session IDs and waits for complete lines', () => {
    const scanner = new TranscriptIdentityScanner()
    expect(scanner.push('{"message":{"sessionId":"target"},"sessionId":"parent"}\n', 'target')).toBe('conflict')
    expect(scanner.push('{"message":"quoted \\"sessionId\\": \\"target\\""}\n', 'target')).not.toBe('ready')
    scanner.reset()
    expect(scanner.push('{"sessionId":"target"}', 'target')).toBe('waiting')
    expect(scanner.push('\n', 'target')).toBe('ready')
  })

  it('finds an ID after a large message without retaining its body', () => {
    const scanner = new TranscriptIdentityScanner()
    expect(scanner.push('{"message":"', 'target')).toBe('waiting')
    for (let index = 0; index < 50; index++) expect(scanner.push('x'.repeat(65536), 'target')).toBe('waiting')
    expect(scanner.push('","sessionId":"target"}\n', 'target')).toBe('ready')
  })

  it('handles escaped keys and split strings', () => {
    const scanner = new TranscriptIdentityScanner()
    expect(scanner.push('{"session\\u0049d":"tar', 'target')).toBe('waiting')
    expect(scanner.push('get"}\n', 'target')).toBe('ready')
  })
})
