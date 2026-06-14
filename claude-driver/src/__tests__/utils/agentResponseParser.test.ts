// 使用方法：npm test src/__tests__/utils/agentResponseParser.test.ts
// 编译说明：仅测试环境
// 代码说明：extractAgentResponse 单元测试

import { describe, it, expect } from 'vitest'
import { extractAgentResponse } from '@renderer/capabilities/utils/agentResponseParser'

describe('extractAgentResponse', () => {
  it('null → 空字符串', () => expect(extractAgentResponse(null)).toBe(''))
  it('undefined → 空字符串', () => expect(extractAgentResponse(undefined)).toBe(''))

  it('string 类型 → trim 返回', () => {
    expect(extractAgentResponse('  hello  ')).toBe('hello')
  })

  it('空字符串 → 空字符串', () => {
    expect(extractAgentResponse('')).toBe('')
  })

  it('{ content: string } → 返回 content.trim()', () => {
    expect(extractAgentResponse({ content: '  result  ' })).toBe('result')
  })

  it('{ content: [{type:"text", text:"..."}] } → 合并文本', () => {
    const raw = { content: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }] }
    expect(extractAgentResponse(raw)).toBe('part1 part2')
  })

  it('{ content: [...] } 过滤非 text 块', () => {
    const raw = { content: [{ type: 'image', url: 'x' }, { type: 'text', text: 'ok' }] }
    expect(extractAgentResponse(raw)).toBe('ok')
  })

  it('Array<{type,text}> 直接传入 → 合并', () => {
    const raw = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]
    expect(extractAgentResponse(raw)).toBe('a b')
  })

  it('Array 为空 → 空字符串', () => {
    expect(extractAgentResponse([])).toBe('')
  })

  it('{ result: string } 旧版格式 → 返回 result', () => {
    expect(extractAgentResponse({ result: 'legacy result' })).toBe('legacy result')
  })

  it('无任何已知字段的对象 → 空字符串', () => {
    expect(extractAgentResponse({ unknown: 'field' })).toBe('')
  })

  it('content 优先于 result', () => {
    expect(extractAgentResponse({ content: 'new', result: 'old' })).toBe('new')
  })
})
