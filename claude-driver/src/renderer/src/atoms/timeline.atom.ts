// 使用方法：import { timelineBySessionAtom, lineInsertionsBySessionAtom } from '@renderer/atoms/timeline.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：进程线节点 Jotai 原子——按 sessionId 存储解析后的 JSONL 时间线节点 + 十类插入元素

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { LineInsertion } from '@shared/types/lineInsertion'

// ── 进程线节点类型 ──────────────────────────────────────────────────────────

export type TimelineNodeType = 'user_input' | 'assistant' | 'tool_use' | 'tool_result' | 'system'

export interface TimelineNode {
  /** 节点唯一 ID（来自 JSONL uuid 或生成）*/
  id: string
  sessionId: string
  type: TimelineNodeType
  /** 文本内容（user_input / assistant / system 消息）*/
  text?: string
  /** 工具名称（tool_use / tool_result 节点）*/
  toolName?: string
  /** 工具调用精简显示文本（D13 规则提取）*/
  toolDisplayText?: string
  /** 工具调用 ID（用于 tool_result 与 tool_use 配对）*/
  toolUseId?: string
  /** 是否为错误结果（tool_result 节点）*/
  isError?: boolean
  /** true 表示这是 /branch 后第一条消息（用于 ProcessTimeline 切割父历史前缀）*/
  isBranchStart?: boolean
  /** 该节点是否已被 git 快照 */
  isGitted?: boolean
  /** git 快照对应的 commit hash */
  commitHash?: string
  /** 记录解析时间戳（ms）*/
  parsedAt: number
}

/** 按 sessionId 存储进程线节点列表，使用 atomFamily 支持多 session 并发 */
export const timelineBySessionAtom = atomFamily((_sessionId: string) =>
  atom<TimelineNode[]>([])
)

/**
 * 按 sessionId 存储十类插入元素列表
 * 由 useIpcBridge 监听 Hook 事件时追加，由 ProcessTimeline 读取并在节点间渲染
 */
export const lineInsertionsBySessionAtom = atomFamily((_sessionId: string) =>
  atom<LineInsertion[]>([])
)

/**
 * subagent 子时间线节点，按 agentId 存储
 * key 格式：`${ptySessionId}::${agentId}`（防止不同 session 的 agentId 碰撞）
 */
export const subagentTimelineAtom = atomFamily((_key: string) =>
  atom<TimelineNode[]>([])
)

/**
 * 鼠标拖拽导航条用的位置索引（user_input 维度，粗粒度）
 * -1 = 底部跟随（默认）；≥0 = 当前所在 user_input 区间
 */
export const scrubberIndexAtom = atomFamily((_sessionId: string) =>
  atom<number>(-1)
)

/**
 * 键盘 ↑↓ 精细游标索引（jumpableNodes 维度，覆盖所有节点类型）
 * -1 = 底部跟随（默认）；≥0 = jumpableNodes 列表中的当前游标位置
 */
export const cursorNodeIndexAtom = atomFamily((_sessionId: string) =>
  atom<number>(-1)
)

