// 使用方法：import { activeSessionsAtom, ptySessionIdsAtom } from '@renderer/atoms/session-core.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：Session 核心 atom——活跃 session Map、PTY 可见集合、派生查询

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { Session } from '@shared/types/index'

/** 所有活跃 session 的 Map（claudeId → Session） */
export const activeSessionsAtom = atom<Map<string, Session>>(new Map())

/**
 * 实时面板可见 session 集合（存 claudeId）
 * 语义：应在 LeftPanel 实时面板显示的 session，与"是否有 PTY 绑定"解耦
 * - SESSION_START 后以 ptyId 临时加入，PTY_BIND 时迁移为 claudeId
 * - /branch 确认后父 claudeId 从此集合移除（父框不再显示在实时面板）
 */
export const ptySessionIdsAtom = atom<Set<string>>(new Set<string>())

/** 按 claudeId 获取单个 session（derived，订阅 activeSessionsAtom） */
export const sessionByIdAtom = atomFamily((sessionId: string) =>
  atom<Session | undefined>((get) => get(activeSessionsAtom).get(sessionId))
)

/** 运行中 session 数量（顶栏"N 运行中"显示） */
export const runningSessionCountAtom = atom<number>((get) => {
  const sessions = get(activeSessionsAtom)
  return Array.from(sessions.values()).filter((s) => s.status === 'Running').length
})
