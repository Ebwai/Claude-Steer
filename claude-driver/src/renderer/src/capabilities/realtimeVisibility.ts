// 使用方法：import { addToRealtime, removeFromRealtime, ... } from '@renderer/capabilities/realtimeVisibility'
// 编译说明：renderer 进程 browser bundle
// 代码说明：J. 实时面板可见性能力组——ptySessionIdsAtom 的所有写/读操作（语义：哪些 session 显示在实时面板中）

import { ptySessionIdsAtom } from '@renderer/atoms/session-core.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

/** J1: 将 claudeId 加入实时面板可见集合 */
export function addToRealtime(store: Store, claudeId: string): void {
  store.set(ptySessionIdsAtom, (prev) => {
    if (prev.has(claudeId)) return prev
    const next = new Set(prev)
    next.add(claudeId)
    const stack = new Error().stack?.split('\n').slice(2, 5).join(' | ') ?? ''
    console.log(`[RT] addToRealtime: +${claudeId.slice(0,8)} → set size=${next.size} [${Array.from(next).map(s=>s.slice(0,8)).join(',')}] caller=${stack}`)
    return next
  })
}

/** J2: 从实时面板可见集合移除 claudeId（/branch 后父 session 或 session 结束时调用） */
export function removeFromRealtime(store: Store, claudeId: string): void {
  store.set(ptySessionIdsAtom, (prev) => {
    if (!prev.has(claudeId)) return prev
    const next = new Set(prev)
    next.delete(claudeId)
    console.log(`[RT] removeFromRealtime: -${claudeId.slice(0,8)} → set size=${next.size} [${Array.from(next).map(s=>s.slice(0,8)).join(',')}]`)
    return next
  })
}

/** J3: 查询 claudeId 是否在实时面板可见集合中 */
export function isRealtimeVisible(store: Store, claudeId: string): boolean {
  return store.get(ptySessionIdsAtom).has(claudeId)
}

/** J4: 获取当前可见集合（只读快照） */
export function getRealtimeVisible(store: Store): ReadonlySet<string> {
  return store.get(ptySessionIdsAtom)
}
