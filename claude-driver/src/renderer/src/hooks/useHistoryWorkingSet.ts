// 使用方法：ProcessLineCanvas 将历史目录、观看锚点和相机阶段传入以维护详情驻留
// 编译说明：renderer React hook
// 代码说明：热区优先水合、温区空闲预热、交互 gate 和 800ms 冷区迟滞回收

import { useEffect, useMemo } from 'react'
import type { HistoryClusterSummary, HistoryDetailsState } from '@shared/types/history'
import {
  computeHistoryWorkingSet,
  type HistoryInteractionPhase,
  type HistoryNavigationDirection,
  type HistoryWorkingSet,
} from './historyWorkingSet'
import type { HistoryLoaderControl } from './useHistoryLoader'

const COLD_RELEASE_DELAY_MS = 800

interface HistoryWorkingSetInput {
  clusters: HistoryClusterSummary[]
  detailsStateByCluster: ReadonlyMap<string, HistoryDetailsState>
  anchorSessionId: string | null
  targetSessionId: string | null
  realtimeClusterIds: Iterable<string>
  direction: HistoryNavigationDirection
  interactionPhase: HistoryInteractionPhase
  loader: HistoryLoaderControl
}

function scheduleIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 500 })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(callback, 0)
  return () => window.clearTimeout(id)
}

export function useHistoryWorkingSet(input: HistoryWorkingSetInput): HistoryWorkingSet {
  const {
    clusters,
    detailsStateByCluster,
    anchorSessionId,
    targetSessionId,
    realtimeClusterIds,
    direction,
    interactionPhase,
    loader,
  } = input

  const realtimeIds = useMemo(() => Array.from(realtimeClusterIds), [realtimeClusterIds])
  const workingSet = useMemo(() => computeHistoryWorkingSet({
    clusters,
    anchorSessionId,
    targetSessionId,
    realtimeClusterIds: realtimeIds,
    direction,
  }), [clusters, anchorSessionId, targetSessionId, realtimeIds, direction])

  useEffect(() => {
    if (interactionPhase !== 'idle') return
    const target = workingSet.targetClusterId
    const hotToHydrate = Array.from(workingSet.hot).filter((clusterId) => {
      const state = detailsStateByCluster.get(clusterId)
      return clusterId !== target && (state === 'shell' || state === 'error')
    })
    const targetNeedsHydration = !!target && (() => {
      const state = detailsStateByCluster.get(target)
      return state === 'shell' || state === 'error'
    })()

    const warmToHydrate = workingSet.warmPriority.filter((clusterId) => {
      const state = detailsStateByCluster.get(clusterId)
      return state === 'shell' || state === 'error'
    })
    let cancelled = false
    let cancelWarmIdle: (() => void) | null = null
    // 相机已经稳定后才加载正文；严格按 target → hot → warm idle 顺序调度。
    void (async () => {
      if (targetNeedsHydration && target) await loader.hydrateClusters([target], 'hot')
      if (cancelled) return
      if (hotToHydrate.length > 0) await loader.hydrateClusters(hotToHydrate, 'hot')
      if (cancelled || warmToHydrate.length === 0) return
      cancelWarmIdle = scheduleIdle(() => { void loader.hydrateClusters(warmToHydrate, 'warm') })
    })()
    return () => {
      cancelled = true
      cancelWarmIdle?.()
    }
  }, [detailsStateByCluster, interactionPhase, loader, workingSet.hot, workingSet.targetClusterId, workingSet.warmPriority])

  useEffect(() => {
    if (interactionPhase !== 'idle') return
    const coldResident = Array.from(workingSet.cold).filter(
      (clusterId) => detailsStateByCluster.get(clusterId) === 'resident',
    )
    if (coldResident.length === 0) return

    let cancelIdle: (() => void) | null = null
    const timer = window.setTimeout(() => {
      const queue = [...coldResident]
      const releaseNext = (): void => {
        const clusterId = queue.shift()
        if (!clusterId) return
        loader.releaseClusters([clusterId])
        if (queue.length > 0) cancelIdle = scheduleIdle(releaseNext)
      }
      cancelIdle = scheduleIdle(releaseNext)
    }, COLD_RELEASE_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      cancelIdle?.()
    }
  }, [detailsStateByCluster, interactionPhase, loader, workingSet.cold])

  useEffect(() => {
    console.debug(
      `[HistoryWorkingSet] phase=${interactionPhase} anchor=${workingSet.anchorClusterId ?? 'none'} target=${workingSet.targetClusterId ?? 'none'} hot=${workingSet.hot.size} warm=${workingSet.warm.size} cold=${workingSet.cold.size}`,
    )
  }, [interactionPhase, workingSet])

  return workingSet
}
