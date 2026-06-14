// 使用方法：import { agentLabelsAtom } from '@renderer/atoms/agentLabels.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：派生 atom——为每个活跃 session 计算统一的 agentLabel 字符串
//           LeftPanel 实时面板和 ProcessLineCanvas 历史面板从此统一读取，标签保持同步

import { atom } from 'jotai'
import { activeSessionsAtom, ptySessionIdsAtom, sessionRelationsAtom } from './sessions.atom'

/**
 * 为每个活跃 session 派生统一标签（claudeId → label）
 *
 * 实时 session（ptySessionIds 中存在）：主线 / AgentN / Branch / BranchN
 * 历史 session（Completed/Interrupted，不在 ptySessionIds 中）：历史主线 / 历史 AgentN / 历史 Branch / 历史 BranchN
 */
export const agentLabelsAtom = atom<Map<string, string>>((get) => {
  const activeSessions = get(activeSessionsAtom)
  const ptySessionIds = get(ptySessionIdsAtom)
  const sessionRelations = get(sessionRelationsAtom)

  const allSessions = Array.from(activeSessions.values())

  // 实时 session：Running / Paused，且在 ptySessionIds 中
  const liveSessions = allSessions
    .filter((s) => ptySessionIds.has(s.claudeId ?? s.id) && (s.status === 'Running' || s.status === 'Paused'))
    .sort((a, b) => a.startedAt - b.startedAt)

  // 历史 session：不在 ptySessionIds 中
  const histSessions = allSessions
    .filter((s) => !ptySessionIds.has(s.claudeId ?? s.id))
    .sort((a, b) => a.startedAt - b.startedAt)

  const labels = new Map<string, string>()

  // 实时 session 标签
  const liveMain = liveSessions.filter((s) => !sessionRelations.has(s.claudeId ?? s.id))
  const liveBranch = liveSessions.filter((s) => sessionRelations.has(s.claudeId ?? s.id))
  liveMain.forEach((s, idx) => labels.set(s.claudeId ?? s.id, idx === 0 ? '主线' : `Agent${idx + 1}`))
  liveBranch.forEach((s, idx) => labels.set(s.claudeId ?? s.id, idx === 0 ? 'Branch' : `Branch${idx + 1}`))

  // 历史 session 标签（独立编号，不与实时混用）
  const histMain = histSessions.filter((s) => !sessionRelations.has(s.claudeId ?? s.id))
  const histBranch = histSessions.filter((s) => sessionRelations.has(s.claudeId ?? s.id))
  histMain.forEach((s, idx) => labels.set(s.claudeId ?? s.id, idx === 0 ? '历史主线' : `历史 Agent${idx + 1}`))
  histBranch.forEach((s, idx) => labels.set(s.claudeId ?? s.id, idx === 0 ? '历史 Branch' : `历史 Branch${idx + 1}`))

  return labels
})
