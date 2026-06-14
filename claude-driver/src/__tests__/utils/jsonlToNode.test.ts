// 使用方法：npm test src/__tests__/utils/jsonlToNode.test.ts
// 编译说明：仅测试环境
// 代码说明：jsonlRecordToNode 纯函数单元测试

import { describe, it, expect } from 'vitest'
import { jsonlRecordToNode } from '@renderer/capabilities/utils/jsonlToNode'
import type { JsonlRecord } from '@shared/types/jsonl'

function makeRecord(override: Partial<JsonlRecord>): JsonlRecord {
  return {
    type: 'user',
    parsedAt: 1000,
    ...override,
  }
}

describe('jsonlRecordToNode', () => {
  it('type=user，有文本 → user_input 节点', () => {
    const node = jsonlRecordToNode(makeRecord({ type: 'user', text: 'hello', uuid: 'u1' }))
    expect(node).not.toBeNull()
    expect(node?.type).toBe('user_input')
    expect(node?.text).toBe('hello')
    expect(node?.id).toBe('u1')
  })

  it('type=user，文本为空字符串 → null', () => {
    expect(jsonlRecordToNode(makeRecord({ type: 'user', text: '' }))).toBeNull()
  })

  it('type=user，文本只有空白 → null', () => {
    expect(jsonlRecordToNode(makeRecord({ type: 'user', text: '   ' }))).toBeNull()
  })

  it('type=user，text 未定义 → null', () => {
    expect(jsonlRecordToNode(makeRecord({ type: 'user', text: undefined }))).toBeNull()
  })

  it('type=assistant，有文本 → assistant 节点', () => {
    const node = jsonlRecordToNode(makeRecord({ type: 'assistant', text: 'response', uuid: 'a1' }))
    expect(node?.type).toBe('assistant')
    expect(node?.text).toBe('response')
  })

  it('type=assistant，文本为空 → null', () => {
    expect(jsonlRecordToNode(makeRecord({ type: 'assistant', text: '' }))).toBeNull()
  })

  it('type=tool_use，有 toolUse → tool_use 节点，含 toolUseId', () => {
    const node = jsonlRecordToNode(makeRecord({
      type: 'tool_use',
      toolUse: { id: 'tu1', name: 'Read', input: { file_path: '/a.ts' } },
    }))
    expect(node?.type).toBe('tool_use')
    expect(node?.toolUseId).toBe('tu1')
    expect(node?.toolName).toBe('Read')
  })

  it('type=tool_use，toolUse 为 undefined → null', () => {
    expect(jsonlRecordToNode(makeRecord({ type: 'tool_use', toolUse: undefined }))).toBeNull()
  })

  it('type=tool_result，有 toolResult → tool_result 节点', () => {
    const node = jsonlRecordToNode(makeRecord({
      type: 'tool_result',
      toolResult: { tool_use_id: 'tu1', content: 'ok', is_error: false },
    }))
    expect(node?.type).toBe('tool_result')
    expect(node?.toolUseId).toBe('tu1')
    expect(node?.isError).toBe(false)
    expect(node?.text).toBe('ok')
  })

  it('type=tool_result，is_error=true 正确传递', () => {
    const node = jsonlRecordToNode(makeRecord({
      type: 'tool_result',
      toolResult: { tool_use_id: 'tu2', content: 'err', is_error: true },
    }))
    expect(node?.isError).toBe(true)
  })

  it('type=tool_result，content 非 string → text 为 undefined', () => {
    const node = jsonlRecordToNode(makeRecord({
      type: 'tool_result',
      toolResult: { tool_use_id: 'tu3', content: [{ type: 'text', text: 'x' }] as unknown as string, is_error: false },
    }))
    expect(node?.text).toBeUndefined()
  })

  it('type=tool_result，toolResult 为 undefined → null', () => {
    expect(jsonlRecordToNode(makeRecord({ type: 'tool_result', toolResult: undefined }))).toBeNull()
  })

  it('type 未知（system）→ null', () => {
    expect(jsonlRecordToNode(makeRecord({ type: 'system' }))).toBeNull()
  })

  it('uuid 未提供时自动生成 id', () => {
    const node = jsonlRecordToNode(makeRecord({ type: 'user', text: 'hi', uuid: undefined }))
    expect(typeof node?.id).toBe('string')
    expect(node?.id.length).toBeGreaterThan(0)
  })

  it('isBranchStart 正确传递', () => {
    const node = jsonlRecordToNode(makeRecord({ type: 'user', text: 'hi', isBranchStart: true }))
    expect(node?.isBranchStart).toBe(true)
  })

  it('parsedAt 正确写入', () => {
    const node = jsonlRecordToNode(makeRecord({ type: 'assistant', text: 'x', parsedAt: 5555 }))
    expect(node?.parsedAt).toBe(5555)
  })
})
