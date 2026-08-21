// 使用方法：npm test -- src/__tests__/main/shellBuilder.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：验证 EntityShell + EntityLocator 构建——summary 生成、locator 填充与无完整正文字段

import { describe, expect, it } from 'vitest'
import { buildEntityShell } from '../../main/lib/jsonl/shellBuilder'
import type { JsonlRecord } from '../../main/lib/jsonl/JsonlParser'
import type { EntityKind } from '../../shared/types/detail'

function baseRecord(overrides: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'user',
    text: 'hello',
    parsedAt: Date.now(),
    ...overrides,
  }
}

describe('buildEntityShell', () => {
  const baseParams = {
    entityId: 'test-entity-123',
    byteStart: 0,
    byteEndExclusive: 100,
    lineEnding: 'lf' as const,
    order: 0,
    filePath: '/path/to/test.jsonl',
    sourceGeneration: 'gen-test',
  }

  it('user_input summary: first 4 lines of text', () => {
    const text = 'line1\nline2\nline3\nline4\nline5'
    const record = baseRecord({ type: 'user', text })
    const { shell } = buildEntityShell({ ...baseParams, record, kind: 'user_input' })
    expect(shell.summary).not.toContain('line5')
    expect(shell.summary).toContain('line1')
    expect(shell.summary).toContain('line4')
  })

  it('assistant summary: first 4 lines', () => {
    const record = baseRecord({ type: 'assistant', text: 'I can help with that.\nLet me check...' })
    const { shell } = buildEntityShell({ ...baseParams, record, kind: 'assistant' })
    expect(shell.summary).toContain('I can help')
  })

  it('tool_use summary: toolName + first string arg', () => {
    const record = baseRecord({
      type: 'tool_use',
      toolUse: { id: 'tu1', name: 'Read', input: { file_path: '/src/main.ts' } }
    })
    const { shell } = buildEntityShell({ ...baseParams, record, kind: 'tool_use' })
    expect(shell.summary).toContain('Read')
    expect(shell.summary).toContain('/src/main.ts')
  })

  it('tool_result summary: result for tool_use_id', () => {
    const record = baseRecord({
      type: 'tool_result',
      toolResult: { tool_use_id: 'tu-abc', content: 'some long output...' }
    })
    const { shell } = buildEntityShell({ ...baseParams, record, kind: 'tool_result' })
    expect(shell.summary).toBe('result for tu-abc')
  })

  it('summary does not exceed 200 characters', () => {
    const longText = 'x'.repeat(500)
    const record = baseRecord({ text: longText })
    const { shell } = buildEntityShell({ ...baseParams, record, kind: 'user_input' })
    expect(shell.summary.length).toBeLessThanOrEqual(200)
  })

  it('locator fields filled correctly', () => {
    const record = baseRecord()
    const { locator } = buildEntityShell({
      ...baseParams,
      record,
      kind: 'user_input',
      byteStart: 50,
      byteEndExclusive: 150,
      lineEnding: 'crlf',
    })
    expect(locator.filePath).toBe('/path/to/test.jsonl')
    expect(locator.byteStart).toBe(50)
    expect(locator.byteEndExclusive).toBe(150)
    expect(locator.encoding).toBe('utf-8')
    expect(locator.lineEnding).toBe('crlf')
  })

  it('EntityShell does not contain text/toolInput/toolResult', () => {
    const record = baseRecord({
      text: 'secret text',
      toolUse: { id: 'tu1', name: 'Bash', input: { command: 'rm -rf /' } },
      toolResult: { tool_use_id: 'tu1', content: 'deleted' }
    })
    const { shell } = buildEntityShell({ ...baseParams, record, kind: 'tool_use' })
    // EntityShell must not leak full content
    const shellKeys = Object.keys(shell)
    expect(shellKeys).not.toContain('text')
    expect(shellKeys).not.toContain('toolInput')
    expect(shellKeys).not.toContain('toolResult')
    expect(shellKeys).not.toContain('raw')
  })

  it('estimatedSize = byteEndExclusive - byteStart', () => {
    const record = baseRecord()
    const { shell } = buildEntityShell({
      ...baseParams,
      record,
      kind: 'user_input',
      byteStart: 200,
      byteEndExclusive: 500,
    })
    expect(shell.estimatedSize).toBe(300)
  })
})
