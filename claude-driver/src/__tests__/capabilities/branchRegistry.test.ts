// 使用方法：npm test src/__tests__/capabilities/branchRegistry.test.ts
// 编译说明：仅测试环境
// 代码说明：Phase 3-L Branch 关系能力组单元测试

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import {
  registerBranch,
  unregisterBranch,
  updateBranchSnapshot,
  cachePendingSnapshot,
  consumePendingSnapshot,
  getBranchRelation,
  getChildBranches,
  isBranchParent,
} from '@renderer/capabilities/branchRegistry'
import { sessionRelationsAtom, branchCountAtom } from '@renderer/atoms/branch.atom'

let store: TestStore

beforeEach(() => { store = createTestStore() })

// ── L1: registerBranch ───────────────────────────────────────────────────────

describe('L1: registerBranch', () => {
  it('注册后 sessionRelationsAtom 包含子 entry', () => {
    registerBranch(store, 'child-1', 'parent-1', { triggerNodeIndex: 5 })
    expect(store.get(sessionRelationsAtom).has('child-1')).toBe(true)
  })

  it('第一个 branch：side=right，branchIndex=1', () => {
    registerBranch(store, 'child-1', 'parent-1', { triggerNodeIndex: 5 })
    const rel = store.get(sessionRelationsAtom).get('child-1')!
    expect(rel.side).toBe('right')
    expect(rel.branchIndex).toBe(1)
  })

  it('第二个 branch（同父+触发点）：side=left，branchIndex=2', () => {
    registerBranch(store, 'child-1', 'parent-1', { triggerNodeIndex: 5 })
    registerBranch(store, 'child-2', 'parent-1', { triggerNodeIndex: 5 })
    const rel = store.get(sessionRelationsAtom).get('child-2')!
    expect(rel.side).toBe('left')
    expect(rel.branchIndex).toBe(2)
  })

  it('lineLength 按左右交替后的同侧序号向外增长', () => {
    registerBranch(store, 'c1', 'parent-1', { triggerNodeIndex: 0 })
    registerBranch(store, 'c2', 'parent-1', { triggerNodeIndex: 0 })
    registerBranch(store, 'c3', 'parent-1', { triggerNodeIndex: 0 })
    const r1 = store.get(sessionRelationsAtom).get('c1')!
    const r2 = store.get(sessionRelationsAtom).get('c2')!
    const r3 = store.get(sessionRelationsAtom).get('c3')!
    expect(r2.lineLength).toBe(r1.lineLength)
    expect(r3.lineLength!).toBeGreaterThan(r1.lineLength!)
  })

  it('不同触发节点仍按同一父会话全局连续编号', () => {
    registerBranch(store, 'c1', 'parent-1', { triggerNodeIndex: 5 })
    registerBranch(store, 'c2', 'parent-1', { triggerNodeIndex: 10 })
    expect(store.get(sessionRelationsAtom).get('c1')!.branchIndex).toBe(1)
    expect(store.get(sessionRelationsAtom).get('c2')!.branchIndex).toBe(2)
  })

  it('同一 child 重复注册保持幂等且不占用新序号', () => {
    registerBranch(store, 'c1', 'parent-1', { triggerNodeIndex: 5 })
    registerBranch(store, 'c1', 'parent-1', { triggerNodeIndex: 5 })
    expect(store.get(branchCountAtom).get('parent-1')).toBe(1)
    expect(store.get(sessionRelationsAtom).size).toBe(1)
  })

  it('写入 parentSessionId / triggerNodeIndex 字段', () => {
    registerBranch(store, 'child-1', 'parent-1', { triggerNodeIndex: 7 })
    const rel = store.get(sessionRelationsAtom).get('child-1')!
    expect(rel.parentSessionId).toBe('parent-1')
    expect(rel.triggerNodeIndex).toBe(7)
    expect(rel.type).toBe('branch')
  })

  it('传入 branchStartUuid 时写入', () => {
    registerBranch(store, 'child-1', 'parent-1', { triggerNodeIndex: 0, branchStartUuid: 'uuid-abc' })
    expect(store.get(sessionRelationsAtom).get('child-1')!.branchStartUuid).toBe('uuid-abc')
  })
})

// ── L2: updateBranchSnapshot ─────────────────────────────────────────────────

describe('L2: updateBranchSnapshot', () => {
  it('异步更新 branchStartUuid', () => {
    registerBranch(store, 'child-1', 'parent-1', { triggerNodeIndex: 0 })
    updateBranchSnapshot(store, 'child-1', 'uuid-xyz')
    expect(store.get(sessionRelationsAtom).get('child-1')!.branchStartUuid).toBe('uuid-xyz')
  })

  it('childId 不存在时无副作用', () => {
    updateBranchSnapshot(store, 'nonexist', 'uuid-xyz')
    expect(store.get(sessionRelationsAtom).size).toBe(0)
  })

  it('不破坏其他字段', () => {
    registerBranch(store, 'child-1', 'parent-1', { triggerNodeIndex: 5, inheritedNodeCount: 3 })
    updateBranchSnapshot(store, 'child-1', 'uuid-xyz')
    const rel = store.get(sessionRelationsAtom).get('child-1')!
    expect(rel.inheritedNodeCount).toBe(3)
    expect(rel.triggerNodeIndex).toBe(5)
  })
})

// ── L3: cachePendingSnapshot / consumePendingSnapshot ────────────────────────

describe('L3: cachePendingSnapshot + consumePendingSnapshot', () => {
  it('缓存后可消费', () => {
    cachePendingSnapshot('child-1', 'uuid-pending')
    expect(consumePendingSnapshot('child-1')).toBe('uuid-pending')
  })

  it('消费后不再存在', () => {
    cachePendingSnapshot('child-1', 'uuid-pending')
    consumePendingSnapshot('child-1')
    expect(consumePendingSnapshot('child-1')).toBeUndefined()
  })

  it('不存在时返回 undefined', () => {
    expect(consumePendingSnapshot('nonexist')).toBeUndefined()
  })
})

// ── L4: getBranchRelation ────────────────────────────────────────────────────

describe('L4: getBranchRelation', () => {
  it('存在时返回关系对象', () => {
    registerBranch(store, 'child-1', 'parent-1', { triggerNodeIndex: 0 })
    expect(getBranchRelation(store, 'child-1')).toBeDefined()
  })

  it('不存在时返回 undefined', () => {
    expect(getBranchRelation(store, 'nonexist')).toBeUndefined()
  })
})

// ── L5: getChildBranches ─────────────────────────────────────────────────────

describe('L5: getChildBranches', () => {
  it('返回该父 session 的所有子 branch', () => {
    registerBranch(store, 'c1', 'parent-1', { triggerNodeIndex: 0 })
    registerBranch(store, 'c2', 'parent-1', { triggerNodeIndex: 5 })
    registerBranch(store, 'c3', 'parent-2', { triggerNodeIndex: 0 })
    const children = getChildBranches(store, 'parent-1')
    expect(children).toHaveLength(2)
    expect(children.map(([id]) => id)).toContain('c1')
    expect(children.map(([id]) => id)).toContain('c2')
  })

  it('无子 branch 时返回空数组', () => {
    expect(getChildBranches(store, 'nonexist')).toHaveLength(0)
  })
})

// ── L6: isBranchParent ───────────────────────────────────────────────────────

describe('L6: isBranchParent', () => {
  it('有子 branch 时返回 true', () => {
    registerBranch(store, 'child-1', 'parent-1', { triggerNodeIndex: 0 })
    expect(isBranchParent(store, 'parent-1')).toBe(true)
  })

  it('无子 branch 时返回 false', () => {
    expect(isBranchParent(store, 'nonexist')).toBe(false)
  })

  it('子 session 本身不是宿主', () => {
    registerBranch(store, 'child-1', 'parent-1', { triggerNodeIndex: 0 })
    expect(isBranchParent(store, 'child-1')).toBe(false)
  })
})

// ── L7: unregisterBranch / reindexChildren ──────────────────────────────────

describe('L7: unregisterBranch', () => {
  it('删除中间 Branch 后按剩余顺序连续重排且不留位置空洞', () => {
    registerBranch(store, 'c1', 'parent-1', { triggerNodeIndex: 0 })
    registerBranch(store, 'c2', 'parent-1', { triggerNodeIndex: 0 })
    registerBranch(store, 'c3', 'parent-1', { triggerNodeIndex: 0 })

    unregisterBranch(store, 'c2')

    const relations = store.get(sessionRelationsAtom)
    expect(relations.has('c2')).toBe(false)
    expect(relations.get('c1')).toMatchObject({ branchIndex: 1, side: 'right' })
    expect(relations.get('c3')).toMatchObject({ branchIndex: 2, side: 'left' })
    expect(store.get(branchCountAtom).get('parent-1')).toBe(2)
  })
})
