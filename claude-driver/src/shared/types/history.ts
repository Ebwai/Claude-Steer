// 使用方法：import type { HistoryOpenInput, HistoryDeleteResult } from '@shared/types/history'
// 编译说明：纯 TypeScript 跨进程契约，main 与 renderer 共同引用
// 代码说明：历史工作区轻量目录、按需详情、Token 库存和事务删除协议

import type { JsonlUsage } from './jsonl'
import type { LineInsertion } from './lineInsertion'
import type { GitMark, Milestone } from './index'
import type { ResourceSnapshot } from './resources'


export type HistoryDetailsState = 'shell' | 'hydrating' | 'resident' | 'error' | 'unavailable'

export interface HistorySidecarFlags {
  meta: boolean
  insertions: boolean
  milestones: boolean
  gitMarks: boolean
  sessionDirectory: boolean
}

/** 单个 Claude Code 会话的轻量目录事实，不包含时间线正文或绝对 sidecar 路径。 */
export interface HistoryCatalogEntry {
  sessionId: string
  projectId: string
  cwd: string
  startedAt: number
  endedAt: number
  parentSessionId: string | null
  forkMessageUuid: string | null
  clusterId: string
  sidecarFlags: HistorySidecarFlags
  subagentCount: number
}

/** 一个主线根和全部传递 Branch；Cluster 不跨后台批次拆分。 */
export interface HistoryClusterSummary {
  clusterId: string
  rootSessionId: string
  sessions: HistoryCatalogEntry[]
  startedAt: number
  endedAt: number
  isOrphaned: boolean
}

/** opaque 后台续扫位置。renderer 只能原样回传，不能解释为页码。 */
export interface HistoryContinuation {
  generation: string
  beforeSortKey: string
}

export type HistoryErrorCode =
  | 'HISTORY_CANCELLED'
  | 'HISTORY_NOT_FOUND'
  | 'HISTORY_SESSION_RUNNING'
  | 'HISTORY_OUTSIDE_ROOT'
  | 'HISTORY_RELATION_CHANGED'
  | 'HISTORY_IO_LOCKED'
  | 'HISTORY_ROLLBACK_FAILED'
  | 'HISTORY_PARSE_PARTIAL'
  | 'HISTORY_IO_ERROR'

export interface HistoryFailure {
  ok: false
  errorCode: HistoryErrorCode
  error: string
}

export interface HistoryOpenInput {
  projectId: string
  projectPath: string
  requestId: string
}

export type HistoryOpenResult =
  | {
      ok: true
      requestId: string
      generation: string
      latestCluster: HistoryClusterSummary | null
      latestProjection: HistoryClusterProjection | null
      continuation: HistoryContinuation | null
      totalClusters: number
    }
  | HistoryFailure

export interface HistoryCatalogContinueInput {
  projectId: string
  projectPath: string
  requestId: string
  continuation: HistoryContinuation
  /** 单轮后台工作量，不是 UI 条数上限。 */
  limit: number
}

export type HistoryCatalogBatch =
  | {
      ok: true
      requestId: string
      generation: string
      clusters: HistoryClusterSummary[]
      continuation: HistoryContinuation | null
    }
  | HistoryFailure

export type HistoryTimelineNodeType =
  | 'user_input'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'system'

/** 历史正文唯一跨进程节点；刻意排除 JsonlRecord.raw、usage、model、cwd 和工具输入。 */
export interface HistoryTimelineNode {
  id: string
  sessionId: string
  type: HistoryTimelineNodeType
  text?: string
  resources?: ResourceSnapshot[]
  toolName?: string
  toolDisplayText?: string
  toolUseId?: string
  isError?: boolean
  isBranchStart?: boolean
  isGitted?: boolean
  commitHash?: string
  parsedAt: number
  /** L1→L2 关联：HistoryService 在投影后填充，Renderer 可用于按需获取全文 */
  detailRef?: { detailKey: string; revision: number; sourceGeneration: string; estimatedSize: number }
  /** 标记 text 已被截断为摘要（仅 SUMMARY_LINES 行），展开时需通过 detailRef 获取全文 */
  textTruncated?: boolean
}

export interface HistorySubagentProjection {
  agentId: string
  timeline: HistoryTimelineNode[]
  insertions: LineInsertion[]
  partialErrors: string[]
}

export interface HistorySessionProjection {
  sessionId: string
  /** Catalog entry survived, but the transcript file is no longer present. */
  transcriptMissing?: boolean
  timeline: HistoryTimelineNode[]
  insertions: LineInsertion[]
  milestones: Milestone[]
  gitMarks: GitMark[]
  subagents: HistorySubagentProjection[]
  triggerNodeIndex: number | null
  partialErrors: string[]
}

export interface HistoryClusterProjection {
  clusterId: string
  sessions: HistorySessionProjection[]
  projectedAt: number
}

export interface HistoryDetailsInput {
  projectId: string
  projectPath: string
  requestId: string
  detailRequestId: string
  generation: string
  clusterId: string
}

export interface HistoryDetailsCancelInput {
  detailRequestId: string
}

export type HistoryDetailsResult =
  | {
      ok: true
      requestId: string
      detailRequestId: string
      generation: string
      projection: HistoryClusterProjection
    }
  | (HistoryFailure & { requestId?: string; detailRequestId?: string; generation?: string })

/** 将刚终止的实时 Session 原子接管为紧凑历史投影。 */
export interface HistorySessionSealInput {
  projectId: string
  projectPath: string
  sessionId: string
  requestId: string
  /** renderer 已持有的目录壳；新 snapshot 中存在者会继续允许按需水合。 */
  knownClusterIds: string[]
  continuation: HistoryContinuation | null
}

export type HistorySessionSealResult =
  | {
      ok: true
      requestId: string
      generation: string
      cluster: HistoryClusterSummary
      projection: HistoryClusterProjection
      continuation: HistoryContinuation | null
      totalClusters: number
    }
  | (HistoryFailure & { requestId?: string; sessionId?: string })

export interface HistoryDeleteInput {
  projectId: string
  projectPath: string
  targetSessionId: string
  scope: 'cluster' | 'branch'
  expectedGeneration: string
  operationId: string
}

export type HistoryDeleteResult =
  | {
      ok: true
      operationId: string
      deletedSessionIds: string[]
      orphanedSessionIds: string[]
      generation: string
      continuation: HistoryContinuation | null
      cleanupPending: boolean
      alreadyDeleted?: boolean
    }
  | (HistoryFailure & { operationId: string })

export interface HistoryTokenInventoryEntry {
  sessionId: string
  projectId: string
  startedAt: number
  model: string | null
  usage: JsonlUsage
}

export interface HistoryTokenInventoryInput {
  projectId: string
  projectPath: string
  requestId: string
}

export type HistoryTokenInventoryResult =
  | {
      ok: true
      requestId: string
      entries: HistoryTokenInventoryEntry[]
    }
  | HistoryFailure
