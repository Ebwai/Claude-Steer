// 使用方法：main/index.ts 创建单例并将 HISTORY_* handlers 委托给本服务
// 编译说明：Electron main / Node.js
// 代码说明：可取消的历史目录、详情、Token 库存与事务删除编排

import { randomUUID } from 'crypto'
import type {
  HistoryCatalogBatch,
  HistoryCatalogContinueInput,
  HistoryContinuation,
  HistoryDeleteInput,
  HistoryDeleteResult,
  HistoryDetailsInput,
  HistoryDetailsResult,
  HistoryErrorCode,
  HistoryOpenInput,
  HistoryOpenResult,
  HistorySessionSealInput,
  HistorySessionSealResult,
  HistoryTokenInventoryInput,
  HistoryTokenInventoryResult,
} from '../../../shared/types/history'
import {
  historyClusterSortKey,
  scanHistoryCatalog,
  type HistoryCatalogSnapshot,
} from './HistoryCatalog'
import { loadHistoryClusterProjection } from './HistoryDetailLoader'
import {
  deleteHistoryTarget,
  recoverHistoryDeleteTransactions,
  type HistoryDeletionDeps,
} from './HistoryDeletion'
import { scanHistoryTokenInventory } from './HistoryTokenInventory'
import { resolveProjectDirectory } from './HistoryPaths'

import type { DetailService } from './DetailService'
import type { HistoryClusterProjection } from '../../../shared/types/history'

interface RequestState {
  requestId: string
  projectKey: string
  controller: AbortController
  snapshot: HistoryCatalogSnapshot
  deliveredClusterIds: Set<string>
}

interface ActiveController {
  controller: AbortController
  projectKey: string
}

interface DetailRequestState {
  detailRequestId: string
  requestId: string
  projectKey: string
  clusterId: string
  generation: string
  snapshot: HistoryCatalogSnapshot
  controller: AbortController
}

export interface HistoryServiceDeps extends HistoryDeletionDeps {
  /** 可选：注入 DetailService 后，历史投影将自动注册 EntityLocator，支持 Renderer 按需获取全文 */
  detailService?: DetailService
}

function projectKey(projectPath: string): string {
  const value = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function failure(error: unknown): { ok: false; errorCode: HistoryErrorCode; error: string } {
  const code = (error as { code?: HistoryErrorCode }).code
  return {
    ok: false,
    errorCode: code ?? 'HISTORY_IO_ERROR',
    error: error instanceof Error ? error.message : String(error),
  }
}

function continuationBefore(
  snapshot: HistoryCatalogSnapshot,
  beforeIndex: number,
): HistoryContinuation | null {
  if (beforeIndex <= 0 || snapshot.clusters.length === 0) return null
  return {
    generation: snapshot.generation,
    beforeSortKey: historyClusterSortKey(snapshot.clusters[beforeIndex]),
  }
}

export class HistoryService {
  private requests = new Map<string, RequestState>()
  private activeControllers = new Map<string, ActiveController>()
  private detailRequests = new Map<string, DetailRequestState>()
  private latestRequestByProject = new Map<string, string>()
  private latestTokenRequestByProject = new Map<string, string>()
  private recoveredDirectories = new Set<string>()
  private deletingProjects = new Set<string>()

  constructor(private readonly deps: HistoryServiceDeps) {}

  /**
   * 为投影中所有有文本的节点注册 EntityLocator 并设置 detailRef。
   * 仅在 detailService 注入时生效。
   */
  private _registerProjectionLocators(
    projection: HistoryClusterProjection,
    byteRangeByNodeId: Map<string, { byteStart: number; byteEndExclusive: number }>,
    generation: string,
    claudeDir: string,
  ): void {
    if (!this.deps.detailService) return
    const ds = this.deps.detailService
    for (const session of projection.sessions) {
      const filePath = `${claudeDir}/${session.sessionId}.jsonl`
      for (const node of session.timeline) {
        if (node.text === undefined) continue
        const byteRange = byteRangeByNodeId.get(node.id)
        if (!byteRange) continue
        const ref = ds.registerEntity(
          node.id,
          { filePath, byteStart: byteRange.byteStart, byteEndExclusive: byteRange.byteEndExclusive, encoding: 'utf-8', lineEnding: 'lf' },
          generation,
          Buffer.byteLength(node.text, 'utf-8'),
        )
        node.detailRef = { detailKey: ref.detailKey, revision: ref.revision, sourceGeneration: ref.sourceGeneration, estimatedSize: ref.estimatedSize }
        console.info(`[HistoryService] entity registered id=${node.id.slice(0, 12)} byte=[${byteRange.byteStart},${byteRange.byteEndExclusive}) file=${session.sessionId.slice(0, 8)}`)
      }
      // Subagent 节点
      for (const sub of session.subagents) {
        const subFilePath = `${claudeDir}/${session.sessionId}/subagents/agent-${sub.agentId}.jsonl`
        for (const node of sub.timeline) {
          if (node.text === undefined) continue
          const byteRange = byteRangeByNodeId.get(node.id)
          if (!byteRange) continue
          const ref = ds.registerEntity(
            node.id,
            { filePath: subFilePath, byteStart: byteRange.byteStart, byteEndExclusive: byteRange.byteEndExclusive, encoding: 'utf-8', lineEnding: 'lf' },
            generation,
            Buffer.byteLength(node.text, 'utf-8'),
          )
          node.detailRef = { detailKey: ref.detailKey, revision: ref.revision, sourceGeneration: ref.sourceGeneration, estimatedSize: ref.estimatedSize }
        }
      }
    }
  }

  async openProject(input: HistoryOpenInput): Promise<HistoryOpenResult> {
    const key = projectKey(input.projectPath)
    if (this.requests.has(input.requestId) || this.activeControllers.has(input.requestId)) {
      this.cancelRequest(input.requestId)
    }
    const previousId = this.latestRequestByProject.get(key)
    if (previousId && previousId !== input.requestId) this.cancelRequest(previousId)
    const controller = new AbortController()
    this.activeControllers.set(input.requestId, { controller, projectKey: key })
    // 必须在磁盘扫描前登记；否则项目快速切换时，新请求看不到仍在扫描的旧请求。
    this.latestRequestByProject.set(key, input.requestId)
    try {
      const claudeDir = resolveProjectDirectory(input.projectPath)
      if (!this.recoveredDirectories.has(claudeDir)) {
        await recoverHistoryDeleteTransactions(claudeDir)
        this.recoveredDirectories.add(claudeDir)
      }
      const snapshot = await scanHistoryCatalog(input.projectId, input.projectPath, controller.signal)
      const latestCluster = snapshot.clusters.at(-1) ?? null
      const latestProjection = latestCluster
        ? await loadHistoryClusterProjection(snapshot, latestCluster.clusterId, controller.signal).then(({ projection, byteRangeByNodeId }) => {
            this._registerProjectionLocators(projection, byteRangeByNodeId, snapshot.generation, snapshot.claudeDir)
            return projection
          })
        : null
      const state: RequestState = {
        requestId: input.requestId,
        projectKey: key,
        controller,
        snapshot,
        deliveredClusterIds: new Set(latestCluster ? [latestCluster.clusterId] : []),
      }
      this.requests.set(input.requestId, state)
      this.activeControllers.delete(input.requestId)
      this.latestRequestByProject.set(key, input.requestId)
      console.info(`[HistoryService] open request=${input.requestId} generation=${snapshot.generation} clusters=${snapshot.clusters.length} latest=${latestCluster?.clusterId.slice(0, 8) ?? 'none'}`)
      return {
        ok: true,
        requestId: input.requestId,
        generation: snapshot.generation,
        latestCluster,
        latestProjection,
        continuation: latestCluster ? continuationBefore(snapshot, snapshot.clusters.length - 1) : null,
        totalClusters: snapshot.clusters.length,
      }
    } catch (error) {
      if (this.activeControllers.get(input.requestId)?.controller === controller) {
        this.activeControllers.delete(input.requestId)
      }
      if (this.latestRequestByProject.get(key) === input.requestId) {
        this.latestRequestByProject.delete(key)
      }
      return failure(error)
    }
  }

  async continueCatalog(input: HistoryCatalogContinueInput): Promise<HistoryCatalogBatch> {
    try {
      const state = this.requireRequest(input.requestId, input.continuation.generation)
      const clusters = state.snapshot.clusters
      const beforeIndex = clusters.findIndex(
        (cluster) => historyClusterSortKey(cluster) === input.continuation.beforeSortKey,
      )
      if (beforeIndex < 0) {
        throw Object.assign(new Error('History relation changed; refresh the project catalog.'), {
          code: 'HISTORY_RELATION_CHANGED',
        })
      }
      const limit = Math.min(100, Math.max(1, Math.trunc(input.limit || 1)))
      const start = Math.max(0, beforeIndex - limit)
      const batch = clusters.slice(start, beforeIndex)
      batch.forEach((cluster) => state.deliveredClusterIds.add(cluster.clusterId))
      console.debug(`[HistoryService] continue request=${input.requestId} before=${input.continuation.beforeSortKey} count=${batch.length} hasMore=${start > 0}`)
      return {
        ok: true,
        requestId: input.requestId,
        generation: state.snapshot.generation,
        clusters: batch,
        continuation: batch.length > 0 ? continuationBefore(state.snapshot, start) : null,
      }
    } catch (error) {
      return failure(error)
    }
  }

  async loadDetails(input: HistoryDetailsInput): Promise<HistoryDetailsResult> {
    let captured: DetailRequestState | null = null
    try {
      const state = this.requireRequest(input.requestId, input.generation)
      if (this.detailRequests.has(input.detailRequestId)) {
        this.cancelDetailRequest(input.detailRequestId)
      }
      const cluster = state.snapshot.clusters.find((item) => item.clusterId === input.clusterId)
      if (!cluster || !state.deliveredClusterIds.has(input.clusterId)) {
        throw Object.assign(new Error(`History cluster is not in the delivered catalog: ${input.clusterId}`), {
          code: 'HISTORY_NOT_FOUND',
        })
      }

      // snapshot/generation 必须固定捕获，删除重扫不得把旧投影伪装成新 generation。
      captured = {
        detailRequestId: input.detailRequestId,
        requestId: input.requestId,
        projectKey: state.projectKey,
        clusterId: input.clusterId,
        generation: state.snapshot.generation,
        snapshot: state.snapshot,
        controller: new AbortController(),
      }
      this.detailRequests.set(input.detailRequestId, captured)
      console.info(
        `[HistoryService] hydrate start request=${input.requestId} detail=${input.detailRequestId} generation=${captured.generation} cluster=${input.clusterId.slice(0, 8)}`,
      )
      const { projection, byteRangeByNodeId } = await loadHistoryClusterProjection(
        captured.snapshot,
        captured.clusterId,
        captured.controller.signal,
      )
      this._registerProjectionLocators(projection, byteRangeByNodeId, captured.generation, captured.snapshot.claudeDir)
      const currentDetail = this.detailRequests.get(input.detailRequestId)
      const currentProject = this.requests.get(input.requestId)
      if (
        currentDetail !== captured
        || captured.controller.signal.aborted
        || currentProject?.snapshot.generation !== captured.generation
      ) {
        throw Object.assign(new Error('History detail request cancelled or invalidated'), {
          code: 'HISTORY_CANCELLED',
        })
      }
      return {
        ok: true,
        requestId: captured.requestId,
        detailRequestId: captured.detailRequestId,
        generation: captured.generation,
        projection,
      }
    } catch (error) {
      return {
        ...failure(error),
        requestId: input.requestId,
        detailRequestId: input.detailRequestId,
        generation: captured?.generation ?? input.generation,
      }
    } finally {
      if (captured && this.detailRequests.get(input.detailRequestId) === captured) {
        this.detailRequests.delete(input.detailRequestId)
      }
    }
  }

  async sealSession(input: HistorySessionSealInput): Promise<HistorySessionSealResult> {
    const key = projectKey(input.projectPath)
    const controller = new AbortController()
    this.activeControllers.set(input.requestId, { controller, projectKey: key })
    try {
      const snapshot = await scanHistoryCatalog(input.projectId, input.projectPath, controller.signal)
      const cluster = snapshot.clusters.find((item) => (
        item.sessions.some((session) => session.sessionId === input.sessionId)
      ))
      if (!cluster) {
        throw Object.assign(new Error(`Completed session is not present in history catalog: ${input.sessionId}`), {
          code: 'HISTORY_NOT_FOUND',
        })
      }
      const { projection, byteRangeByNodeId } = await loadHistoryClusterProjection(snapshot, cluster.clusterId, controller.signal)
      this._registerProjectionLocators(projection, byteRangeByNodeId, snapshot.generation, snapshot.claudeDir)
      if (controller.signal.aborted) {
        throw Object.assign(new Error('History session seal cancelled'), { code: 'HISTORY_CANCELLED' })
      }

      // 新 snapshot/projection 已完整生成后再替换旧 request；扫描失败不会破坏当前历史面板。
      const previousId = this.latestRequestByProject.get(key)
      if (previousId && previousId !== input.requestId) this.cancelRequest(previousId)
      const deliveredClusterIds = new Set(
        input.knownClusterIds.filter((clusterId) => snapshot.clusters.some((item) => item.clusterId === clusterId)),
      )
      deliveredClusterIds.add(cluster.clusterId)
      this.requests.set(input.requestId, {
        requestId: input.requestId,
        projectKey: key,
        controller,
        snapshot,
        deliveredClusterIds,
      })
      this.activeControllers.delete(input.requestId)
      this.latestRequestByProject.set(key, input.requestId)
      const continuation = input.continuation
        && snapshot.clusters.some((item) => historyClusterSortKey(item) === input.continuation?.beforeSortKey)
        ? { ...input.continuation, generation: snapshot.generation }
        : null
      console.info(
        `[HistoryService] session sealed request=${input.requestId} session=${input.sessionId.slice(0, 8)} cluster=${cluster.clusterId.slice(0, 8)} generation=${snapshot.generation}`,
      )
      return {
        ok: true,
        requestId: input.requestId,
        generation: snapshot.generation,
        cluster,
        projection,
        continuation,
        totalClusters: snapshot.clusters.length,
      }
    } catch (error) {
      return { ...failure(error), requestId: input.requestId, sessionId: input.sessionId }
    } finally {
      if (this.activeControllers.get(input.requestId)?.controller === controller) {
        this.activeControllers.delete(input.requestId)
      }
    }
  }

  cancelDetailRequest(detailRequestId: string): void {
    const state = this.detailRequests.get(detailRequestId)
    if (!state) return
    state.controller.abort()
    this.detailRequests.delete(detailRequestId)
    console.info(
      `[HistoryService] hydrate cancelled request=${state.requestId} detail=${detailRequestId} cluster=${state.clusterId.slice(0, 8)}`,
    )
  }

  cancelRequest(requestId: string): void {
    const state = this.requests.get(requestId)
    const active = this.activeControllers.get(requestId)
    if (!state && !active) return
    state?.controller.abort()
    active?.controller.abort()
    for (const detail of [...this.detailRequests.values()]) {
      if (detail.requestId === requestId) this.cancelDetailRequest(detail.detailRequestId)
    }
    this.requests.delete(requestId)
    this.activeControllers.delete(requestId)
    const key = state?.projectKey ?? active?.projectKey
    if (key && this.latestRequestByProject.get(key) === requestId) {
      this.latestRequestByProject.delete(key)
    }
    if (key && this.latestTokenRequestByProject.get(key) === requestId) {
      this.latestTokenRequestByProject.delete(key)
    }
    console.info(`[HistoryService] cancelled request=${requestId}`)
  }

  async deleteTarget(input: HistoryDeleteInput): Promise<HistoryDeleteResult> {
    const key = projectKey(input.projectPath)
    if (this.deletingProjects.has(key)) {
      return {
        ok: false,
        operationId: input.operationId,
        errorCode: 'HISTORY_RELATION_CHANGED',
        error: 'Another history deletion is already running for this project.',
      }
    }
    const requestId = this.latestRequestByProject.get(key)
    const state = requestId ? this.requests.get(requestId) : undefined
    if (
      !state ||
      state.snapshot.projectId !== input.projectId ||
      state.snapshot.generation !== input.expectedGeneration
    ) {
      return {
        ok: false,
        operationId: input.operationId,
        errorCode: 'HISTORY_RELATION_CHANGED',
        error: 'History catalog changed; reload before deleting.',
      }
    }
    this.deletingProjects.add(key)
    try {
      for (const detail of [...this.detailRequests.values()]) {
        if (detail.requestId === state.requestId) this.cancelDetailRequest(detail.detailRequestId)
      }
      const deletion = await deleteHistoryTarget(state.snapshot, input, this.deps)
      if (!deletion.ok) return { ...deletion, operationId: input.operationId }

      try {
        const replacement = await scanHistoryCatalog(input.projectId, input.projectPath, state.controller.signal)
        const delivered = new Set(
          [...state.deliveredClusterIds].filter((clusterId) => replacement.clusters.some((cluster) => cluster.clusterId === clusterId)),
        )
        state.snapshot = replacement
        state.deliveredClusterIds = delivered
        const deliveredIndexes = replacement.clusters
          .map((cluster, index) => delivered.has(cluster.clusterId) ? index : -1)
          .filter((index) => index >= 0)
        const oldestDeliveredIndex = deliveredIndexes.length > 0
          ? Math.min(...deliveredIndexes)
          : replacement.clusters.length - 1
        console.info(`[HistoryService] delete invalidated generation operation=${input.operationId} generation=${replacement.generation}`)
        return {
          ...deletion,
          operationId: input.operationId,
          generation: replacement.generation,
          continuation: continuationBefore(replacement, oldestDeliveredIndex),
        }
      } catch (error) {
        console.error(`[HistoryService] post-delete rescan failed operation=${input.operationId}:`, error)
        return {
          ...deletion,
          operationId: input.operationId,
          generation: randomUUID(),
          continuation: null,
        }
      }
    } finally {
      this.deletingProjects.delete(key)
    }
  }

  async scanTokenInventory(input: HistoryTokenInventoryInput): Promise<HistoryTokenInventoryResult> {
    const controller = new AbortController()
    const key = projectKey(input.projectPath)
    const previousId = this.latestTokenRequestByProject.get(key)
    if (previousId && previousId !== input.requestId) {
      console.info(`[HistoryService] token scan superseded previous=${previousId} next=${input.requestId}`)
      this.cancelRequest(previousId)
    }
    this.activeControllers.set(input.requestId, { controller, projectKey: key })
    this.latestTokenRequestByProject.set(key, input.requestId)
    try {
      const snapshot = await scanHistoryCatalog(input.projectId, input.projectPath, controller.signal)
      const entries = await scanHistoryTokenInventory(snapshot, controller.signal)
      return { ok: true, requestId: input.requestId, entries }
    } catch (error) {
      return failure(error)
    } finally {
      if (this.activeControllers.get(input.requestId)?.controller === controller) {
        this.activeControllers.delete(input.requestId)
      }
      if (this.latestTokenRequestByProject.get(key) === input.requestId) {
        this.latestTokenRequestByProject.delete(key)
      }
    }
  }

  close(): void {
    for (const active of this.activeControllers.values()) active.controller.abort()
    this.activeControllers.clear()
    for (const detailRequestId of [...this.detailRequests.keys()]) this.cancelDetailRequest(detailRequestId)
    for (const requestId of [...this.requests.keys()]) this.cancelRequest(requestId)
    this.latestTokenRequestByProject.clear()
  }

  getResourceSnapshot(): {
    projectRequests: number
    activeControllers: number
    detailRequests: number
    projectIndexes: number
    tokenProjectIndexes: number
    recoveredDirectories: number
  } {
    return {
      projectRequests: this.requests.size,
      activeControllers: this.activeControllers.size,
      detailRequests: this.detailRequests.size,
      projectIndexes: this.latestRequestByProject.size,
      tokenProjectIndexes: this.latestTokenRequestByProject.size,
      recoveredDirectories: this.recoveredDirectories.size,
    }
  }

  private requireRequest(requestId: string, generation: string): RequestState {
    const state = this.requests.get(requestId)
    if (!state || state.controller.signal.aborted) {
      throw Object.assign(new Error('History request cancelled'), { code: 'HISTORY_CANCELLED' })
    }
    if (state.snapshot.generation !== generation) {
      throw Object.assign(new Error('History relation changed; refresh the project catalog.'), {
        code: 'HISTORY_RELATION_CHANGED',
      })
    }
    return state
  }
}
