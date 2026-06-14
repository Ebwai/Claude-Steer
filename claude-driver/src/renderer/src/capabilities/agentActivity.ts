// 使用方法：import { toolStart, toolDone, ... } from '@renderer/capabilities/agentActivity'
// 编译说明：renderer 进程 browser bundle
// 代码说明：M. Agent 活动追踪能力组——agentBlocksAtom / subagentIdsAtom / agentCallCountAtom 的读写操作

import {
  agentBlocksAtom,
  subagentIdsAtom,
  agentCallCountAtom,
  activeSubagentSlotsAtom,
} from '@renderer/atoms/agent-block.atom'
import type {
  AgentBlockState,
  ToolEntry,
  SubagentInfo,
} from '@renderer/atoms/agent-block.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

/** 初始化一个空 AgentBlockState（若不存在） */
function ensureBlock(store: Store, claudeId: string, cwd = ''): AgentBlockState {
  const existing = store.get(agentBlocksAtom).get(claudeId)
  if (existing) return existing
  const blank: AgentBlockState = {
    sessionId: claudeId,
    sessionCwd: cwd,
    workStatusText: '',
    activeTools: [],
    activeExperiences: [],
    activeSubagent: null,
    activeInsight: null,
  }
  store.set(agentBlocksAtom, (prev) => {
    const next = new Map(prev)
    next.set(claudeId, blank)
    return next
  })
  return blank
}

function patchBlock(store: Store, claudeId: string, patch: Partial<AgentBlockState>): void {
  store.set(agentBlocksAtom, (prev) => {
    const existing = prev.get(claudeId)
    if (!existing) return prev
    const next = new Map(prev)
    next.set(claudeId, { ...existing, ...patch })
    return next
  })
}

/** M1: 工具调用开始（写入 activeTools，更新 workStatusText） */
export function toolStart(
  store: Store,
  claudeId: string,
  cwd: string,
  toolEntry: Omit<ToolEntry, 'status'>
): void {
  ensureBlock(store, claudeId, cwd)
  store.set(agentBlocksAtom, (prev) => {
    const existing = prev.get(claudeId)
    if (!existing) return prev
    const entry: ToolEntry = { ...toolEntry, status: 'running' }
    const next = new Map(prev)
    next.set(claudeId, {
      ...existing,
      sessionCwd: cwd,
      activeTools: [...existing.activeTools, entry],
      workStatusText: toolEntry.displayText || toolEntry.toolName,
    })
    return next
  })
}

/** M2: 工具调用完成（按 id 或 toolName 标记 done） */
export function toolDone(store: Store, claudeId: string, matcher: string): void {
  store.set(agentBlocksAtom, (prev) => {
    const existing = prev.get(claudeId)
    if (!existing) return prev
    const activeTools = existing.activeTools.map((t) =>
      t.id === matcher || t.toolName === matcher ? { ...t, status: 'done' as const } : t
    )
    const next = new Map(prev)
    next.set(claudeId, { ...existing, activeTools })
    return next
  })
}

/** M3: 工具调用失败（按 id 或 toolName 标记 failed） */
export function toolFailed(store: Store, claudeId: string, matcher: string): void {
  store.set(agentBlocksAtom, (prev) => {
    const existing = prev.get(claudeId)
    if (!existing) return prev
    const activeTools = existing.activeTools.map((t) =>
      t.id === matcher || t.toolName === matcher ? { ...t, status: 'failed' as const } : t
    )
    const next = new Map(prev)
    next.set(claudeId, { ...existing, activeTools })
    return next
  })
}

/** M4: 显示 Subagent 信息 */
export function showSubagent(store: Store, claudeId: string, info: SubagentInfo): void {
  ensureBlock(store, claudeId)
  patchBlock(store, claudeId, { activeSubagent: info })
}

/** M5: 隐藏 Subagent */
export function hideSubagent(store: Store, claudeId: string): void {
  patchBlock(store, claudeId, { activeSubagent: null })
}

/** M6: 注册 subagentId（去重追加） */
export function registerSubagentId(store: Store, claudeId: string, agentId: string): void {
  store.set(subagentIdsAtom(claudeId), (prev) => {
    if (prev.includes(agentId)) return prev
    return [...prev, agentId]
  })
}

/** M7: 递增 Agent 调用计数，返回新计数值 */
export function incrementAgentCount(store: Store, claudeId: string): number {
  let newCount = 0
  store.set(agentCallCountAtom(claudeId), (prev) => {
    newCount = prev + 1
    return newCount
  })
  return newCount
}

/**
 * M8a: 分配 subagent 槽位，返回槽号（从 1 开始）
 * 20s 内同时活跃的每个 subagent 占一个槽，决定"分配任务"线宽度
 */
export function allocateSubagentSlot(store: Store, claudeId: string, toolUseId: string): number {
  let slot = 1
  store.set(activeSubagentSlotsAtom(claudeId), (prev) => {
    const next = new Map(prev)
    // 槽号 = 当前已用最大槽号 + 1（从已有值中找最大，若无则为 0）
    const maxSlot = next.size > 0 ? Math.max(...next.values()) : 0
    slot = maxSlot + 1
    next.set(toolUseId, slot)
    return next
  })
  console.log(`[agentActivity] allocateSubagentSlot claudeId=${claudeId.slice(0,8)} toolUseId=${toolUseId.slice(0,8)} slot=${slot}`)
  return slot
}

/**
 * M8b: 释放 subagent 槽位（任务返回后调用）
 * 返回该槽位的 customWidth（px），供"返回任务结果"线使用
 */
export function releaseSubagentSlot(store: Store, claudeId: string, toolUseId: string): number {
  let slot = 1
  store.set(activeSubagentSlotsAtom(claudeId), (prev) => {
    slot = prev.get(toolUseId) ?? 1
    const next = new Map(prev)
    next.delete(toolUseId)
    return next
  })
  const width = slot * 144
  console.log(`[agentActivity] releaseSubagentSlot claudeId=${claudeId.slice(0,8)} toolUseId=${toolUseId.slice(0,8)} slot=${slot} width=${width}`)
  return width
}

/** M8: 更新 Insight 文本 */
export function setInsight(store: Store, claudeId: string, text: string): void {
  ensureBlock(store, claudeId)
  patchBlock(store, claudeId, { activeInsight: text })
}

/** M9: 清空工作状态词（Stop Hook 时调用） */
export function clearWorkStatus(store: Store, claudeId: string): void {
  patchBlock(store, claudeId, { workStatusText: '', activeTools: [], activeSubagent: null })
}
