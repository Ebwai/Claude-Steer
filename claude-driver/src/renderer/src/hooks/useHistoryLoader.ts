// 使用方法：const history = useHistoryLoader(projectId)
// 编译说明：renderer 进程 browser bundle
// 代码说明：最近 1 个完整 Cluster 首屏 + 更早目录壳后台续扫 + 单 Cluster 可取消紧凑投影

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import type {
  HistoryCatalogBatch,
  HistoryDetailsResult,
  HistoryOpenResult,
  HistorySessionSealResult,
} from '@shared/types/history'
import { projectByIdAtom } from '../atoms/projects.atom'
import { historyHandoffPendingAtom, historyProjectsAtom } from '../atoms/history.atom'
import { focusedSessionIdAtom, viewportModeAtom } from '../atoms/viewport.atom'
import {
  appendCatalogBatch,
  beginHydration,
  cancelHydration,
  commitClusterProjection,
  commitSealedSession,
  failHydration,
  openHistoryProject,
  releaseClusterProjections,
} from '../capabilities/historyCapability'
import { releaseProjectRuntime, releaseSessionRuntime } from '../capabilities/runtimeResourceCapability'

const CATALOG_BATCH_CLUSTERS = 24

function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 800 })
    } else {
      globalThis.setTimeout(resolve, 0)
    }
  })
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => resolve())
    else globalThis.setTimeout(resolve, 0)
  })
}

interface DetailRequestRef {
  detailRequestId: string
  requestId: string
  projectId: string
  generation: string
  clusterId: string
  priority: 'hot' | 'warm'
  interactionEpoch: number
}

export interface HistoryLoaderControl {
  hydrateClusters: (clusterIds: string[], priority?: 'hot' | 'warm') => Promise<void>
  releaseClusters: (clusterIds: string[]) => void
  setInteractionBlocked: (blocked: boolean) => void
  cancelDetailRequests: (clusterIds?: Iterable<string>) => void
}

export function useHistoryLoader(projectId: string | null): HistoryLoaderControl {
  const store = useStore()
  const historyProjects = useAtomValue(historyProjectsAtom)
  const handoffPendingByProject = useAtomValue(historyHandoffPendingAtom)
  const historyReady = Boolean(projectId && historyProjects.get(projectId))
  const handoffKey = projectId
    ? [...(handoffPendingByProject.get(projectId) ?? [])].sort().join(',')
    : ''
  const mountedRequestRef = useRef<{ projectId: string; requestId: string } | null>(null)
  const interactionBlockedRef = useRef(false)
  const interactionEpochRef = useRef(0)
  const detailRequestsRef = useRef<Map<string, DetailRequestRef>>(new Map())
  const pendingCatalogBatchRef = useRef<HistoryCatalogBatch | null>(null)
  const interactionIdleWaitersRef = useRef<Set<() => void>>(new Set())

  const cancelDetailRequests = useCallback((clusterIds?: Iterable<string>): void => {
    const filter = clusterIds ? new Set(clusterIds) : null
    for (const detail of [...detailRequestsRef.current.values()]) {
      if (filter && !filter.has(detail.clusterId)) continue
      detailRequestsRef.current.delete(detail.detailRequestId)
      cancelHydration(store, detail.projectId, detail.generation, detail.clusterId)
      void window.api.invoke(IPC.HISTORY_DETAILS_CANCEL, { detailRequestId: detail.detailRequestId })
        .catch((error: unknown) => console.warn(
          `[HistoryLoader] detail cancel failed detail=${detail.detailRequestId}:`,
          error,
        ))
    }
  }, [store])

  const setInteractionBlocked = useCallback((blocked: boolean): void => {
    if (interactionBlockedRef.current === blocked) return
    interactionBlockedRef.current = blocked
    interactionEpochRef.current += 1
    if (blocked) {
      cancelDetailRequests()
    } else {
      for (const resolve of interactionIdleWaitersRef.current) resolve()
      interactionIdleWaitersRef.current.clear()
    }
    console.debug(
      `[HistoryLoader] interaction gate=${blocked ? 'blocked' : 'open'} epoch=${interactionEpochRef.current} details=${detailRequestsRef.current.size}`,
    )
  }, [cancelDetailRequests])

  useEffect(() => {
    if (!projectId) return
    const project = store.get(projectByIdAtom(projectId))
    if (!project) return
    let active = true
    const requestId = crypto.randomUUID()
    mountedRequestRef.current = { projectId, requestId }
    pendingCatalogBatchRef.current = null
    interactionBlockedRef.current = false
    interactionEpochRef.current += 1

    const waitForInteractionIdle = async (): Promise<void> => {
      if (!interactionBlockedRef.current) return
      await new Promise<void>((resolve) => interactionIdleWaitersRef.current.add(resolve))
    }

    console.info(`[HistoryLoader] open project=${projectId} request=${requestId}`)
    void window.api.invoke(IPC.GIT_ENSURE_REPO, { projectPath: project.path })
      .catch((error: unknown) => console.warn('[HistoryLoader] git:ensure-repo failed:', error))

    const load = async (): Promise<void> => {
      const result = await window.api.invoke(IPC.HISTORY_OPEN_PROJECT, {
        projectId,
        projectPath: project.path,
        requestId,
      }) as HistoryOpenResult
      if (!active || mountedRequestRef.current?.requestId !== requestId) return
      if (!result.ok) {
        if (result.errorCode !== 'HISTORY_CANCELLED') {
          console.error(`[HistoryLoader] open failed code=${result.errorCode}: ${result.error}`)
        }
        return
      }

      openHistoryProject(store, projectId, project.path, result)
      if (result.latestCluster) {
        store.set(focusedSessionIdAtom, result.latestCluster.rootSessionId)
        store.set(viewportModeAtom, 'focus')
      }
      console.info(`[HistoryLoader] first cluster ready project=${projectId} totalClusters=${result.totalClusters}`)

      while (active && mountedRequestRef.current?.requestId === requestId) {
        if (!store.get(historyProjectsAtom).get(projectId)?.continuation) break
        await waitForIdle()
        if (!active) break
        const state = store.get(historyProjectsAtom).get(projectId)
        if (!state?.continuation || state.requestId !== requestId) break
        const batch = await window.api.invoke(IPC.HISTORY_CATALOG_CONTINUE, {
          projectId,
          projectPath: project.path,
          requestId,
          continuation: state.continuation,
          limit: CATALOG_BATCH_CLUSTERS,
        }) as HistoryCatalogBatch
        if (!active) break
        if (!batch.ok) {
          if (batch.errorCode !== 'HISTORY_CANCELLED') {
            console.warn(`[HistoryLoader] catalog continue stopped code=${batch.errorCode}: ${batch.error}`)
          }
          break
        }
        if (interactionBlockedRef.current) {
          // 动画期最多保留一个轻量目录 batch；正文投影从不缓冲。
          pendingCatalogBatchRef.current = batch
          while (active && interactionBlockedRef.current) await waitForInteractionIdle()
          if (!active) break
          if (pendingCatalogBatchRef.current === batch) pendingCatalogBatchRef.current = null
        }
        appendCatalogBatch(store, projectId, batch)
        console.debug(`[HistoryLoader] catalog batch=${batch.clusters.length} hasMore=${batch.continuation !== null}`)
      }
    }
    void load().catch((error: unknown) => console.error('[HistoryLoader] open task failed:', error))

    return () => {
      active = false
      const activeRequest = mountedRequestRef.current?.projectId === projectId
        ? mountedRequestRef.current
        : { projectId, requestId }
      if (mountedRequestRef.current?.projectId === projectId) mountedRequestRef.current = null
      pendingCatalogBatchRef.current = null
      for (const resolve of interactionIdleWaitersRef.current) resolve()
      interactionIdleWaitersRef.current.clear()
      cancelDetailRequests()
      interactionBlockedRef.current = false
      void window.api.invoke(IPC.HISTORY_REQUEST_CANCEL, { requestId: activeRequest.requestId })
        .catch((error: unknown) => console.warn('[HistoryLoader] cancel failed:', error))
      // 统一释放历史正文之外的 frame height、atomFamily 与实时运行态缓存。
      // running/paused Session 的注册表和 PTY 可见性会保留，重进项目后由 JSONL 全量补读恢复正文。
      releaseProjectRuntime(store, projectId, { reason: 'history-loader-unmount' })
      void window.api.invoke(IPC.RUNTIME_RESOURCE_SNAPSHOT, {
        reason: `project-unmount:${projectId}`,
      }).catch((error: unknown) => console.warn('[HistoryLoader] resource snapshot failed:', error))
    }
  }, [cancelDetailRequests, projectId, store])

  // 已结束实时 Session 的紧凑历史交接。独立于项目 mount effect，避免为刷新目录先清空画布。
  useEffect(() => {
    if (!projectId || !historyReady || !handoffKey) return
    const project = store.get(projectByIdAtom(projectId))
    const state = store.get(historyProjectsAtom).get(projectId)
    if (!project || !state) return
    const pendingIds = new Set(handoffKey.split(',').filter(Boolean))
    const targetSessionId = [...pendingIds][0]
    if (!targetSessionId) return

    let active = true
    let committed = false
    const requestId = crypto.randomUUID()
    console.info(
      `[HistoryLoader] seal start project=${projectId} session=${targetSessionId.slice(0, 8)} request=${requestId}`,
    )

    const seal = async (): Promise<void> => {
      const result = await window.api.invoke(IPC.HISTORY_SESSION_SEAL, {
        projectId,
        projectPath: project.path,
        sessionId: targetSessionId,
        requestId,
        knownClusterIds: state.clusters.map((cluster) => cluster.clusterId),
        continuation: state.continuation,
      }) as HistorySessionSealResult
      if (!active) return
      if (!result.ok) {
        if (result.errorCode !== 'HISTORY_CANCELLED') {
          console.warn(
            `[HistoryLoader] seal failed project=${projectId} session=${targetSessionId.slice(0, 8)} code=${result.errorCode}: ${result.error}`,
          )
        }
        return
      }
      cancelDetailRequests()
      if (!commitSealedSession(store, projectId, result)) return
      committed = true
      mountedRequestRef.current = { projectId, requestId: result.requestId }

      const sealedIds = new Set(result.projection.sessions.map((session) => session.sessionId))
      for (const sessionId of pendingIds) {
        if (!sealedIds.has(sessionId)) continue
        releaseSessionRuntime(store, sessionId, { mode: 'handoff', reason: 'history-seal-commit' })
      }

      // seal 替换了 main snapshot/request；继续沿同一个内部游标补齐更早目录壳。
      while (active && mountedRequestRef.current?.requestId === result.requestId) {
        const current = store.get(historyProjectsAtom).get(projectId)
        if (!current?.continuation) break
        await waitForIdle()
        if (!active || mountedRequestRef.current?.requestId !== result.requestId) break
        const batch = await window.api.invoke(IPC.HISTORY_CATALOG_CONTINUE, {
          projectId,
          projectPath: project.path,
          requestId: result.requestId,
          continuation: current.continuation,
          limit: CATALOG_BATCH_CLUSTERS,
        }) as HistoryCatalogBatch
        if (!active || !batch.ok) break
        appendCatalogBatch(store, projectId, batch)
      }

      store.set(historyHandoffPendingAtom, (prev) => {
        const current = prev.get(projectId)
        if (!current) return prev
        const remaining = new Set(current)
        sealedIds.forEach((sessionId) => remaining.delete(sessionId))
        const next = new Map(prev)
        if (remaining.size > 0) next.set(projectId, remaining)
        else next.delete(projectId)
        return next
      })
      console.info(
        `[HistoryLoader] seal complete project=${projectId} cluster=${result.cluster.clusterId.slice(0, 8)} sessions=${result.projection.sessions.length}`,
      )
    }
    void seal().catch((error: unknown) => {
      console.error('[HistoryLoader] seal task failed:', error)
    })

    return () => {
      active = false
      if (!committed) {
        void window.api.invoke(IPC.HISTORY_REQUEST_CANCEL, { requestId })
          .catch((error: unknown) => console.warn('[HistoryLoader] seal cancel failed:', error))
      }
    }
  }, [cancelDetailRequests, handoffKey, historyReady, projectId, store])

  const hydrateClusters = useCallback(async (
    clusterIds: string[],
    priority: 'hot' | 'warm' = 'hot',
  ): Promise<void> => {
    if (!projectId || clusterIds.length === 0 || interactionBlockedRef.current) return
    const project = store.get(projectByIdAtom(projectId))
    if (!project) return

    for (const clusterId of [...new Set(clusterIds)]) {
      if (interactionBlockedRef.current) break
      const state = store.get(historyProjectsAtom).get(projectId)
      if (!state || !beginHydration(store, projectId, state.generation, clusterId)) continue
      const detailRequestId = crypto.randomUUID()
      const detail: DetailRequestRef = {
        detailRequestId,
        requestId: state.requestId,
        projectId,
        generation: state.generation,
        clusterId,
        priority,
        interactionEpoch: interactionEpochRef.current,
      }
      detailRequestsRef.current.set(detailRequestId, detail)
      console.info(
        `[HistoryLoader] hydrate start request=${state.requestId} detail=${detailRequestId} priority=${priority} cluster=${clusterId.slice(0, 8)} epoch=${detail.interactionEpoch}`,
      )

      try {
        const result = await window.api.invoke(IPC.HISTORY_DETAILS_LOAD, {
          projectId,
          projectPath: project.path,
          requestId: state.requestId,
          detailRequestId,
          generation: state.generation,
          clusterId,
        }) as HistoryDetailsResult
        if (
          detailRequestsRef.current.get(detailRequestId) !== detail
          || interactionBlockedRef.current
          || interactionEpochRef.current !== detail.interactionEpoch
        ) {
          console.debug(`[HistoryLoader] hydrate late result discarded detail=${detailRequestId}`)
          continue
        }
        detailRequestsRef.current.delete(detailRequestId)
        if (!result.ok) {
          if (result.errorCode === 'HISTORY_CANCELLED') {
            cancelHydration(store, projectId, state.generation, clusterId)
          } else {
            failHydration(store, projectId, state.generation, clusterId, result.error)
          }
          continue
        }
        if (
          result.requestId !== detail.requestId
          || result.detailRequestId !== detailRequestId
          || result.generation !== detail.generation
          || result.projection.clusterId !== clusterId
        ) {
          cancelHydration(store, projectId, state.generation, clusterId)
          console.warn(`[HistoryLoader] hydrate identity mismatch detail=${detailRequestId}`)
          continue
        }
        const committed = commitClusterProjection(
          store,
          projectId,
          result.requestId,
          result.generation,
          result.projection,
        )
        if (!committed) cancelHydration(store, projectId, state.generation, clusterId)
        await nextAnimationFrame()
      } catch (error) {
        if (detailRequestsRef.current.get(detailRequestId) === detail) {
          detailRequestsRef.current.delete(detailRequestId)
          if (!interactionBlockedRef.current) {
            failHydration(store, projectId, state.generation, clusterId, String(error))
          }
        }
      } finally {
        if (detailRequestsRef.current.get(detailRequestId) === detail) {
          detailRequestsRef.current.delete(detailRequestId)
        }
      }
    }
  }, [projectId, store])

  const releaseClusters = useCallback((clusterIds: string[]): void => {
    if (!projectId || clusterIds.length === 0 || interactionBlockedRef.current) return
    console.info(`[HistoryLoader] release clusters=${clusterIds.length}`)
    releaseClusterProjections(store, projectId, clusterIds)
  }, [projectId, store])

  return useMemo(() => ({
    hydrateClusters,
    releaseClusters,
    setInteractionBlocked,
    cancelDetailRequests,
  }), [hydrateClusters, releaseClusters, setInteractionBlocked, cancelDetailRequests])
}
