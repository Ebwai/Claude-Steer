// 使用方法：import { historyProjectsAtom, historyResidentManifestAtom } from '@renderer/atoms/history.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：历史目录壳、详情驻留和删除状态；不复用 activeSessionsAtom

import { atom } from 'jotai'
import type {
  HistoryClusterSummary,
  HistoryContinuation,
  HistoryDetailsState,
  HistoryErrorCode,
} from '@shared/types/history'

export interface HistoryProjectState {
  projectId: string
  projectPath: string
  requestId: string
  generation: string
  clusters: HistoryClusterSummary[]
  continuation: HistoryContinuation | null
  totalClusters: number
  catalogLoading: boolean
  detailsStateByCluster: Map<string, HistoryDetailsState>
  unavailableSessionIds?: Set<string>
  error: string | null
}

export interface HistoryDeleteState {
  operationId: string
  targetSessionId: string
  scope: 'cluster' | 'branch'
  status: 'confirming' | 'deleting' | 'failed'
  errorCode?: HistoryErrorCode
  error?: string
}

/** resident 正文的轻量释放索引；禁止保存 timeline/projection/JsonlRecord 引用。 */
export interface HistoryResidentManifest {
  generation: string
  clusterId: string
  sessionIds: string[]
  subagentIdsBySession: Map<string, string[]>
  triggerNodeIndexBySession: Map<string, number | null>
  frozenHeightBySession: Map<string, number>
}

export interface HistoryLayoutAnchor {
  sessionId: string
  frozenHeight: number
}

export const historyProjectsAtom = atom<Map<string, HistoryProjectState>>(new Map())
export const historyResidentManifestAtom = atom<Map<string, HistoryResidentManifest>>(new Map())
export const historyLayoutAnchorsAtom = atom<Map<string, HistoryLayoutAnchor>>(new Map())
export const historyDeleteStatesAtom = atom<Map<string, HistoryDeleteState>>(new Map())
/** projectId → 尚待主进程紧凑历史投影接管的已结束 Session。 */
export const historyHandoffPendingAtom = atom<Map<string, Set<string>>>(new Map())
