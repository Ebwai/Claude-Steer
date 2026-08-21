// 使用方法：import { DetailService, createDetailService } from './DetailService'
// 编译说明：Electron main / Node.js
// 代码说明：统一详情权威源。响应 Renderer 的 DETAIL_REQUEST，验证后按 byte range 读取 JSONL 实体 L2 详情。

import type {
  DetailRef,
  EntityLocator,
  DetailRequest,
  DetailResponse,
  DetailChunk
} from '../../../shared/types/detail'
import { IPC } from '../../../shared/events/ipc-channels'
import { parseJsonlLine } from '../jsonl/JsonlParser'

// ── Types ───────────────────────────────────────────────────────────────────

interface LocatorEntry {
  locator: EntityLocator
  sourceGeneration: string
  estimatedSize: number
}

interface TransientEntry {
  data: string
  createdAt: number
  sessionId: string
  /** TTL in ms */
  ttlMs: number
}

export interface DetailServiceDeps {
  readFile(filePath: string, offset: number, length: number): Promise<Buffer>
  sendToRenderer: (channel: string, payload: unknown) => void
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void
    warn: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createDetailService(deps: DetailServiceDeps) {
  const { readFile, sendToRenderer, logger } = deps

  /** entityId → LocatorEntry（内存索引，可重建） */
  const entityLocatorIndex = new Map<string, LocatorEntry>()

  /** detailKey → entityId（反向映射） */
  const detailKeyToEntity = new Map<string, string>()

  /** detailKey → TransientEntry（Permission 等瞬态详情） */
  const transientDetailRegistry = new Map<string, TransientEntry>()

  /** detailKey → AbortController（进行中的详情请求，支持 DETAIL_CANCEL） */
  const activeRequests = new Map<string, AbortController>()

  /** 当前 generation（locator 失效时递增） */
  let currentGeneration = 'gen-0'

  // ── 注册/注销 ────────────────────────────────────────────────────────────

  function registerEntity(
    entityId: string,
    locator: EntityLocator,
    sourceGeneration: string,
    estimatedSize: number
  ): DetailRef {
    const detailKey = entityId
    entityLocatorIndex.set(entityId, { locator, sourceGeneration, estimatedSize })
    detailKeyToEntity.set(detailKey, entityId)

    const revision = Date.now()
    return {
      detailKey,
      revision,
      sourceGeneration,
      estimatedSize
    }
  }

  function unregisterEntity(entityId: string): void {
    entityLocatorIndex.delete(entityId)
    // 清理反向映射
    for (const [key, eid] of detailKeyToEntity) {
      if (eid === entityId) {
        detailKeyToEntity.delete(key)
        break
      }
    }
  }

  function registerTransient(detailKey: string, data: string, sessionId: string, ttlMs = 30_000): void {
    transientDetailRegistry.set(detailKey, { data, createdAt: Date.now(), sessionId, ttlMs })
  }

  function unregisterTransient(detailKey: string): void {
    transientDetailRegistry.delete(detailKey)
  }

  function unregisterTransientBySession(sessionId: string): void {
    for (const [key, entry] of transientDetailRegistry) {
      if (entry.sessionId === sessionId) {
        transientDetailRegistry.delete(key)
      }
    }
  }

  // ── Generation ───────────────────────────────────────────────────────────

  function invalidateGeneration(): string {
    currentGeneration = `gen-${Date.now()}`
    logger.info('[DetailService] generation invalidated', { newGeneration: currentGeneration })
    return currentGeneration
  }

  function getCurrentGeneration(): string {
    return currentGeneration
  }

  // ── 请求处理 ─────────────────────────────────────────────────────────────

  async function handleDetailRequest(
    request: DetailRequest,
    abortSignal?: AbortSignal
  ): Promise<DetailResponse> {
    const { detailKey } = request

    // 创建 AbortController，合并外部 signal 与 cancelByDetailKey 触发
    const controller = new AbortController()
    const mergedSignal = controller.signal
    activeRequests.set(detailKey, controller)

    // 外部 signal abort 时同步到 controller
    if (abortSignal) {
      if (abortSignal.aborted) {
        controller.abort()
      } else {
        abortSignal.addEventListener('abort', () => controller.abort(), { once: true })
      }
    }

    try {
      return await handleDetailRequestInner(request, mergedSignal)
    } finally {
      activeRequests.delete(detailKey)
    }
  }

  async function handleDetailRequestInner(
    request: DetailRequest,
    abortSignal: AbortSignal
  ): Promise<DetailResponse> {
    const { detailKey, revision, sourceGeneration } = request

    // 1. 检查瞬态详情
    const transient = transientDetailRegistry.get(detailKey)
    if (transient) {
      // 检查 TTL
      if (Date.now() - transient.createdAt > transient.ttlMs) {
        transientDetailRegistry.delete(detailKey)
        logger.info('[DetailService] transient detail expired', { detailKey })
        return { detailKey, revision, status: 'error', error: 'Transient detail expired' }
      }
      return { detailKey, revision, status: 'ready', data: transient.data }
    }

    // 2. 查找 entity locator
    const entityId = detailKeyToEntity.get(detailKey)
    if (!entityId) {
      logger.warn('[DetailService] detailKey not found', { detailKey })
      return { detailKey, revision, status: 'error', error: 'Entity not found' }
    }

    const entry = entityLocatorIndex.get(entityId)
    if (!entry) {
      logger.warn('[DetailService] entity locator not found', { entityId, detailKey })
      return { detailKey, revision, status: 'error', error: 'Entity locator not found' }
    }

    // 3. 验证 source generation
    if (entry.sourceGeneration !== sourceGeneration) {
      logger.info('[DetailService] source generation mismatch, invalidating', {
        detailKey,
        expected: entry.sourceGeneration,
        received: sourceGeneration
      })
      return { detailKey, revision, status: 'invalidated' }
    }

    // 4. 检查 abort
    if (abortSignal?.aborted) {
      return { detailKey, revision, status: 'error', error: 'Request aborted' }
    }

    // 5. 按 byte range 读取
    const { locator } = entry
    const length = locator.byteEndExclusive - locator.byteStart

    try {
      if (abortSignal?.aborted) {
        return { detailKey, revision, status: 'error', error: 'Request aborted' }
      }

      const buffer = await readFile(locator.filePath, locator.byteStart, length)

      if (abortSignal?.aborted) {
        return { detailKey, revision, status: 'error', error: 'Request aborted' }
      }

      const rawData = buffer.toString(locator.encoding || 'utf-8')

      // 从 JSONL 行提取纯消息文本（剥离 parentUuid/sessionId/timestamp 等元数据）
      const record = parseJsonlLine(rawData)
      const data = record?.text ?? rawData

      logger.info('[DetailService] detail read success', {
        detailKey,
        entityId,
        filePath: locator.filePath,
        byteStart: locator.byteStart,
        byteEnd: locator.byteStart + length,
        bytes: length,
        preview: data.slice(0, 80)
      })

      return { detailKey, revision, status: 'ready', data }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error('[DetailService] detail read failed', {
        detailKey,
        entityId,
        filePath: locator.filePath,
        error: errorMsg
      })
      return { detailKey, revision, status: 'error', error: errorMsg }
    }
  }

  // ── 大详情分块响应（预留） ───────────────────────────────────────────────

  async function handleDetailRequestChunked(
    request: DetailRequest,
    abortSignal?: AbortSignal,
    chunkSize = 64 * 1024
  ): Promise<void> {
    const { detailKey, revision, sourceGeneration } = request

    const entityId = detailKeyToEntity.get(detailKey)
    if (!entityId) {
      sendToRenderer(IPC.DETAIL_RESPONSE, { detailKey, revision, status: 'error', error: 'Entity not found' } as DetailResponse)
      return
    }

    const entry = entityLocatorIndex.get(entityId)
    if (!entry || entry.sourceGeneration !== sourceGeneration) {
      sendToRenderer(IPC.DETAIL_RESPONSE, { detailKey, revision, status: 'invalidated' } as DetailResponse)
      return
    }

    const { locator } = entry
    const totalBytes = locator.byteEndExclusive - locator.byteStart
    let offset = locator.byteStart

    try {
      while (offset < locator.byteEndExclusive) {
        if (abortSignal?.aborted) {
          sendToRenderer(IPC.DETAIL_RESPONSE, { detailKey, revision, status: 'error', error: 'Request aborted' } as DetailResponse)
          return
        }

        const remaining = locator.byteEndExclusive - offset
        const readLen = Math.min(chunkSize, remaining)
        const buffer = await readFile(locator.filePath, offset, readLen)
        const chunk = buffer.toString('utf-8')
        const bytesSent = offset - locator.byteStart + readLen

        if (bytesSent < totalBytes) {
          sendToRenderer(IPC.DETAIL_CHUNK, {
            detailKey,
            revision,
            chunk,
            bytesSent,
            totalBytes
          } as DetailChunk)
        } else {
          // 最后一块用 DETAIL_RESPONSE
          sendToRenderer(IPC.DETAIL_RESPONSE, {
            detailKey,
            revision,
            status: 'ready',
            data: chunk
          } as DetailResponse)
        }

        offset += readLen
      }
    } catch (err) {
      sendToRenderer(IPC.DETAIL_RESPONSE, {
        detailKey,
        revision,
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      } as DetailResponse)
    }
  }

  // ── 会话级清理 ───────────────────────────────────────────────────────────

  function cleanupBySession(sessionId: string): void {
    unregisterTransientBySession(sessionId)
    // entity locator 由 history projection 生命周期管理，此处不清理
  }

  // ── 状态查询 ─────────────────────────────────────────────────────────────

  function getResourceSnapshot(): {
    registeredEntities: number
    transientDetails: number
    currentGeneration: string
  } {
    return {
      registeredEntities: entityLocatorIndex.size,
      transientDetails: transientDetailRegistry.size,
      currentGeneration
    }
  }

  // ── 清理过期瞬态 ─────────────────────────────────────────────────────────

  function purgeExpiredTransients(): number {
    const now = Date.now()
    let purged = 0
    for (const [key, entry] of transientDetailRegistry) {
      if (now - entry.createdAt > entry.ttlMs) {
        transientDetailRegistry.delete(key)
        purged++
      }
    }
    if (purged > 0) {
      logger.info('[DetailService] purged expired transients', { count: purged })
    }
    return purged
  }

  // ── 取消进行中请求 ───────────────────────────────────────────────────────

  function cancelByDetailKey(detailKey: string): boolean {
    const controller = activeRequests.get(detailKey)
    if (controller) {
      controller.abort()
      activeRequests.delete(detailKey)
      logger.info('[DetailService] detail request cancelled by detailKey', { detailKey })
      return true
    }
    logger.info('[DetailService] cancel requested but no active request', { detailKey })
    return false
  }

  return {
    // 注册/注销
    registerEntity,
    unregisterEntity,
    registerTransient,
    unregisterTransient,
    unregisterTransientBySession,
    // Generation
    invalidateGeneration,
    getCurrentGeneration,
    // 请求
    handleDetailRequest,
    handleDetailRequestChunked,
    cancelByDetailKey,
    // 清理
    cleanupBySession,
    purgeExpiredTransients,
    // 查询
    getResourceSnapshot
  }
}

export type DetailService = ReturnType<typeof createDetailService>
