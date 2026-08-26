// 使用方法：import { DetailService, createDetailService } from './DetailService'
// 编译说明：Electron main / Node.js
// 代码说明：统一详情权威源。响应 Renderer 的 DETAIL_REQUEST，验证后按 byte range 读取 JSONL 实体 L2 详情。

import type {
  DetailRef,
  EntityLocator,
  DetailRequest,
  DetailResponse,
  DetailChunk,
  McpRequestDetail,
  McpResponseDetail
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
  sourceGeneration: string
  /** TTL in ms */
  ttlMs: number
}


function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

function safeSerialize(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  try {
    const seen = new WeakSet<object>()
    const serialized = JSON.stringify(value, (_key, current: unknown) => {
      if (typeof current !== 'object' || current === null) return current
      if (seen.has(current)) return '[Circular]'
      seen.add(current)
      return current
    }, 2)
    return serialized ?? String(value)
  } catch (err) {
    return `[Unserializable: ${err instanceof Error ? err.message : String(err)}]`
  }
}

function serializeMcpDetail(detail: McpRequestDetail | McpResponseDetail): string {
  return safeSerialize(detail)
}

function extractDetailData(record: ReturnType<typeof parseJsonlLine>, rawData: string): string {
  if (!record) return rawData
  if (record.type === 'tool_use' && record.toolUse?.name.startsWith('mcp__')) {
    return serializeMcpDetail({
      kind: 'mcp-request',
      toolUseId: record.toolUse.id,
      toolName: record.toolUse.name,
      input: record.toolUse.input,
    })
  }
  if (record.type === 'tool_result' && record.toolResult) {
    return serializeMcpDetail({
      kind: 'mcp-response',
      toolUseId: record.toolResult.tool_use_id,
      content: record.toolResult.content,
      isError: record.toolResult.is_error ?? false,
      errorMessage: record.toolResult.is_error ? safeSerialize(record.toolResult.content) : undefined,
    })
  }
  return record.text ?? rawData
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
  const MAX_TRANSIENT_DETAILS = 4096

  /** detailKey → AbortController（进行中的详情请求，支持 DETAIL_CANCEL） */
  const activeRequests = new Map<string, AbortController>()

  /** 当前 generation（locator 失效时递增） */
  let currentGeneration = 'gen-0'

  function registerEntity(
    entityId: string,
    locator: EntityLocator,
    sourceGeneration: string,
    estimatedSize: number
  ): DetailRef {
    const detailKey = entityId
    entityLocatorIndex.set(entityId, { locator, sourceGeneration, estimatedSize })
    detailKeyToEntity.set(detailKey, entityId)
    return { detailKey, revision: Date.now(), sourceGeneration, estimatedSize }
  }

  function unregisterEntity(entityId: string): void {
    entityLocatorIndex.delete(entityId)
    for (const [key, eid] of detailKeyToEntity) {
      if (eid === entityId) {
        detailKeyToEntity.delete(key)
        break
      }
    }
  }

  function registerTransient(detailKey: string, data: string, sessionId: string, ttlMs = 30_000): void {
    transientDetailRegistry.set(detailKey, {
      data,
      createdAt: Date.now(),
      sessionId,
      sourceGeneration: currentGeneration,
      ttlMs,
    })
    while (transientDetailRegistry.size > MAX_TRANSIENT_DETAILS) {
      const oldestKey = transientDetailRegistry.keys().next().value as string | undefined
      if (!oldestKey) break
      transientDetailRegistry.delete(oldestKey)
      logger.warn('[DetailService] transient detail evicted by capacity', { detailKey: shortId(oldestKey) })
    }
  }

  function registerMcpTransient(
    detailKey: string,
    detail: McpRequestDetail | McpResponseDetail,
    sessionId: string,
    // MCP 详情在 Agent 运行期间可能直到工具完成后才被展开，不能沿用
    // Permission 等普通瞬态详情的 30 秒短 TTL；生命周期由 generation、
    // SessionEnd 清理和容量上限共同控制。调用方仍可显式传入 TTL 做测试或特殊限制。
    ttlMs = Number.POSITIVE_INFINITY,
  ): DetailRef {
    const data = serializeMcpDetail(detail)
    registerTransient(detailKey, data, sessionId, ttlMs)
    const ref = {
      detailKey,
      revision: Date.now(),
      sourceGeneration: currentGeneration,
      estimatedSize: Buffer.byteLength(data, 'utf-8'),
    }
    logger.info('[DetailService] MCP transient registered', {
      detailKey: shortId(detail.toolUseId), kind: detail.kind, sessionId: shortId(sessionId), bytes: ref.estimatedSize,
    })
    return ref
  }

  function unregisterTransient(detailKey: string): void {
    transientDetailRegistry.delete(detailKey)
  }

  function unregisterTransientBySession(sessionId: string): void {
    for (const [key, entry] of transientDetailRegistry) {
      if (entry.sessionId === sessionId) transientDetailRegistry.delete(key)
    }
  }

  function invalidateGeneration(): string {
    currentGeneration = `gen-${Date.now()}`
    for (const [key, entry] of transientDetailRegistry) {
      if (entry.sourceGeneration !== currentGeneration) transientDetailRegistry.delete(key)
    }
    logger.info('[DetailService] generation invalidated', { newGeneration: currentGeneration })
    return currentGeneration
  }

  function getCurrentGeneration(): string { return currentGeneration }

  async function handleDetailRequest(request: DetailRequest, abortSignal?: AbortSignal): Promise<DetailResponse> {
    const controller = new AbortController()
    activeRequests.set(request.detailKey, controller)
    if (abortSignal) {
      if (abortSignal.aborted) controller.abort()
      else abortSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      return await handleDetailRequestInner(request, controller.signal)
    } finally {
      activeRequests.delete(request.detailKey)
    }
  }

  async function handleDetailRequestInner(request: DetailRequest, abortSignal: AbortSignal): Promise<DetailResponse> {
    const { detailKey, revision, sourceGeneration } = request
    const transient = transientDetailRegistry.get(detailKey)
    if (transient) {
      if (transient.sourceGeneration !== sourceGeneration) {
        logger.info('[DetailService] transient detail generation mismatch', {
          detailKey: shortId(detailKey),
          expected: transient.sourceGeneration,
          received: sourceGeneration,
        })
        return { detailKey, revision, status: 'invalidated' }
      }
      if (Date.now() - transient.createdAt > transient.ttlMs) {
        transientDetailRegistry.delete(detailKey)
        logger.info('[DetailService] transient detail expired', { detailKey: shortId(detailKey) })
        return { detailKey, revision, status: 'error', error: 'Transient detail expired' }
      }
      logger.info('[DetailService] MCP transient detail hit', { detailKey: shortId(detailKey), sessionId: shortId(transient.sessionId) })
      return { detailKey, revision, status: 'ready', data: transient.data }
    }

    const entityId = detailKeyToEntity.get(detailKey)
    if (!entityId) {
      logger.warn('[DetailService] detailKey not found', { detailKey: shortId(detailKey) })
      return { detailKey, revision, status: 'error', error: 'Entity not found' }
    }
    const entry = entityLocatorIndex.get(entityId)
    if (!entry) {
      logger.warn('[DetailService] entity locator not found', { entityId: shortId(entityId), detailKey: shortId(detailKey) })
      return { detailKey, revision, status: 'error', error: 'Entity locator not found' }
    }
    if (entry.sourceGeneration !== sourceGeneration) {
      logger.info('[DetailService] source generation mismatch, invalidating', { detailKey: shortId(detailKey), expected: entry.sourceGeneration, received: sourceGeneration })
      return { detailKey, revision, status: 'invalidated' }
    }
    if (abortSignal.aborted) return { detailKey, revision, status: 'error', error: 'Request aborted' }

    const { locator } = entry
    const length = locator.byteEndExclusive - locator.byteStart
    try {
      const buffer = await readFile(locator.filePath, locator.byteStart, length)
      if (abortSignal.aborted) return { detailKey, revision, status: 'error', error: 'Request aborted' }
      const rawData = buffer.toString(locator.encoding || 'utf-8')
      const data = extractDetailData(parseJsonlLine(rawData), rawData)
      logger.info('[DetailService] detail read success', {
        detailKey: shortId(detailKey), entityId: shortId(entityId), filePath: locator.filePath,
        byteStart: locator.byteStart, byteEnd: locator.byteStart + length, bytes: length, preview: data.slice(0, 80),
      })
      return { detailKey, revision, status: 'ready', data }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error('[DetailService] detail read failed', { detailKey: shortId(detailKey), entityId: shortId(entityId), filePath: locator.filePath, error: errorMsg })
      return { detailKey, revision, status: 'error', error: errorMsg }
    }
  }

  async function handleDetailRequestChunked(request: DetailRequest, abortSignal?: AbortSignal, chunkSize = 64 * 1024): Promise<void> {
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
        const readLen = Math.min(chunkSize, locator.byteEndExclusive - offset)
        const buffer = await readFile(locator.filePath, offset, readLen)
        const chunk = buffer.toString('utf-8')
        const bytesSent = offset - locator.byteStart + readLen
        if (bytesSent < totalBytes) {
          sendToRenderer(IPC.DETAIL_CHUNK, { detailKey, revision, chunk, bytesSent, totalBytes } as DetailChunk)
        } else {
          sendToRenderer(IPC.DETAIL_RESPONSE, { detailKey, revision, status: 'ready', data: chunk } as DetailResponse)
        }
        offset += readLen
      }
    } catch (err) {
      sendToRenderer(IPC.DETAIL_RESPONSE, { detailKey, revision, status: 'error', error: err instanceof Error ? err.message : String(err) } as DetailResponse)
    }
  }

  function cleanupBySession(sessionId: string): void {
    unregisterTransientBySession(sessionId)
  }

  function getResourceSnapshot(): { registeredEntities: number; transientDetails: number; currentGeneration: string } {
    return { registeredEntities: entityLocatorIndex.size, transientDetails: transientDetailRegistry.size, currentGeneration }
  }

  function purgeExpiredTransients(): number {
    const now = Date.now()
    let purged = 0
    for (const [key, entry] of transientDetailRegistry) {
      if (now - entry.createdAt > entry.ttlMs) { transientDetailRegistry.delete(key); purged++ }
    }
    if (purged > 0) logger.info('[DetailService] purged expired transients', { count: purged })
    return purged
  }

  function cancelByDetailKey(detailKey: string): boolean {
    const controller = activeRequests.get(detailKey)
    if (!controller) {
      logger.info('[DetailService] cancel requested but no active request', { detailKey: shortId(detailKey) })
      return false
    }
    controller.abort()
    activeRequests.delete(detailKey)
    logger.info('[DetailService] detail request cancelled by detailKey', { detailKey: shortId(detailKey) })
    return true
  }

  return {
    registerEntity,
    unregisterEntity,
    registerTransient,
    registerMcpTransient,
    unregisterTransient,
    unregisterTransientBySession,
    invalidateGeneration,
    getCurrentGeneration,
    handleDetailRequest,
    handleDetailRequestChunked,
    cancelByDetailKey,
    cleanupBySession,
    purgeExpiredTransients,
    getResourceSnapshot,
  }
}

export type DetailService = ReturnType<typeof createDetailService>
