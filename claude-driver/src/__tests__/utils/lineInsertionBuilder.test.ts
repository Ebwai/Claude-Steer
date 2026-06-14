// 使用方法：npm test src/__tests__/utils/lineInsertionBuilder.test.ts
// 编译说明：仅测试环境
// 代码说明：buildLineInsertion 纯函数单元测试

import { describe, it, expect } from 'vitest'
import { buildLineInsertion } from '@renderer/capabilities/utils/lineInsertionBuilder'

const BASE = { id: 'id1', sessionId: 's1', timestamp: 1000 }

describe('buildLineInsertion', () => {
  it('Agent 工具 → subagent 类型，左方向，lineLabel=分配任务', () => {
    const ins = buildLineInsertion('Agent', {}, BASE.id, BASE.sessionId, BASE.timestamp, 'running')
    expect(ins?.type).toBe('subagent')
    expect(ins?.direction).toBe('left')
    expect(ins?.color).toBe('#DA7756')
    expect(ins?.length).toBe('long')
    expect(ins?.lineLabel).toBe('分配任务')
  })

  it('Bash → tool 类型，右方向', () => {
    const ins = buildLineInsertion('Bash', {}, BASE.id, BASE.sessionId, BASE.timestamp, 'running')
    expect(ins?.type).toBe('tool')
    expect(ins?.direction).toBe('right')
    expect(ins?.color).toBe('#e6430d')
  })

  it('Read → tool 类型', () => {
    const ins = buildLineInsertion('Read', {}, BASE.id, BASE.sessionId, BASE.timestamp, 'running')
    expect(ins?.type).toBe('tool')
    expect(ins?.length).toBe('short')
  })

  it('mcp__playwright → mcp 类型', () => {
    const ins = buildLineInsertion('mcp__playwright', {}, BASE.id, BASE.sessionId, BASE.timestamp, 'done')
    expect(ins?.type).toBe('mcp')
    expect(ins?.direction).toBe('right')
    expect(ins?.length).toBe('medium')
  })

  it('Skill 普通技能 → skill 类型，左方向', () => {
    const ins = buildLineInsertion('Skill', { name: 'code-review' }, BASE.id, BASE.sessionId, BASE.timestamp, 'running')
    expect(ins?.type).toBe('skill')
    expect(ins?.direction).toBe('left')
    expect(ins?.length).toBe('short')
  })

  it('Skill 含 cli 关键词 → cli 类型', () => {
    const ins = buildLineInsertion('Skill', { name: 'cli-runner' }, BASE.id, BASE.sessionId, BASE.timestamp, 'running')
    expect(ins?.type).toBe('cli')
    expect(ins?.direction).toBe('right')
  })

  it('Skill 含 bash 关键词（大小写不敏感）→ cli 类型', () => {
    const ins = buildLineInsertion('Skill', { name: 'RunBash' }, BASE.id, BASE.sessionId, BASE.timestamp, 'running')
    expect(ins?.type).toBe('cli')
  })

  it('status=running → isAnimating=true', () => {
    const ins = buildLineInsertion('Read', {}, BASE.id, BASE.sessionId, BASE.timestamp, 'running')
    expect(ins?.isAnimating).toBe(true)
  })

  it('status=done → isAnimating=false', () => {
    const ins = buildLineInsertion('Read', {}, BASE.id, BASE.sessionId, BASE.timestamp, 'done')
    expect(ins?.isAnimating).toBe(false)
  })

  it('status=failed → isAnimating=false', () => {
    const ins = buildLineInsertion('Write', {}, BASE.id, BASE.sessionId, BASE.timestamp, 'failed')
    expect(ins?.isAnimating).toBe(false)
  })

  it('sessionId 和 timestamp 正确写入', () => {
    const ins = buildLineInsertion('Grep', {}, 'my-id', 'sess-99', 9999, 'done')
    expect(ins?.sessionId).toBe('sess-99')
    expect(ins?.timestamp).toBe(9999)
    expect(ins?.id).toBe('my-id')
  })

  it('Agent 工具 lineLabel 不为 undefined', () => {
    const ins = buildLineInsertion('Agent', {}, BASE.id, BASE.sessionId, BASE.timestamp, 'running')
    expect(ins?.lineLabel).toBeDefined()
  })

  it('普通工具无 lineLabel', () => {
    const ins = buildLineInsertion('Write', {}, BASE.id, BASE.sessionId, BASE.timestamp, 'running')
    expect(ins?.lineLabel).toBeUndefined()
  })
})
