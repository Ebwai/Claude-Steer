// 使用方法：useHistoryLoader 将 HISTORY_* 成功结果提交到这些原子事务
// 编译说明：renderer 进程 browser bundle；接受注入 store，便于 node 环境单测
// 代码说明：历史目录/紧凑投影/删除的唯一状态写入口；renderer 不保留原始详情副本

import type {
  HistoryCatalogBatch,
  HistoryCatalogEntry,
  HistoryClusterProjection,
  HistoryClusterSummary,
  HistoryDeleteInput,
  HistoryDeleteResult,
  HistoryOpenResult,
  HistorySessionSealResult,
  HistoryTimelineNode,
} from '@shared/types/history'
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import {
  historyDeleteStatesAtom,
  historyResidentManifestAtom,
  historyProjectsAtom,
  type HistoryResidentManifest,
} from '@renderer/atoms/history.atom'
import { sessionRelationsAtom, branchCountAtom, type SessionRelation } from '@renderer/atoms/branch.atom'
import { allFrameHeightsAtom, nodeYOffsetsAtom, subagentIdsAtom } from '@renderer/atoms/agent-block.atom'
import {
  cursorNodeIndexAtom,
  lineInsertionsBySessionAtom,
  scrubberIndexAtom,
  subagentTimelineAtom,
  timelineBySessionAtom,
} from '@renderer/atoms/timeline.atom'
import { milestonesByProjectAtom } from '@renderer/atoms/projects.atom'
import { tokenInventoryAtom } from '@renderer/atoms/token-inventory.atom'
import { replayGitMarks } from './gitCapability'
import { FRAME_GAP_X, FRAME_WIDTH } from '../hooks/useSessionFrameLayout'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

/** 摘要行数：与 useDetailDisclosure.SUMMARY_LINES 保持一致 */
const SUMMARY_LINES = 4

/**
 * 对投影中的 TimelineNode 执行 L1 摘要截断。
 * 被截断的节点：text 截断为 SUMMARY_LINES 行，保留 detailRef（全文通过 detailCapability 按需获取）。
 * 未截断的节点：保持原文，移除 detailRef（不需要按需加载）。
 * 无 detailRef 的节点：保持原文（向后兼容旧投影）。
 * 返回新的节点数组（不修改原始 projection）。
 */
function truncateProjectionText(nodes: HistoryTimelineNode[]): HistoryTimelineNode[] {
  let truncated = false
  const result = nodes.map((node) => {
    if (!node.detailRef || node.text === undefined) return node
    const lines = node.text.split('\n')
    if (lines.length <= SUMMARY_LINES) {
      // 短文本不需要 detailRef，清除以避免显示多余的展开按钮
      const { detailRef: _, ...rest } = node
      truncated = true
      return rest as HistoryTimelineNode
    }
    truncated = true
    return { ...node, text: lines.slice(0, SUMMARY_LINES).join('\n'), textTruncated: true }
  })
  if (truncated) {
    const before = nodes.reduce((s, n) => s + (n.text?.length ?? 0), 0)
    const after = result.reduce((s, n) => s + (n.text?.length ?? 0), 0)
    console.info(`[HistoryCapability] truncated projection text ${before} -> ${after} chars`)
  }
  return truncated ? result : nodes
}

function sortedClusters<T extends { startedAt: number; clusterId: string }>(clusters: T[]): T[] {
  return [...clusters].sort((a, b) => a.startedAt - b.startedAt || a.clusterId.localeCompare(b.clusterId))
}

function rebuildClusters(entries: HistoryCatalogEntry[]): HistoryClusterSummary[] {
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]))
  const groups = new Map<string, { sessions: HistoryCatalogEntry[]; orphaned: boolean }>()
  for (const entry of entries) {
    let cursor = entry
    let orphaned = false
    const visited = new Set([entry.sessionId])
    while (cursor.parentSessionId) {
      const parent = byId.get(cursor.parentSessionId)
      if (!parent) {
        orphaned = true
        break
      }
      if (visited.has(parent.sessionId)) {
        orphaned = true
        cursor = entry
        break
      }
      visited.add(parent.sessionId)
      cursor = parent
    }
    const rootId = cursor.sessionId
    const group = groups.get(rootId) ?? { sessions: [], orphaned }
    group.orphaned ||= orphaned
    group.sessions.push({ ...entry, clusterId: rootId })
    groups.set(rootId, group)
  }
  return sortedClusters(Array.from(groups, ([clusterId, group]) => {
    group.sessions.sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))
    const root = byId.get(clusterId) ?? group.sessions[0]
    return {
      clusterId,
      rootSessionId: clusterId,
      sessions: group.sessions,
      startedAt: root.startedAt,
      endedAt: Math.max(...group.sessions.map((entry) => entry.endedAt)),
      isOrphaned: group.orphaned,
    }
  }))
}

function allHistorySessionIds(store: Store): Set<string> {
  const ids = new Set<string>()
  for (const project of store.get(historyProjectsAtom).values()) {
    for (const cluster of project.clusters) {
      cluster.sessions.forEach((entry) => ids.add(entry.sessionId))
    }
  }
  return ids
}

/** 根据当前剩余目录事实从零重建历史 Branch 关系，保留实时关系。 */
export function rebuildHistoryRelations(store: Store): void {
  const historyIds = allHistorySessionIds(store)
  const realtimeIds = new Set(
    Array.from(store.get(activeSessionsAtom), ([mapId, session]) => ({
      id: session.claudeId ?? mapId,
      status: session.status,
    }))
      .filter(({ status }) => status === 'Running' || status === 'Paused')
      .map(({ id }) => id),
  )
  const nextRelations = new Map<string, SessionRelation>()
  for (const [childId, relation] of store.get(sessionRelationsAtom)) {
    if (realtimeIds.has(childId) || !historyIds.has(childId)) nextRelations.set(childId, relation)
  }
  const branchCounts = new Map(store.get(branchCountAtom))
  for (const id of historyIds) {
    if (!realtimeIds.has(id)) branchCounts.delete(id)
  }
  const manifests = store.get(historyResidentManifestAtom)

  for (const project of store.get(historyProjectsAtom).values()) {
    for (const cluster of project.clusters) {
      const clusterIds = new Set(cluster.sessions.map((entry) => entry.sessionId))
      const childrenByParent = new Map<string, typeof cluster.sessions>()
      for (const entry of cluster.sessions) {
        if (!entry.parentSessionId || !clusterIds.has(entry.parentSessionId)) continue
        const children = childrenByParent.get(entry.parentSessionId) ?? []
        children.push(entry)
        childrenByParent.set(entry.parentSessionId, children)
      }
      for (const [parentId, children] of childrenByParent) {
        children.sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))
        children.forEach((child, index) => {
          if (realtimeIds.has(child.sessionId)) return
          const branchIndex = index + 1
          const side = branchIndex % 2 === 1 ? 'right' : 'left'
          const sameDirectionIndex = Math.ceil(branchIndex / 2)
          const parentInsertions = store.get(lineInsertionsBySessionAtom(parentId))
          const branchInsertion = parentInsertions.find((item) => item.id === `${parentId}-branch-${child.sessionId}`)
          nextRelations.set(child.sessionId, {
            type: 'branch',
            parentSessionId: parentId,
            triggerNodeIndex: manifests.get(cluster.clusterId)?.triggerNodeIndexBySession.get(child.sessionId) ?? 0,
            side,
            branchIndex,
            lineLength: FRAME_GAP_X + (sameDirectionIndex - 1) * (FRAME_WIDTH + FRAME_GAP_X),
            inheritedNodeCount: 0,
            triggerYOffset: branchInsertion?.triggerYOffset,
          })
        })
        branchCounts.set(parentId, children.length)
      }
    }
  }
  store.set(sessionRelationsAtom, nextRelations)
  store.set(branchCountAtom, branchCounts)
}

export function openHistoryProject(
  store: Store,
  projectId: string,
  projectPath: string,
  result: HistoryOpenResult,
): void {
  if (!result.ok) return
  const old = store.get(historyProjectsAtom).get(projectId)
  if (old) releaseClusterProjections(store, projectId, old.clusters.map((cluster) => cluster.clusterId))

  const clusters = result.latestCluster ? [result.latestCluster] : []
  const detailsStateByCluster = new Map<string, 'resident' | 'shell'>()
  if (result.latestCluster) {
    detailsStateByCluster.set(result.latestCluster.clusterId, result.latestProjection ? 'resident' : 'shell')
  }
  store.set(historyProjectsAtom, (prev) => new Map(prev).set(projectId, {
    projectId,
    projectPath,
    requestId: result.requestId,
    generation: result.generation,
    clusters,
    continuation: result.continuation,
    totalClusters: result.totalClusters,
    catalogLoading: result.continuation !== null,
    detailsStateByCluster,
    error: null,
  }))
  if (result.latestProjection) {
    commitClusterProjection(store, projectId, result.requestId, result.generation, result.latestProjection)
  }
  rebuildHistoryRelations(store)
}

/** 把 main 刚生成的终止 Session projection 接入现有无限目录，不清空其他历史壳。 */
export function commitSealedSession(
  store: Store,
  projectId: string,
  result: Extract<HistorySessionSealResult, { ok: true }>,
): boolean {
  const current = store.get(historyProjectsAtom).get(projectId)
  if (!current) return false
  const clusters = sortedClusters([
    ...current.clusters.filter((cluster) => cluster.clusterId !== result.cluster.clusterId),
    result.cluster,
  ])
  const detailsStateByCluster = new Map(current.detailsStateByCluster)
  detailsStateByCluster.set(result.cluster.clusterId, 'hydrating')
  store.set(historyProjectsAtom, (prev) => new Map(prev).set(projectId, {
    ...current,
    requestId: result.requestId,
    generation: result.generation,
    clusters,
    continuation: result.continuation,
    totalClusters: result.totalClusters,
    catalogLoading: result.continuation !== null,
    detailsStateByCluster,
    error: null,
  }))
  store.set(historyResidentManifestAtom, (prev) => new Map(
    Array.from(prev, ([clusterId, manifest]) => [clusterId, {
      ...manifest,
      generation: result.generation,
    }]),
  ))
  const committed = commitClusterProjection(
    store,
    projectId,
    result.requestId,
    result.generation,
    result.projection,
  )
  console.info(
    `[HistoryCapability] session seal ${committed ? 'committed' : 'rejected'} cluster=${result.cluster.clusterId.slice(0, 8)} generation=${result.generation}`,
  )
  return committed
}

export function appendCatalogBatch(store: Store, projectId: string, batch: HistoryCatalogBatch): void {
  if (!batch.ok) return
  store.set(historyProjectsAtom, (prev) => {
    const current = prev.get(projectId)
    if (!current || current.generation !== batch.generation || current.requestId !== batch.requestId) return prev
    const byId = new Map(current.clusters.map((cluster) => [cluster.clusterId, cluster]))
    batch.clusters.forEach((cluster) => byId.set(cluster.clusterId, cluster))
    const detailsState = new Map(current.detailsStateByCluster)
    batch.clusters.forEach((cluster) => {
      if (!detailsState.has(cluster.clusterId)) detailsState.set(cluster.clusterId, 'shell')
    })
    return new Map(prev).set(projectId, {
      ...current,
      clusters: sortedClusters([...byId.values()]),
      continuation: batch.continuation,
      catalogLoading: batch.continuation !== null,
      detailsStateByCluster: detailsState,
    })
  })
  rebuildHistoryRelations(store)
}

export function beginHydration(store: Store, projectId: string, generation: string, clusterId: string): boolean {
  let accepted = false
  store.set(historyProjectsAtom, (prev) => {
    const current = prev.get(projectId)
    if (!current || current.generation !== generation) return prev
    const state = current.detailsStateByCluster.get(clusterId)
    if (state === 'resident' || state === 'hydrating' || !current.clusters.some((item) => item.clusterId === clusterId)) {
      return prev
    }
    const states = new Map(current.detailsStateByCluster)
    states.set(clusterId, 'hydrating')
    accepted = true
    return new Map(prev).set(projectId, { ...current, detailsStateByCluster: states })
  })
  return accepted
}

export function cancelHydration(store: Store, projectId: string, generation: string, clusterId: string): void {
  store.set(historyProjectsAtom, (prev) => {
    const current = prev.get(projectId)
    if (!current || current.generation !== generation || current.detailsStateByCluster.get(clusterId) !== 'hydrating') {
      return prev
    }
    const states = new Map(current.detailsStateByCluster)
    states.set(clusterId, 'shell')
    return new Map(prev).set(projectId, { ...current, detailsStateByCluster: states })
  })
}

function sameSessionSet(cluster: HistoryClusterSummary, projection: HistoryClusterProjection): boolean {
  const expected = new Set(cluster.sessions.map((entry) => entry.sessionId))
  const actual = new Set(projection.sessions.map((entry) => entry.sessionId))
  return expected.size === actual.size
    && actual.size === projection.sessions.length
    && Array.from(expected).every((sessionId) => actual.has(sessionId))
}

function clearResidentContent(store: Store, projectId: string, manifest: HistoryResidentManifest): void {
  for (const sessionId of manifest.sessionIds) {
    store.set(timelineBySessionAtom(sessionId), [])
    store.set(lineInsertionsBySessionAtom(sessionId), [])
    for (const agentId of manifest.subagentIdsBySession.get(sessionId) ?? []) {
      store.set(subagentTimelineAtom(`${sessionId}::${agentId}`), [])
      subagentTimelineAtom.remove(`${sessionId}::${agentId}`)
    }
    store.set(subagentIdsAtom(sessionId), [])
    store.set(nodeYOffsetsAtom(sessionId), [])
    store.set(cursorNodeIndexAtom(sessionId), -1)
    store.set(scrubberIndexAtom(sessionId), -1)
    timelineBySessionAtom.remove(sessionId)
    lineInsertionsBySessionAtom.remove(sessionId)
    subagentIdsAtom.remove(sessionId)
    nodeYOffsetsAtom.remove(sessionId)
    cursorNodeIndexAtom.remove(sessionId)
    scrubberIndexAtom.remove(sessionId)
  }
  const sessionIds = new Set(manifest.sessionIds)
  store.set(milestonesByProjectAtom(projectId), (prev) => prev.filter((item) => !sessionIds.has(item.sessionId)))
}

export function commitClusterProjection(
  store: Store,
  projectId: string,
  requestId: string,
  generation: string,
  projection: HistoryClusterProjection,
): boolean {
  const project = store.get(historyProjectsAtom).get(projectId)
  const cluster = project?.clusters.find((item) => item.clusterId === projection.clusterId)
  if (
    !project
    || project.requestId !== requestId
    || project.generation !== generation
    || !cluster
    || !sameSessionSet(cluster, projection)
  ) {
    console.warn(
      `[HistoryCapability] projection rejected project=${projectId} cluster=${projection.clusterId.slice(0, 8)} requestMatch=${project?.requestId === requestId} generationMatch=${project?.generation === generation} sessionSetMatch=${!!cluster && sameSessionSet(cluster, projection)}`,
    )
    return false
  }

  const existing = store.get(historyResidentManifestAtom).get(projection.clusterId)
  if (existing) clearResidentContent(store, projectId, existing)
  const subagentIdsBySession = new Map<string, string[]>()
  const triggerNodeIndexBySession = new Map<string, number | null>()
  const frozenHeightBySession = new Map<string, number>()
  const frameHeights = store.get(allFrameHeightsAtom)

  for (const session of projection.sessions) {
    // 数组所有权直接转移到 keyed atoms；不再创建 HistoryClusterDetails/JsonlRecord[] 双份。
    // L1 摘要截断：有 detailRef 的节点只保留 4 行摘要，全文通过 detailCapability 按需获取。
    store.set(timelineBySessionAtom(session.sessionId), truncateProjectionText(session.timeline))
    store.set(lineInsertionsBySessionAtom(session.sessionId), session.insertions)
    const agentIds = session.subagents.map((item) => item.agentId)
    subagentIdsBySession.set(session.sessionId, agentIds)
    triggerNodeIndexBySession.set(session.sessionId, session.triggerNodeIndex)
    frozenHeightBySession.set(session.sessionId, frameHeights.get(session.sessionId) ?? 400)
    store.set(subagentIdsAtom(session.sessionId), agentIds)
    for (const subagent of session.subagents) {
      store.set(subagentTimelineAtom(`${session.sessionId}::${subagent.agentId}`), truncateProjectionText(subagent.timeline))
    }
    store.set(milestonesByProjectAtom(projectId), (prev) => [
      ...prev.filter((item) => item.sessionId !== session.sessionId),
      ...session.milestones,
    ])
    replayGitMarks(store, session.sessionId, session.gitMarks)
  }

  const manifest: HistoryResidentManifest = {
    generation,
    clusterId: projection.clusterId,
    sessionIds: projection.sessions.map((item) => item.sessionId),
    subagentIdsBySession,
    triggerNodeIndexBySession,
    frozenHeightBySession,
  }
  store.set(historyResidentManifestAtom, (prev) => new Map(prev).set(projection.clusterId, manifest))
  store.set(historyProjectsAtom, (prev) => {
    const current = prev.get(projectId)
    if (!current || current.requestId !== requestId || current.generation !== generation) return prev
    const states = new Map(current.detailsStateByCluster)
    states.set(projection.clusterId, 'resident')
    return new Map(prev).set(projectId, { ...current, detailsStateByCluster: states })
  })
  rebuildHistoryRelations(store)
  console.info(
    `[HistoryCapability] projection committed cluster=${projection.clusterId.slice(0, 8)} sessions=${projection.sessions.length}`,
  )
  return true
}

export function failHydration(
  store: Store,
  projectId: string,
  generation: string,
  clusterId: string,
  error: string,
): void {
  store.set(historyProjectsAtom, (prev) => {
    const current = prev.get(projectId)
    if (!current || current.generation !== generation) return prev
    const states = new Map(current.detailsStateByCluster)
    states.set(clusterId, 'error')
    return new Map(prev).set(projectId, { ...current, detailsStateByCluster: states, error })
  })
}

export function releaseClusterProjections(store: Store, projectId: string, clusterIds: string[]): void {
  const manifests = store.get(historyResidentManifestAtom)
  for (const clusterId of clusterIds) {
    const manifest = manifests.get(clusterId)
    if (manifest) clearResidentContent(store, projectId, manifest)
  }
  store.set(historyResidentManifestAtom, (prev) => {
    const next = new Map(prev)
    clusterIds.forEach((clusterId) => next.delete(clusterId))
    return next
  })
  store.set(historyProjectsAtom, (prev) => {
    const current = prev.get(projectId)
    if (!current) return prev
    const states = new Map(current.detailsStateByCluster)
    clusterIds.forEach((clusterId) => {
      if (states.has(clusterId)) states.set(clusterId, 'shell')
    })
    return new Map(prev).set(projectId, { ...current, detailsStateByCluster: states })
  })
}

export function beginHistoryDelete(store: Store, input: HistoryDeleteInput): void {
  store.set(historyDeleteStatesAtom, (prev) => new Map(prev).set(input.targetSessionId, {
    operationId: input.operationId,
    targetSessionId: input.targetSessionId,
    scope: input.scope,
    status: 'deleting',
  }))
}

export function failHistoryDelete(
  store: Store,
  input: HistoryDeleteInput,
  result: Extract<HistoryDeleteResult, { ok: false }>,
): void {
  store.set(historyDeleteStatesAtom, (prev) => new Map(prev).set(input.targetSessionId, {
    operationId: input.operationId,
    targetSessionId: input.targetSessionId,
    scope: input.scope,
    status: 'failed',
    errorCode: result.errorCode,
    error: result.error,
  }))
}

export interface HistoryDeleteCommitOutcome {
  focusWasDeleted: boolean
  focusFallbackSessionId: string | null
  invalidatedClusterIds: string[]
}

function resolveDeleteFocusFallback(
  clusters: HistoryClusterSummary[],
  deleted: Set<string>,
  focusedSessionId: string | null,
): string | null {
  if (!focusedSessionId || !deleted.has(focusedSessionId)) return focusedSessionId
  const entries = clusters.flatMap((cluster) => cluster.sessions)
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]))
  let parentId = byId.get(focusedSessionId)?.parentSessionId ?? null
  const visited = new Set<string>()
  while (parentId && !visited.has(parentId)) {
    if (!deleted.has(parentId)) return parentId
    visited.add(parentId)
    parentId = byId.get(parentId)?.parentSessionId ?? null
  }

  const clusterIndex = clusters.findIndex((cluster) =>
    cluster.sessions.some((entry) => entry.sessionId === focusedSessionId),
  )
  for (let index = clusterIndex + 1; index < clusters.length; index++) {
    if (!deleted.has(clusters[index].rootSessionId)) return clusters[index].rootSessionId
  }
  for (let index = clusterIndex - 1; index >= 0; index--) {
    if (!deleted.has(clusters[index].rootSessionId)) return clusters[index].rootSessionId
  }
  return null
}

export function commitHistoryDelete(
  store: Store,
  projectId: string,
  result: Extract<HistoryDeleteResult, { ok: true }>,
  focusedSessionId: string | null,
): HistoryDeleteCommitOutcome {
  const deleted = new Set(result.deletedSessionIds)
  const current = store.get(historyProjectsAtom).get(projectId)
  if (!current) {
    return { focusWasDeleted: false, focusFallbackSessionId: focusedSessionId, invalidatedClusterIds: [] }
  }
  const affectedClusterIds = current.clusters
    .filter((cluster) => cluster.sessions.some((entry) => deleted.has(entry.sessionId)))
    .map((cluster) => cluster.clusterId)
  const affectedSessionIds = new Set(
    current.clusters
      .filter((cluster) => affectedClusterIds.includes(cluster.clusterId))
      .flatMap((cluster) => cluster.sessions.map((entry) => entry.sessionId)),
  )
  const focusWasDeleted = !!focusedSessionId && deleted.has(focusedSessionId)
  const focusFallbackSessionId = resolveDeleteFocusFallback(current.clusters, deleted, focusedSessionId)

  // Branch 删除会改变同一 Cluster 的精确 session 集与触发索引，必须整体失效后由新 generation 重投影。
  releaseClusterProjections(store, projectId, affectedClusterIds)
  store.set(historyProjectsAtom, (prev) => {
    const state = prev.get(projectId)
    if (!state) return prev
    const remainingEntries = state.clusters
      .flatMap((cluster) => cluster.sessions)
      .filter((entry) => !deleted.has(entry.sessionId))
    const clusters = rebuildClusters(remainingEntries)
    const states = new Map<string, 'shell' | 'hydrating' | 'resident' | 'error'>()
    for (const cluster of clusters) {
      const wasAffected = cluster.sessions.some((entry) => affectedSessionIds.has(entry.sessionId))
      states.set(cluster.clusterId, wasAffected ? 'shell' : state.detailsStateByCluster.get(cluster.clusterId) ?? 'shell')
    }
    return new Map(prev).set(projectId, {
      ...state,
      generation: result.generation,
      continuation: result.continuation,
      clusters,
      detailsStateByCluster: states,
    })
  })
  store.set(tokenInventoryAtom, (prev) => {
    const next = new Map(prev)
    deleted.forEach((sessionId) => next.delete(sessionId))
    return next
  })
  store.set(allFrameHeightsAtom, (prev) => {
    const next = new Map(prev)
    deleted.forEach((sessionId) => next.delete(sessionId))
    return next
  })
  store.set(historyDeleteStatesAtom, (prev) => {
    const next = new Map(prev)
    result.deletedSessionIds.forEach((sessionId) => next.delete(sessionId))
    return next
  })
  store.set(activeSessionsAtom, (prev) => {
    const next = new Map(prev)
    for (const sessionId of deleted) {
      const session = next.get(sessionId)
      if (session?.status !== 'Running' && session?.status !== 'Paused') next.delete(sessionId)
    }
    return next
  })
  store.set(sessionRelationsAtom, (prev) => new Map(
    Array.from(prev).filter(([childId, relation]) =>
      !deleted.has(childId) && (!relation.parentSessionId || !deleted.has(relation.parentSessionId)),
    ),
  ))
  store.set(branchCountAtom, (prev) => {
    const next = new Map(prev)
    deleted.forEach((sessionId) => next.delete(sessionId))
    return next
  })
  rebuildHistoryRelations(store)
  console.info(
    `[HistoryCapability] delete committed deleted=${deleted.size} invalidatedClusters=${affectedClusterIds.length} focusFallback=${focusFallbackSessionId?.slice(0, 8) ?? 'none'}`,
  )
  return { focusWasDeleted, focusFallbackSessionId, invalidatedClusterIds: affectedClusterIds }
}

export function clearHistoryProject(store: Store, projectId: string): void {
  const current = store.get(historyProjectsAtom).get(projectId)
  if (!current) return
  releaseClusterProjections(store, projectId, current.clusters.map((cluster) => cluster.clusterId))
  store.set(historyProjectsAtom, (prev) => {
    const next = new Map(prev)
    next.delete(projectId)
    return next
  })
  rebuildHistoryRelations(store)
}

/** 实时 Session 是否覆盖同 id 历史壳。 */
export function isRealtimeSession(store: Store, sessionId: string): boolean {
  const session = store.get(activeSessionsAtom).get(sessionId)
  return session?.status === 'Running' || session?.status === 'Paused'
}
