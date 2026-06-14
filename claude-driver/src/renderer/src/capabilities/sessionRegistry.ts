// 使用方法：import { createSession, patchSession, ... } from '@renderer/capabilities/sessionRegistry'
// 编译说明：renderer 进程 browser bundle
// 代码说明：H. Session 注册表能力组——activeSessionsAtom 的所有写操作，纯函数形式（接受 store 参数）

import type { Session } from '@shared/types/index'
import type { PtyBindings } from '@renderer/atoms/pty-binding.atom'
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import { IPC } from '@shared/events/ipc-channels'
import { pathMatches } from '@renderer/utils/pathUtils'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

// 兼容生产 store 和测试 store 的类型
type Store = Pick<TestStore, 'get' | 'set'>

/** H1: 以指定 key 创建 Session entry（同时持久化 startedAt 到 .meta.json） */
export function createSession(store: Store, key: string, session: Session): void {
  store.set(activeSessionsAtom, (prev) => {
    const next = new Map(prev)
    next.set(key, session)
    return next
  })

  // 持久化 startedAt，确保 live/restore 一致
  if (typeof window !== 'undefined' && window.api && session.startedAt && session.cwd) {
    void window.api.invoke(
      IPC.SESSION_META_WRITE,
      { claudeId: session.claudeId ?? key, cwd: session.cwd, startedAt: session.startedAt }
    ).catch((err: unknown) => {
      console.warn('[sessionRegistry] meta write failed:', err)
    })
  }
}

/** H3: 部分更新 Session 字段（claudeId key） */
export function patchSession(store: Store, claudeId: string, patch: Partial<Session>): void {
  store.set(activeSessionsAtom, (prev) => {
    const existing = prev.get(claudeId)
    if (!existing) return prev
    const next = new Map(prev)
    next.set(claudeId, { ...existing, ...patch })
    return next
  })
}

/** H4: 标记 Session 完成（status=Completed, endedAt） */
export function completeSession(store: Store, claudeId: string, endedAt: number): void {
  patchSession(store, claudeId, { status: 'Completed', endedAt })
}

/** H5: 按 claudeId 查询 Session */
export function getSession(store: Store, claudeId: string): Session | undefined {
  return store.get(activeSessionsAtom).get(claudeId)
}

/**
 * H6: 按 CWD 反查 Session（精确匹配或 startsWith 子路径匹配）
 * 返回 [key, Session] 或 undefined
 */
export function findSessionByCwd(
  store: Store,
  cwd: string
): [string, Session] | undefined {
  for (const [key, s] of store.get(activeSessionsAtom)) {
    if (pathMatches(cwd, s.cwd)) {
      return [key, s]
    }
  }
  return undefined
}

/**
 * H7: 按 ptyId 查询 Session（需要绑定表辅助）
 * 先通过 ptyToClaudeMap 查 claudeId，再从 activeSessionsAtom 取
 */
export function findSessionByPtyId(
  store: Store,
  ptyId: string,
  bindings: PtyBindings
): Session | undefined {
  const claudeId = bindings.ptyToClaudeMap.get(ptyId)
  if (claudeId) return store.get(activeSessionsAtom).get(claudeId)
  return undefined
}
