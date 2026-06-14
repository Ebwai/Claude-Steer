// 使用方法：npm test src/__tests__/utils/insightExtractor.test.ts
// 编译说明：仅测试环境
// 代码说明：extractInsightText 单元测试

import { describe, it, expect } from 'vitest'
import { extractInsightText } from '@renderer/capabilities/utils/insightExtractor'

const STANDARD = '`★ Insight ─────────────────────────────────────`\n核心知识点在这里\n`─────────────────────────────────────────────────`'

describe('extractInsightText', () => {
  it('标准格式 → 提取内容', () => {
    const result = extractInsightText(STANDARD)
    expect(result).toBe('核心知识点在这里')
  })

  it('无 Insight 块 → null', () => {
    expect(extractInsightText('普通的 assistant 消息')).toBeNull()
  })

  it('只有首标记（无尾标记）→ 返回首标记后全部内容（trim）', () => {
    const text = '`★ Insight ─────`\n内容行1\n内容行2'
    const result = extractInsightText(text)
    expect(result).toBe('内容行1\n内容行2')
  })

  it('内容为空（首尾标记之间只有空白）→ null', () => {
    const text = '`★ Insight ─────`\n   \n`─────`'
    expect(extractInsightText(text)).toBeNull()
  })

  it('多行内容被完整提取', () => {
    const text = '`★ Insight ─────`\n第一点\n第二点\n第三点\n`─────`'
    const result = extractInsightText(text)
    expect(result).toBe('第一点\n第二点\n第三点')
  })

  it('空字符串 → null', () => {
    expect(extractInsightText('')).toBeNull()
  })

  it('首标记中有额外空格也能匹配', () => {
    const text = '`★  Insight  ─────`\n内容\n`─────`'
    expect(extractInsightText(text)).toBe('内容')
  })
})
