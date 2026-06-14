// 使用方法：npm test src/__tests__/business/jsonlHandler.test.ts
// 编译说明：仅测试环境
// 代码说明：BL-6 JSONL 数据接收业务单元测试

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import { createJsonlHandler } from '@renderer/business/jsonlHandler'
import { bindPty } from '@renderer/capabilities/ptyBindings'
import { timelineBySessionAtom, lineInsertionsBySessionAtom, subagentTimelineAtom } from '@renderer/atoms/timeline.atom'
import { subagentIdsAtom } from '@renderer/atoms/agent-block.atom'
import type { JsonlRecord } from '@shared/types/jsonl'

function makeRecord(override: Partial<JsonlRecord> = {}): JsonlRecord {
  return {
    type: 'assistant',
    text: '正常回复',
    parsedAt: 1000,
    uuid: 'uuid-1',
    sessionId: 'c1',
    ...override,
  }
}

let store: TestStore
let handler: ReturnType<typeof createJsonlHandler>

beforeEach(() => {
  store = createTestStore()
  handler = createJsonlHandler(store)
})

// ── handleRecord ──────────────────────────────────────────────────────────────

describe('BL-6: handleRecord', () => {
  it('ptyId 通过绑定表解析为 claudeId', () => {
    bindPty(store, 'p1', 'c1')
    handler.handleRecord('p1', makeRecord({ sessionId: 'c1', type: 'assistant', text: '回复' }))
    expect(store.get(timelineBySessionAtom('c1'))).toHaveLength(1)
  })

  it('无绑定时 rawId 原样作为 key', () => {
    handler.handleRecord('unknown-pty', makeRecord({ sessionId: 'unknown-pty', type: 'assistant', text: '回复' }))
    expect(store.get(timelineBySessionAtom('unknown-pty'))).toHaveLength(1)
  })

  it('空文本的 assistant 记录不生成节点', () => {
    bindPty(store, 'p1', 'c1')
    handler.handleRecord('p1', makeRecord({ type: 'assistant', text: '   ' }))
    expect(store.get(timelineBySessionAtom('c1'))).toHaveLength(0)
  })

  it('包含 Insight 块时生成插入线', () => {
    bindPty(store, 'p1', 'c1')
    const insightText = '`★ Insight ─────`\n关键洞见\n`─────────────────`'
    handler.handleRecord('p1', makeRecord({ type: 'assistant', text: insightText }))
    expect(store.get(lineInsertionsBySessionAtom('c1'))).toHaveLength(1)
    expect(store.get(lineInsertionsBySessionAtom('c1'))[0].type).toBe('insight')
  })
})

// ── handleBatchRecords ────────────────────────────────────────────────────────

describe('BL-6: handleBatchRecords', () => {
  it('批量追加多条记录', () => {
    bindPty(store, 'p1', 'c1')
    const records = [
      makeRecord({ uuid: 'n1', type: 'user', text: '用户输入1' }),
      makeRecord({ uuid: 'n2', type: 'assistant', text: '回复1' }),
    ]
    handler.handleBatchRecords('p1', records)
    expect(store.get(timelineBySessionAtom('c1'))).toHaveLength(2)
  })

  it('批量中的 Insight 生成插入线', () => {
    bindPty(store, 'p1', 'c1')
    const insightText = '`★ Insight ─────`\n洞见\n`─────────────────`'
    const records = [makeRecord({ type: 'assistant', text: insightText })]
    handler.handleBatchRecords('p1', records)
    expect(store.get(lineInsertionsBySessionAtom('c1'))).toHaveLength(1)
  })
})

// ── handleSubagentRecord ──────────────────────────────────────────────────────

describe('BL-6: handleSubagentRecord', () => {
  it('写入 subagentTimeline key', () => {
    bindPty(store, 'p1', 'c1')
    handler.handleSubagentRecord('p1', 'agent-1', makeRecord({ type: 'assistant', text: '子 agent 回复' }))
    const key = 'c1::agent-1'
    expect(store.get(subagentTimelineAtom(key))).toHaveLength(1)
  })

  it('注册 agentId 到父 session', () => {
    bindPty(store, 'p1', 'c1')
    handler.handleSubagentRecord('p1', 'agent-1', makeRecord())
    expect(store.get(subagentIdsAtom('c1'))).toContain('agent-1')
  })
})
