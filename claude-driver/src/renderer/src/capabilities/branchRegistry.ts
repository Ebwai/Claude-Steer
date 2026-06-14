// 使用方法：import { registerBranch, updateBranchSnapshot, ... } from '@renderer/capabilities/branchRegistry'
// 编译说明：renderer 进程 browser bundle
// 代码说明：L. Branch 关系能力组——sessionRelationsAtom / branchCountAtom 的读写操作

import { sessionRelationsAtom, branchCountAtom } from '@renderer/atoms/branch.atom'
import type { SessionRelation } from '@renderer/atoms/branch.atom'
import { FRAME_WIDTH, FRAME_GAP_X } from '../hooks/useSessionFrameLayout'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

/**
 * L1: 注册 branch 关系
 * 自动计算 side / lineLength / branchIndex（依据 branchCountAtom）
 */
export function registerBranch(
  store: Store,
  childId: string,
  parentClaudeId: string,
  opts: {
    triggerNodeIndex: number
    inheritedNodeCount?: number
    branchStartUuid?: string
    /** 触发瞬间父框高度快照（px），用于冻结子框 Y 位置 */
    triggerYOffset?: number
  }
): void {
  // key = parentClaudeId，统计该父 session 下所有 branch 总数（不区分触发节点）
  // 决定 side/lineLength 的是该父 session 整体的第几个 branch，与触发位置无关
  const countKey = parentClaudeId

  // 读取当前计数并递增
  const prevCount = store.get(branchCountAtom).get(countKey) ?? 0
  const branchIndex = prevCount + 1
  store.set(branchCountAtom, (prev) => {
    const next = new Map(prev)
    next.set(countKey, branchIndex)
    return next
  })

  const side = branchIndex % 2 === 1 ? 'right' : 'left'
  // lineLength：第 N 个 branch 在同侧累计偏移，每次加 (FRAME_WIDTH + FRAME_GAP_X)
  // 使 branch 框紧靠父框旁边，多个 branch 依次向外排开
  const sameDirectionIndex = Math.ceil(branchIndex / 2)   // 同侧第几个（从 1 开始）
  const lineLength = FRAME_GAP_X + (sameDirectionIndex - 1) * (FRAME_WIDTH + FRAME_GAP_X)

  const relation: SessionRelation = {
    type: 'branch',
    parentSessionId: parentClaudeId,
    triggerNodeIndex: opts.triggerNodeIndex,
    side,
    lineLength,
    branchIndex,
    inheritedNodeCount: opts.inheritedNodeCount,
    branchStartUuid: opts.branchStartUuid,
    triggerYOffset: opts.triggerYOffset,
  }

  store.set(sessionRelationsAtom, (prev) => {
    const next = new Map(prev)
    next.set(childId, relation)
    return next
  })
}

/** L2: 更新 branchStartUuid（JSONL_BRANCH_SNAPSHOT 到达时异步填充） */
export function updateBranchSnapshot(store: Store, childId: string, branchStartUuid: string): void {
  store.set(sessionRelationsAtom, (prev) => {
    const existing = prev.get(childId)
    if (!existing) return prev
    const next = new Map(prev)
    next.set(childId, { ...existing, branchStartUuid })
    return next
  })
}

/**
 * L3: 暂存待合并的 branchStartUuid（竞态：snapshot 早于 BRANCH_LINK 到达时）
 * 使用模块级 Map 存储，由业务层在 registerBranch 后消费
 */
const pendingSnapshots = new Map<string, string>()

export function cachePendingSnapshot(childId: string, uuid: string): void {
  pendingSnapshots.set(childId, uuid)
}

export function consumePendingSnapshot(childId: string): string | undefined {
  const uuid = pendingSnapshots.get(childId)
  if (uuid !== undefined) pendingSnapshots.delete(childId)
  return uuid
}

/** L4: 查询 childId 的 branch 关系 */
export function getBranchRelation(store: Store, childId: string): SessionRelation | undefined {
  return store.get(sessionRelationsAtom).get(childId)
}

/** L5: 查询某父 session 下的所有子 branch */
export function getChildBranches(
  store: Store,
  parentClaudeId: string
): [string, SessionRelation][] {
  const result: [string, SessionRelation][] = []
  for (const [childId, rel] of store.get(sessionRelationsAtom)) {
    if (rel.parentSessionId === parentClaudeId) result.push([childId, rel])
  }
  return result
}

/** L6: 判断 claudeId 是否是 branch 宿主（有子 branch） */
export function isBranchParent(store: Store, claudeId: string): boolean {
  for (const rel of store.get(sessionRelationsAtom).values()) {
    if (rel.parentSessionId === claudeId) return true
  }
  return false
}
