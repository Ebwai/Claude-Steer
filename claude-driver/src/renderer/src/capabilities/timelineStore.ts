// 使用方法：import { appendTimelineNode, appendInsertion, ... } from '@renderer/capabilities/timelineStore'
// 编译说明：renderer 进程 browser bundle
// 代码说明：K. 时间线数据能力组——timelineBySessionAtom / lineInsertionsBySessionAtom 的读写操作

import { timelineBySessionAtom, lineInsertionsBySessionAtom } from '@renderer/atoms/timeline.atom'
import type { TimelineNode } from '@renderer/atoms/timeline.atom'
import type { LineInsertion, LineInsertionStatus } from '@shared/types/lineInsertion'
import type { PtyBindings } from '@renderer/atoms/pty-binding.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import { IPC } from '@shared/events/ipc-channels'

type Store = Pick<TestStore, 'get' | 'set'>

/** K1: 追加单个时间线节点到指定 claudeId（按 id 去重，防止双路径重复推送） */
export function appendTimelineNode(store: Store, claudeId: string, node: TimelineNode): void {
  store.set(timelineBySessionAtom(claudeId), (prev) => {
    if (prev.some((n) => n.id === node.id)) return prev
    return [...prev, node]
  })
}

/** K2: 批量追加节点（历史回放用，按 id 去重） */
export function appendTimelineNodes(store: Store, claudeId: string, nodes: TimelineNode[]): void {
  if (nodes.length === 0) return
  store.set(timelineBySessionAtom(claudeId), (prev) => {
    const existingIds = new Set(prev.map((n) => n.id))
    const newNodes = nodes.filter((n) => !existingIds.has(n.id))
    if (newNodes.length === 0) return prev
    console.log(`[timelineStore] appendTimelineNodes: +${newNodes.length} new (${nodes.length - newNodes.length} dupes skipped)`)
    return [...prev, ...newNodes]
  })
}

/** 从 activeSessionsAtom 获取 transcriptPath（持久化用） */
export function getTranscriptPath(store: Store, claudeId: string): string | null {
  return store.get(activeSessionsAtom).get(claudeId)?.transcriptPath ?? null
}

/** K3: 追加插入线（PreToolUse → running 状态），并持久化到 insertions.jsonl
 *  若该 id 已存在则跳过（防止 JSONL 历史回放与 insertions.jsonl 回放重复）
 */
export function appendInsertion(store: Store, claudeId: string, insertion: LineInsertion): void {
  let isDuplicate = false
  store.set(lineInsertionsBySessionAtom(claudeId), (prev) => {
    if (prev.some((ins) => ins.id === insertion.id)) {
      isDuplicate = true
      return prev
    }
    return [...prev, insertion]
  })

  if (isDuplicate) return

  const transcriptPath = getTranscriptPath(store, claudeId)
  if (transcriptPath) {
    void window.api.invoke(IPC.INSERTION_APPEND, { transcriptPath, insertion })
      .catch((err: unknown) => console.warn('[timelineStore] insertion:append failed:', err))
  }
}

/**
 * K4: 更新插入线状态
 * matcher 可以是 id（精确）、toolName（按 badgeContent.toolName 匹配最新一条）、
 * 或 { toolUseId } 对象（精确配对）
 */
export function updateInsertionStatus(
  store: Store,
  claudeId: string,
  matcher: string | { toolUseId: string },
  status: LineInsertionStatus
): void {
  let patchedId: string | null = null

  store.set(lineInsertionsBySessionAtom(claudeId), (prev) => {
    // 找到最后一条匹配的插入线索引
    let targetIdx = -1
    if (typeof matcher === 'string') {
      for (let i = prev.length - 1; i >= 0; i--) {
        const ins = prev[i]
        if (ins.id === matcher || ins.badgeContent.toolName === matcher) {
          targetIdx = i
          break
        }
      }
    } else {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].toolUseId === matcher.toolUseId) {
          targetIdx = i
          break
        }
      }
    }
    if (targetIdx === -1) return prev
    patchedId = prev[targetIdx].id
    const next = [...prev]
    next[targetIdx] = { ...next[targetIdx], status, isAnimating: status === 'running' }
    return next
  })

  // 持久化 patch（状态变更，仅保存 id + 变更字段）
  if (patchedId) {
    const transcriptPath = getTranscriptPath(store, claudeId)
    if (transcriptPath) {
      void window.api.invoke(IPC.INSERTION_PATCH, {
        transcriptPath,
        patch: { _patch: true, id: patchedId, status, isAnimating: status === 'running' },
      }).catch((err: unknown) => console.warn('[timelineStore] insertion:patch failed:', err))
    }
  }
}

/**
 * K4b: 对插入线应用任意字段 patch（btw 回答回填等场景）
 * badgeContent 做深合并（不覆盖原有字段），其余字段浅合并。
 * 同时更新内存 atom 和持久化文件。
 */
export function patchInsertion(
  store: Store,
  claudeId: string,
  id: string,
  changes: Partial<LineInsertion>
): void {
  store.set(lineInsertionsBySessionAtom(claudeId), (prev) =>
    prev.map((ins) => {
      if (ins.id !== id) return ins
      const merged = { ...ins, ...changes }
      if (changes.badgeContent) {
        merged.badgeContent = { ...ins.badgeContent, ...changes.badgeContent }
      }
      return merged
    })
  )

  const transcriptPath = getTranscriptPath(store, claudeId)
  if (transcriptPath) {
    void window.api.invoke(IPC.INSERTION_PATCH, {
      transcriptPath,
      patch: { _patch: true, id, ...changes },
    }).catch((err: unknown) => console.warn('[timelineStore] insertion:patch (patchInsertion) failed:', err))
  }
}

/**
 * K5: 将原始 ptyId 解析为 claudeId（供 JSONL handler 使用）
 * ptyToClaudeMap 中找不到时原样返回（外部启动场景）
 */
export function resolveTimelineKey(ptyId: string, bindings: PtyBindings): string {
  return bindings.ptyToClaudeMap.get(ptyId) ?? ptyId
}

/** K6: 查询时间线节点数量（内部使用，含所有类型） */
export function getTimelineLength(store: Store, claudeId: string): number {
  return store.get(timelineBySessionAtom(claudeId)).length
}

/**
 * K6c: 查询可见节点数量（user_input + assistant，与 ProcessTimeline DOM 节点序号一致）
 * 用于 branchHandler 计算 triggerNodeIndex，与历史路径 branchTriggerIndex 语义对齐
 */
export function getVisibleNodeCount(store: Store, claudeId: string): number {
  return store.get(timelineBySessionAtom(claudeId))
    .filter((n) => n.type === 'user_input' || n.type === 'assistant')
    .length
}

/** K6b: 查询最后一个时间线节点的 parsedAt（branch 插入线 timestamp 用，保证落入正确时间窗口） */
export function getLastNodeParsedAt(store: Store, claudeId: string): number {
  const nodes = store.get(timelineBySessionAtom(claudeId))
  return nodes.length > 0 ? nodes[nodes.length - 1].parsedAt : Date.now()
}

/** K7: 清空指定 session 的时间线（保留接口，当前未用） */
export function clearTimeline(store: Store, claudeId: string): void {
  store.set(timelineBySessionAtom(claudeId), [])
  store.set(lineInsertionsBySessionAtom(claudeId), [])
}

/**
 * K8: 追加 subagent 内部工具插入线（按 agentId 存内存，按父 session 路径持久化）
 * 与 K3 appendInsertion 对称，但持久化目标路径为 subagents/agent-<agentId>.insertions.jsonl
 */
export function appendSubagentInsertion(
  store: Store,
  parentClaudeId: string,
  agentId: string,
  insertion: LineInsertion,
): void {
  let isDuplicate = false
  store.set(lineInsertionsBySessionAtom(agentId), (prev) => {
    if (prev.some((ins) => ins.id === insertion.id)) {
      isDuplicate = true
      return prev
    }
    return [...prev, insertion]
  })

  if (isDuplicate) return

  const parentTranscriptPath = getTranscriptPath(store, parentClaudeId)
  if (parentTranscriptPath) {
    void window.api.invoke(IPC.INSERTION_SUBAGENT_APPEND, { parentTranscriptPath, agentId, insertion })
      .catch((err: unknown) => console.warn('[timelineStore] subagent insertion:append failed:', err))
  }
}

/**
 * K9: 更新 subagent 内部工具插入线状态
 * 与 K4 updateInsertionStatus 对称，但持久化目标路径为 subagents/agent-<agentId>.insertions.jsonl
 */
export function updateSubagentInsertionStatus(
  store: Store,
  parentClaudeId: string,
  agentId: string,
  matcher: string | { toolUseId: string },
  status: LineInsertionStatus,
): void {
  let patchedId: string | null = null

  store.set(lineInsertionsBySessionAtom(agentId), (prev) => {
    let targetIdx = -1
    if (typeof matcher === 'string') {
      for (let i = prev.length - 1; i >= 0; i--) {
        const ins = prev[i]
        if (ins.id === matcher || ins.badgeContent.toolName === matcher) {
          targetIdx = i
          break
        }
      }
    } else {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].toolUseId === matcher.toolUseId) {
          targetIdx = i
          break
        }
      }
    }
    if (targetIdx === -1) return prev
    patchedId = prev[targetIdx].id
    const next = [...prev]
    next[targetIdx] = { ...next[targetIdx], status, isAnimating: status === 'running' }
    return next
  })

  if (patchedId) {
    const parentTranscriptPath = getTranscriptPath(store, parentClaudeId)
    if (parentTranscriptPath) {
      void window.api.invoke(IPC.INSERTION_SUBAGENT_PATCH, {
        parentTranscriptPath,
        agentId,
        patch: { _patch: true, id: patchedId, status, isAnimating: status === 'running' },
      }).catch((err: unknown) => console.warn('[timelineStore] subagent insertion:patch failed:', err))
    }
  }
}

/**
 * K10: 对 subagent 插入线应用任意字段 patch（badge 回填等场景）
 * 与 K4b patchInsertion 对称，但持久化目标路径为 subagents/agent-<agentId>.insertions.jsonl
 */
export function patchSubagentInsertion(
  store: Store,
  parentClaudeId: string,
  agentId: string,
  id: string,
  changes: Partial<LineInsertion>,
): void {
  store.set(lineInsertionsBySessionAtom(agentId), (prev) =>
    prev.map((ins) => {
      if (ins.id !== id) return ins
      const merged = { ...ins, ...changes }
      if (changes.badgeContent) {
        merged.badgeContent = { ...ins.badgeContent, ...changes.badgeContent }
      }
      return merged
    })
  )

  const parentTranscriptPath = getTranscriptPath(store, parentClaudeId)
  if (parentTranscriptPath) {
    void window.api.invoke(IPC.INSERTION_SUBAGENT_PATCH, {
      parentTranscriptPath,
      agentId,
      patch: { _patch: true, id, ...changes },
    }).catch((err: unknown) => console.warn('[timelineStore] subagent insertion:patch (patchSubagentInsertion) failed:', err))
  }
}
