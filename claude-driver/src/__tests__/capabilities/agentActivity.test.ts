// 使用方法：npm test src/__tests__/capabilities/agentActivity.test.ts
// 编译说明：仅测试环境
// 代码说明：Phase 3-M Agent 活动追踪能力组单元测试

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import {
  toolStart,
  toolDone,
  toolFailed,
  showSubagent,
  hideSubagent,
  registerSubagentId,
  incrementAgentCount,
  setInsight,
  clearWorkStatus,
} from '@renderer/capabilities/agentActivity'
import { agentBlocksAtom, subagentIdsAtom, agentCallCountAtom } from '@renderer/atoms/agent-block.atom'

let store: TestStore

beforeEach(() => { store = createTestStore() })

function makeToolEntry(override: Record<string, unknown> = {}) {
  return {
    id: 'tool-1',
    toolName: 'Read',
    displayText: '读取文件',
    category: 'tool' as const,
    startedAt: 1000,
    ...override,
  }
}

// ── M1: toolStart ────────────────────────────────────────────────────────────

describe('M1: toolStart', () => {
  it('初始化 block 并写入 activeTools', () => {
    toolStart(store, 'c1', '/proj', makeToolEntry())
    const block = store.get(agentBlocksAtom).get('c1')!
    expect(block.activeTools).toHaveLength(1)
    expect(block.activeTools[0].status).toBe('running')
  })

  it('workStatusText 更新为 displayText', () => {
    toolStart(store, 'c1', '/proj', makeToolEntry({ displayText: '读取文件' }))
    expect(store.get(agentBlocksAtom).get('c1')!.workStatusText).toBe('读取文件')
  })

  it('多次 toolStart 累积到 activeTools', () => {
    toolStart(store, 'c1', '/proj', makeToolEntry({ id: 't1' }))
    toolStart(store, 'c1', '/proj', makeToolEntry({ id: 't2' }))
    expect(store.get(agentBlocksAtom).get('c1')!.activeTools).toHaveLength(2)
  })

  it('sessionCwd 随调用更新', () => {
    toolStart(store, 'c1', '/new-cwd', makeToolEntry())
    expect(store.get(agentBlocksAtom).get('c1')!.sessionCwd).toBe('/new-cwd')
  })
})

// ── M2: toolDone ─────────────────────────────────────────────────────────────

describe('M2: toolDone', () => {
  it('按 id 标记 done', () => {
    toolStart(store, 'c1', '/proj', makeToolEntry({ id: 'tool-1' }))
    toolDone(store, 'c1', 'tool-1')
    expect(store.get(agentBlocksAtom).get('c1')!.activeTools[0].status).toBe('done')
  })

  it('按 toolName 标记 done', () => {
    toolStart(store, 'c1', '/proj', makeToolEntry({ toolName: 'Write' }))
    toolDone(store, 'c1', 'Write')
    expect(store.get(agentBlocksAtom).get('c1')!.activeTools[0].status).toBe('done')
  })

  it('claudeId 不存在时无副作用', () => {
    toolDone(store, 'nonexist', 'Read')
    expect(store.get(agentBlocksAtom).size).toBe(0)
  })
})

// ── M3: toolFailed ───────────────────────────────────────────────────────────

describe('M3: toolFailed', () => {
  it('标记 failed 状态', () => {
    toolStart(store, 'c1', '/proj', makeToolEntry({ id: 'tool-1' }))
    toolFailed(store, 'c1', 'tool-1')
    expect(store.get(agentBlocksAtom).get('c1')!.activeTools[0].status).toBe('failed')
  })
})

// ── M4: showSubagent / M5: hideSubagent ──────────────────────────────────────

describe('M4+M5: showSubagent + hideSubagent', () => {
  it('showSubagent 写入 activeSubagent', () => {
    showSubagent(store, 'c1', { subagentId: 'agent-1', description: '执行任务', startedAt: 1000 })
    expect(store.get(agentBlocksAtom).get('c1')!.activeSubagent?.subagentId).toBe('agent-1')
  })

  it('hideSubagent 清除 activeSubagent', () => {
    showSubagent(store, 'c1', { subagentId: 'agent-1', description: '任务', startedAt: 1000 })
    hideSubagent(store, 'c1')
    expect(store.get(agentBlocksAtom).get('c1')!.activeSubagent).toBeNull()
  })
})

// ── M6: registerSubagentId ───────────────────────────────────────────────────

describe('M6: registerSubagentId', () => {
  it('追加 agentId', () => {
    registerSubagentId(store, 'c1', 'agent-1')
    expect(store.get(subagentIdsAtom('c1'))).toContain('agent-1')
  })

  it('重复注册不增加列表长度', () => {
    registerSubagentId(store, 'c1', 'agent-1')
    registerSubagentId(store, 'c1', 'agent-1')
    expect(store.get(subagentIdsAtom('c1'))).toHaveLength(1)
  })

  it('多个不同 agentId 均追加', () => {
    registerSubagentId(store, 'c1', 'agent-1')
    registerSubagentId(store, 'c1', 'agent-2')
    expect(store.get(subagentIdsAtom('c1'))).toHaveLength(2)
  })
})

// ── M7: incrementAgentCount ──────────────────────────────────────────────────

describe('M7: incrementAgentCount', () => {
  it('初始为 0，递增后返回 1', () => {
    expect(incrementAgentCount(store, 'c1')).toBe(1)
  })

  it('多次递增返回递增值', () => {
    incrementAgentCount(store, 'c1')
    incrementAgentCount(store, 'c1')
    expect(incrementAgentCount(store, 'c1')).toBe(3)
  })

  it('atom 值与返回值一致', () => {
    const count = incrementAgentCount(store, 'c1')
    expect(store.get(agentCallCountAtom('c1'))).toBe(count)
  })
})

// ── M8: setInsight ───────────────────────────────────────────────────────────

describe('M8: setInsight', () => {
  it('写入 activeInsight', () => {
    setInsight(store, 'c1', '重要洞见文本')
    expect(store.get(agentBlocksAtom).get('c1')!.activeInsight).toBe('重要洞见文本')
  })

  it('覆盖已有 insight', () => {
    setInsight(store, 'c1', '旧洞见')
    setInsight(store, 'c1', '新洞见')
    expect(store.get(agentBlocksAtom).get('c1')!.activeInsight).toBe('新洞见')
  })
})

// ── M9: clearWorkStatus ──────────────────────────────────────────────────────

describe('M9: clearWorkStatus', () => {
  it('清空 workStatusText、activeTools、activeSubagent', () => {
    toolStart(store, 'c1', '/proj', makeToolEntry())
    showSubagent(store, 'c1', { subagentId: 'a1', description: '任务', startedAt: 1000 })
    clearWorkStatus(store, 'c1')
    const block = store.get(agentBlocksAtom).get('c1')!
    expect(block.workStatusText).toBe('')
    expect(block.activeTools).toHaveLength(0)
    expect(block.activeSubagent).toBeNull()
  })

  it('不影响 activeInsight', () => {
    setInsight(store, 'c1', '洞见')
    toolStart(store, 'c1', '/proj', makeToolEntry())
    clearWorkStatus(store, 'c1')
    expect(store.get(agentBlocksAtom).get('c1')!.activeInsight).toBe('洞见')
  })
})
