// 使用方法：npm test src/__tests__/utils/toolDisplay.test.ts
// 编译说明：仅测试环境
// 代码说明：toolDisplay 工具函数单元测试

import { describe, it, expect } from 'vitest'
import {
  categorizeToolName,
  toolNameToWorkStatus,
} from '@renderer/capabilities/utils/toolDisplay'

describe('categorizeToolName', () => {
  it('Bash → cli', () => expect(categorizeToolName('Bash')).toBe('cli'))
  it('Read → tool', () => expect(categorizeToolName('Read')).toBe('tool'))
  it('Write → tool', () => expect(categorizeToolName('Write')).toBe('tool'))
  it('Edit → tool', () => expect(categorizeToolName('Edit')).toBe('tool'))
  it('Glob → tool', () => expect(categorizeToolName('Glob')).toBe('tool'))
  it('Grep → tool', () => expect(categorizeToolName('Grep')).toBe('tool'))
  it('Agent → tool（内置工具）', () => expect(categorizeToolName('Agent')).toBe('tool'))
  it('WebFetch → tool', () => expect(categorizeToolName('WebFetch')).toBe('tool'))
  it('mcp__playwright → mcp（非内置）', () => expect(categorizeToolName('mcp__playwright')).toBe('mcp'))
  it('customTool → mcp（非内置视为 mcp）', () => expect(categorizeToolName('customTool')).toBe('mcp'))
})

describe('toolNameToWorkStatus', () => {
  it('Write → Writing', () => expect(toolNameToWorkStatus('Write')).toBe('Writing'))
  it('Edit → Writing', () => expect(toolNameToWorkStatus('Edit')).toBe('Writing'))
  it('MultiEdit → Writing', () => expect(toolNameToWorkStatus('MultiEdit')).toBe('Writing'))
  it('Read → Reading', () => expect(toolNameToWorkStatus('Read')).toBe('Reading'))
  it('Glob → Reading', () => expect(toolNameToWorkStatus('Glob')).toBe('Reading'))
  it('Grep → Reading', () => expect(toolNameToWorkStatus('Grep')).toBe('Reading'))
  it('Bash → Running', () => expect(toolNameToWorkStatus('Bash')).toBe('Running'))
  it('Agent → Subagent: pending', () => expect(toolNameToWorkStatus('Agent')).toBe('Subagent: pending'))
  it('WebFetch → Fetching', () => expect(toolNameToWorkStatus('WebFetch')).toBe('Fetching'))
  it('WebSearch → Fetching', () => expect(toolNameToWorkStatus('WebSearch')).toBe('Fetching'))
  it('Unknown → Thinking', () => expect(toolNameToWorkStatus('SomeTool')).toBe('Thinking'))
})
