// 使用方法：由 useHistoryWorkingSet 根据历史目录、观看锚点和实时集合计算详情驻留
// 编译说明：renderer 纯 TypeScript；无 React/IPC 依赖，可在 Vitest Node 环境直接测试
// 代码说明：完整 Cluster 是唯一工作集原子，Branch 永不被单独拆出水合/回收

import type { HistoryClusterSummary } from '@shared/types/history'

export type HistoryNavigationDirection = 'left' | 'right' | null
export type HistoryInteractionPhase = 'idle' | 'manual' | 'animating' | 'settling'

export interface HistoryWorkingSet {
  anchorClusterId: string | null
  targetClusterId: string | null
  hot: Set<string>
  warm: Set<string>
  cold: Set<string>
  warmPriority: string[]
}

export interface HistoryWorkingSetInput {
  clusters: HistoryClusterSummary[]
  anchorSessionId: string | null
  targetSessionId?: string | null
  realtimeClusterIds?: Iterable<string>
  direction?: HistoryNavigationDirection
}

function findClusterIdBySession(clusters: HistoryClusterSummary[], sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  return clusters.find((cluster) => cluster.sessions.some((entry) => entry.sessionId === sessionId))?.clusterId ?? null
}

function addRange(target: Set<string>, ids: string[], center: number, radius: number): void {
  if (center < 0) return
  const start = Math.max(0, center - radius)
  const end = Math.min(ids.length - 1, center + radius)
  for (let index = start; index <= end; index++) target.add(ids[index])
}

export function computeHistoryWorkingSet(input: HistoryWorkingSetInput): HistoryWorkingSet {
  const ids = input.clusters.map((cluster) => cluster.clusterId)
  const anchorClusterId = findClusterIdBySession(input.clusters, input.anchorSessionId)
  const targetClusterId = findClusterIdBySession(input.clusters, input.targetSessionId)
  const centerClusterId = targetClusterId ?? anchorClusterId
  const centerIndex = centerClusterId ? ids.indexOf(centerClusterId) : -1
  const hot = new Set<string>()

  ids.slice(Math.max(0, ids.length - 5)).forEach((id) => hot.add(id))
  if (input.realtimeClusterIds) {
    for (const id of input.realtimeClusterIds) {
      if (ids.includes(id)) hot.add(id)
    }
  }
  addRange(hot, ids, centerIndex, 2)
  if (targetClusterId) hot.add(targetClusterId)

  const warmCandidates = new Set<string>()
  addRange(warmCandidates, ids, centerIndex, 4)
  const warm = new Set(Array.from(warmCandidates).filter((id) => !hot.has(id)))
  const cold = new Set(ids.filter((id) => !hot.has(id) && !warm.has(id)))

  const warmPriority = Array.from(warm).sort((a, b) => {
    const ai = ids.indexOf(a)
    const bi = ids.indexOf(b)
    if (input.direction === 'left') return ai - bi
    if (input.direction === 'right') return bi - ai
    return Math.abs(ai - centerIndex) - Math.abs(bi - centerIndex) || ai - bi
  })

  return { anchorClusterId, targetClusterId, hot, warm, cold, warmPriority }
}
