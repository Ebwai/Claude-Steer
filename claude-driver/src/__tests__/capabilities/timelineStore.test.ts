// 使用方法：npm test src/__tests__/capabilities/timelineStore.test.ts
// 编译说明：仅测试环境
// 代码说明：Phase 3-K 时间线数据能力组单元测试

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import {
  appendTimelineNode,
  appendTimelineNodes,
  appendInsertion,
  updateInsertionStatus,
  resolveTimelineKey,
  getTimelineLength,
  clearTimeline,
} from '@renderer/capabilities/timelineStore'
import { timelineBySessionAtom, lineInsertionsBySessionAtom } from '@renderer/atoms/timeline.atom'
import type { TimelineNode } from '@renderer/atoms/timeline.atom'
import type { LineInsertion } from '@shared/types/lineInsertion'
import type { PtyBindings } from '@renderer/atoms/pty-binding.atom'

function makeNode(override: Partial<TimelineNode> = {}): TimelineNode {
  return {
    id: 'n1',
    sessionId: 'c1',
    type: 'assistant',
    parsedAt: 1000,
    ...override,
  }
}

function makeInsertion(override: Partial<LineInsertion> = {}): LineInsertion {
  return {
    id: 'ins-1',
    type: 'tool',
    direction: 'right',
    color: '#e6430d',
    length: 'medium',
    sessionId: 'c1',
    timestamp: 1000,
    badgeContent: { toolName: 'Read' },
    status: 'running',
    isAnimating: true,
    ...override,
  }
}

function makeBindings(map: Record<string, string> = {}): PtyBindings {
  return {
    ptyToClaudeMap: new Map(Object.entries(map)),
    claudeToPtyMap: new Map(Object.entries(map).map(([k, v]) => [v, k])),
  }
}

let store: TestStore

beforeEach(() => { store = createTestStore() })

// ── K1: appendTimelineNode ───────────────────────────────────────────────────

describe('K1: appendTimelineNode', () => {
  it('追加后节点列表含该节点', () => {
    const node = makeNode()
    appendTimelineNode(store, 'c1', node)
    expect(store.get(timelineBySessionAtom('c1'))).toHaveLength(1)
    expect(store.get(timelineBySessionAtom('c1'))[0]).toEqual(node)
  })

  it('多次追加保持顺序', () => {
    appendTimelineNode(store, 'c1', makeNode({ id: 'n1' }))
    appendTimelineNode(store, 'c1', makeNode({ id: 'n2' }))
    const nodes = store.get(timelineBySessionAtom('c1'))
    expect(nodes[0].id).toBe('n1')
    expect(nodes[1].id).toBe('n2')
  })

  it('不同 session 互不干扰', () => {
    appendTimelineNode(store, 'c1', makeNode({ id: 'n1', sessionId: 'c1' }))
    appendTimelineNode(store, 'c2', makeNode({ id: 'n2', sessionId: 'c2' }))
    expect(store.get(timelineBySessionAtom('c1'))).toHaveLength(1)
    expect(store.get(timelineBySessionAtom('c2'))).toHaveLength(1)
  })
})

// ── K2: appendTimelineNodes ──────────────────────────────────────────────────

describe('K2: appendTimelineNodes', () => {
  it('批量追加多个节点', () => {
    const nodes = [makeNode({ id: 'n1' }), makeNode({ id: 'n2' }), makeNode({ id: 'n3' })]
    appendTimelineNodes(store, 'c1', nodes)
    expect(store.get(timelineBySessionAtom('c1'))).toHaveLength(3)
  })

  it('空数组不触发更新（size 不变）', () => {
    appendTimelineNode(store, 'c1', makeNode())
    appendTimelineNodes(store, 'c1', [])
    expect(store.get(timelineBySessionAtom('c1'))).toHaveLength(1)
  })
})

// ── K3: appendInsertion ──────────────────────────────────────────────────────

describe('K3: appendInsertion', () => {
  it('追加插入线到列表', () => {
    const ins = makeInsertion()
    appendInsertion(store, 'c1', ins)
    expect(store.get(lineInsertionsBySessionAtom('c1'))).toHaveLength(1)
    expect(store.get(lineInsertionsBySessionAtom('c1'))[0]).toEqual(ins)
  })
})

// ── K4: updateInsertionStatus ────────────────────────────────────────────────

describe('K4: updateInsertionStatus', () => {
  it('按 id 精确更新 status', () => {
    appendInsertion(store, 'c1', makeInsertion({ id: 'ins-1', status: 'running' }))
    updateInsertionStatus(store, 'c1', 'ins-1', 'done')
    expect(store.get(lineInsertionsBySessionAtom('c1'))[0].status).toBe('done')
  })

  it('按 toolName 更新最后一条匹配', () => {
    appendInsertion(store, 'c1', makeInsertion({ id: 'a', badgeContent: { toolName: 'Read' } }))
    appendInsertion(store, 'c1', makeInsertion({ id: 'b', badgeContent: { toolName: 'Read' } }))
    updateInsertionStatus(store, 'c1', 'Read', 'done')
    const list = store.get(lineInsertionsBySessionAtom('c1'))
    expect(list[1].status).toBe('done')
    expect(list[0].status).toBe('running')
  })

  it('按 toolUseId 精确配对更新', () => {
    appendInsertion(store, 'c1', makeInsertion({ id: 'a', toolUseId: 'tu-1' }))
    updateInsertionStatus(store, 'c1', { toolUseId: 'tu-1' }, 'failed')
    expect(store.get(lineInsertionsBySessionAtom('c1'))[0].status).toBe('failed')
  })

  it('未找到 matcher 时无副作用', () => {
    appendInsertion(store, 'c1', makeInsertion({ status: 'running' }))
    updateInsertionStatus(store, 'c1', 'nonexist', 'done')
    expect(store.get(lineInsertionsBySessionAtom('c1'))[0].status).toBe('running')
  })

  it('done 状态时 isAnimating 变为 false', () => {
    appendInsertion(store, 'c1', makeInsertion({ id: 'ins-1', isAnimating: true }))
    updateInsertionStatus(store, 'c1', 'ins-1', 'done')
    expect(store.get(lineInsertionsBySessionAtom('c1'))[0].isAnimating).toBe(false)
  })
})

// ── K5: resolveTimelineKey ───────────────────────────────────────────────────

describe('K5: resolveTimelineKey', () => {
  it('ptyId 在绑定表中返回 claudeId', () => {
    const bindings = makeBindings({ 'p1': 'c1' })
    expect(resolveTimelineKey('p1', bindings)).toBe('c1')
  })

  it('ptyId 不在绑定表时原样返回', () => {
    const bindings = makeBindings({})
    expect(resolveTimelineKey('unknown-pty', bindings)).toBe('unknown-pty')
  })
})

// ── K6: getTimelineLength ────────────────────────────────────────────────────

describe('K6: getTimelineLength', () => {
  it('追加 3 个节点后返回 3', () => {
    appendTimelineNodes(store, 'c1', [makeNode({ id: 'a' }), makeNode({ id: 'b' }), makeNode({ id: 'c' })])
    expect(getTimelineLength(store, 'c1')).toBe(3)
  })

  it('空 session 返回 0', () => {
    expect(getTimelineLength(store, 'nonexist')).toBe(0)
  })
})

// ── K7: clearTimeline ────────────────────────────────────────────────────────

describe('K7: clearTimeline', () => {
  it('清空后节点列表和插入线均为空', () => {
    appendTimelineNode(store, 'c1', makeNode())
    appendInsertion(store, 'c1', makeInsertion())
    clearTimeline(store, 'c1')
    expect(store.get(timelineBySessionAtom('c1'))).toHaveLength(0)
    expect(store.get(lineInsertionsBySessionAtom('c1'))).toHaveLength(0)
  })
})
