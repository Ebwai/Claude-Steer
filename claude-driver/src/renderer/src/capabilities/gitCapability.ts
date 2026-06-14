// 使用方法：import { markNodeGitted, unmarkNodeGitted } from '@renderer/capabilities/gitCapability'
// 编译说明：renderer 进程 browser bundle
// 代码说明：P. Git 标记能力组——timelineBySessionAtom 中节点的 isGitted/commitHash 字段读写
//           与 timelineStore.ts 的 appendInsertion 模式对称：更新 atom + IPC 持久化

import { timelineBySessionAtom } from '@renderer/atoms/timeline.atom'
import type { GitMark } from '@shared/types/index'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'
import { getTranscriptPath } from './timelineStore'
import { IPC } from '@shared/events/ipc-channels'

type Store = Pick<TestStore, 'get' | 'set'>

/**
 * P1: 标记节点已被 git 快照
 * 同时更新 atom 和持久化到 <claudeId>.git-marks.jsonl
 */
export function markNodeGitted(store: Store, claudeId: string, nodeId: string, commitHash: string): void {
  store.set(timelineBySessionAtom(claudeId), (prev) =>
    prev.map((n) => n.id === nodeId ? { ...n, isGitted: true, commitHash } : n)
  )

  const transcriptPath = getTranscriptPath(store, claudeId)
  if (transcriptPath) {
    const mark: GitMark = {
      nodeId,
      sessionId: claudeId,
      commitHash,
      createdAt: Date.now(),
    }
    void window.api.invoke(IPC.GIT_MARK_SAVE, { transcriptPath, mark })
      .catch((err: unknown) => console.warn('[gitCapability] git:mark-save failed:', err))
  }
}

/**
 * P1b: 清除节点的 git 标记（删除 commit 后调用）
 * 同时更新 atom 和从 <claudeId>.git-marks.jsonl 中移除该 nodeId
 */
export function unmarkNodeGitted(store: Store, claudeId: string, nodeId: string): void {
  store.set(timelineBySessionAtom(claudeId), (prev) =>
    prev.map((n) => n.id === nodeId ? { ...n, isGitted: false, commitHash: undefined } : n)
  )

  const transcriptPath = getTranscriptPath(store, claudeId)
  if (transcriptPath) {
    void window.api.invoke(IPC.GIT_MARK_DELETE, { transcriptPath, nodeId })
      .catch((err: unknown) => console.warn('[gitCapability] git:mark-delete failed:', err))
  }
}

/**
 * P2: 批量回放 git 标记（历史加载用）
 * 将 git-marks.jsonl 中记录的 marks 应用到已加载的 timelineBySessionAtom
 */
export function replayGitMarks(store: Store, claudeId: string, marks: GitMark[]): void {
  if (marks.length === 0) return
  store.set(timelineBySessionAtom(claudeId), (prev) =>
    prev.map((n) => {
      const mark = marks.find((m) => m.nodeId === n.id)
      return mark ? { ...n, isGitted: true, commitHash: mark.commitHash } : n
    })
  )
  console.log(`[gitCapability] replayGitMarks: applied ${marks.length} marks for ${claudeId.slice(0, 8)}`)
}
