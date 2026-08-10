// 使用方法：import { timelineBySessionAtom, lineInsertionsBySessionAtom } from '@renderer/atoms/timeline.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：进程线节点 Jotai 原子——按 sessionId 存储解析后的 JSONL 时间线节点 + 十类插入元素

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { LineInsertion } from '@shared/types/lineInsertion'
import type { HistoryTimelineNode } from '@shared/types/history'

// ── 进程线节点类型 ──────────────────────────────────────────────────────────

export type TimelineNode = HistoryTimelineNode
export type TimelineNodeType = HistoryTimelineNode['type']

/**
 * 实时进程线新增内容信号。历史详情水合直接写 atom，不发布此信号，
 * 从而保留实时新增节点的自动 fitView，同时避免后台历史批次拉动视口。
 */
export interface TimelineInsertionSignal {
  sessionId: string
  sequence: number
}

export const timelineInsertionSignalAtom = atom<TimelineInsertionSignal | null>(null)

/** 按 sessionId 存储进程线节点列表，使用 atomFamily 支持多 session 并发 */
export const timelineBySessionAtom = atomFamily((sessionId: string) => {
  void sessionId
  return atom<TimelineNode[]>([])
})

/**
 * 按 sessionId 存储十类插入元素列表
 * 由 useIpcBridge 监听 Hook 事件时追加，由 ProcessTimeline 读取并在节点间渲染
 */
export const lineInsertionsBySessionAtom = atomFamily((sessionId: string) => {
  void sessionId
  return atom<LineInsertion[]>([])
})

/**
 * subagent 子时间线节点，按 agentId 存储
 * key 格式：`${ptySessionId}::${agentId}`（防止不同 session 的 agentId 碰撞）
 */
export const subagentTimelineAtom = atomFamily((key: string) => {
  void key
  return atom<TimelineNode[]>([])
})

/**
 * 鼠标拖拽导航条用的位置索引（user_input 维度，粗粒度）
 * -1 = 底部跟随（默认）；≥0 = 当前所在 user_input 区间
 */
export const scrubberIndexAtom = atomFamily((sessionId: string) => {
  void sessionId
  return atom<number>(-1)
})

/**
 * 键盘 ↑↓ 精细游标索引（jumpableNodes 维度，覆盖所有节点类型）
 * -1 = 底部跟随（默认）；≥0 = jumpableNodes 列表中的当前游标位置
 */
export const cursorNodeIndexAtom = atomFamily((sessionId: string) => {
  void sessionId
  return atom<number>(-1)
})

