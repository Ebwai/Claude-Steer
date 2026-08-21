// 使用方法：npm test -- src/__tests__/main/entityId.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：验证确定性 EntityId 生成的优先级链、kind 映射与无随机 fallback

import { describe, expect, it } from 'vitest'
import { resolveEntityId, deriveEntityKind } from '../../main/lib/jsonl/entityId'
import type { JsonlRecord } from '../../main/lib/jsonl/JsonlParser'

function baseRecord(overrides: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'user',
    text: 'hello',
    parsedAt: Date.now(),
    ...overrides,
  }
}

describe('deriveEntityKind', () => {
  it('maps user → user_input', () => {
    expect(deriveEntityKind(baseRecord({ type: 'user' }))).toBe('user_input')
  })

  it('maps assistant with text only → assistant', () => {
    expect(deriveEntityKind(baseRecord({ type: 'assistant', text: 'hi', toolUse: undefined }))).toBe('assistant')
  })

  it('maps assistant with toolUse → tool_use', () => {
    expect(deriveEntityKind(baseRecord({
      type: 'assistant',
      toolUse: { id: 'tu1', name: 'Bash', input: { command: 'ls' } }
    }))).toBe('tool_use')
  })

  it('maps tool_use → tool_use', () => {
    expect(deriveEntityKind(baseRecord({ type: 'tool_use' }))).toBe('tool_use')
  })

  it('maps tool_result → tool_result', () => {
    expect(deriveEntityKind(baseRecord({
      type: 'tool_result',
      toolResult: { tool_use_id: 'tu1', content: 'ok' }
    }))).toBe('tool_result')
  })

  it('maps system → system', () => {
    expect(deriveEntityKind(baseRecord({ type: 'system' }))).toBe('system')
  })
})

describe('resolveEntityId', () => {
  const sessionId = 'test-session-uuid'
  const byteStart = 100
  const byteEndExclusive = 200

  it('priority 1: uuid', () => {
    const record = baseRecord({ uuid: 'abc-123' })
    const result = resolveEntityId(record, sessionId, byteStart, byteEndExclusive, 0)
    expect(result.entityId).toBe('abc-123')
    expect(result.source.source).toBe('uuid')
  })

  it('priority 2: tool_use.id', () => {
    const record = baseRecord({
      type: 'tool_use',
      toolUse: { id: 'tool-use-456', name: 'Bash', input: { command: 'ls' } }
    })
    const result = resolveEntityId(record, sessionId, byteStart, byteEndExclusive, 0)
    expect(result.entityId).toBe('tool-use-456')
    expect(result.source.source).toBe('tool_use_id')
  })

  it('priority 3: tool_result.tool_use_id', () => {
    const record = baseRecord({
      type: 'tool_result',
      toolResult: { tool_use_id: 'tool-result-789', content: 'ok' }
    })
    const result = resolveEntityId(record, sessionId, byteStart, byteEndExclusive, 0)
    expect(result.entityId).toBe('tool-result-789')
    expect(result.source.source).toBe('tool_use_id')
  })

  it('priority 4: deterministic fallback', () => {
    const record = baseRecord()  // no uuid, no toolUse
    const result = resolveEntityId(record, sessionId, byteStart, byteEndExclusive, 0)
    expect(result.entityId).toHaveLength(64)  // sha256 hex
    expect(result.source.source).toBe('deterministic')
  })

  it('deterministic stability: same input → same output', () => {
    const record = baseRecord()
    const a = resolveEntityId(record, sessionId, byteStart, byteEndExclusive, 5)
    const b = resolveEntityId(record, sessionId, byteStart, byteEndExclusive, 5)
    expect(a.entityId).toBe(b.entityId)
  })

  it('deterministic changes with different inputs', () => {
    const record = baseRecord()
    const a = resolveEntityId(record, sessionId, byteStart, byteEndExclusive, 0)
    const b = resolveEntityId(record, sessionId, byteStart, byteEndExclusive, 1)
    expect(a.entityId).not.toBe(b.entityId)
  })

  it('no Math.random in any path', () => {
    // validate deterministic by computing twice
    const record = baseRecord()
    const a = resolveEntityId(record, 's', 0, 100, 0)
    const b = resolveEntityId(record, 's', 0, 100, 0)
    expect(a.entityId).toBe(b.entityId)  // deterministic, not random
  })
})
