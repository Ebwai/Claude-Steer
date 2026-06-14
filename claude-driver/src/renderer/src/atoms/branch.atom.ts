// 使用方法：import { sessionRelationsAtom, branchCountAtom } from '@renderer/atoms/branch.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：/branch 关系 atom——子→父关系 Map、branch 序号计数

import { atom } from 'jotai'

export type SessionRelationType = 'branch' | 'parallel'

export interface SessionRelation {
  type: SessionRelationType
  /** branch：父 session claudeId */
  parentSessionId?: string
  /** branch：触发时父时间轴节点索引（用于 Y 偏移计算） */
  triggerNodeIndex?: number
  /**
   * branch：连线伸出方向（奇数 → right，偶数 → left，从 1 开始计）
   */
  side?: 'left' | 'right'
  /**
   * branch：连线长度（px），同一触发节点第 N 个 branch = FRAME_WIDTH * 0.4 * N
   */
  lineLength?: number
  /** 在同一父节点上的第几个 branch（从 1 开始） */
  branchIndex?: number
  /** branch 继承的父 session 节点数（历史兼容字段） */
  inheritedNodeCount?: number
  /**
   * branch 起始 UUID：JSONL file-history-snapshot 的 messageId
   * 用于 ProcessTimeline 过滤父历史前缀，由 JSONL_BRANCH_SNAPSHOT 异步填充
   */
  branchStartUuid?: string
  /**
   * 触发瞬间父框高度快照（px）
   * 布局时子框 Y = 父框Y + triggerYOffset，冻结不随父框后续增长而变化
   * 实时路径：handlePtyBind 时从 allFrameHeightsAtom 读取
   * 历史路径：history-scan 返回的 parentHeightAtBranch 字段填入
   */
  triggerYOffset?: number
}

/**
 * 所有 session 的并行关系 Map（childClaudeId → SessionRelation）
 * key 永远是 childClaudeId，value.parentSessionId 是 parentClaudeId
 * 使用普通 atom 确保任意 session 变化都能触发订阅者重渲染
 */
export const sessionRelationsAtom = atom<Map<string, SessionRelation>>(new Map())

/**
 * 同一父 session 的 branch 总序号计数（不区分触发节点）
 * key = parentClaudeId，value = 已创建的 branch 总数
 * 决定每个子框的 side（奇→right / 偶→left）和 lineLength（同侧累计偏移）
 */
export const branchCountAtom = atom<Map<string, number>>(new Map())
