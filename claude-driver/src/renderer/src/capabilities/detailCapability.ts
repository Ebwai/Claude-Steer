// 使用方法：import { requestDetail, cancelDetail, acquireLease } from '@renderer/capabilities/detailCapability'
// 编译说明：renderer-only（依赖 window.api.invoke 和 Jotai store）
// 代码说明：统一披露契约的 Renderer detail capability。管理 detail store、in-flight 去重、lease/pin、回收联动。

import { detailEntriesAtom, type DetailEntry } from '@renderer/atoms/detail.atom'
import { IPC } from '@shared/events/ipc-channels'
import type { DetailRequest, DetailResponse, DetailInvalidation } from '@shared/types/detail'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

// ── Types ───────────────────────────────────────────────────────────────────

export type DetailCapabilityStore = Pick<TestStore, 'get' | 'set'>

// ── In-flight 去重 ──────────────────────────────────────────────────────────

/** detailKey → 进行中的请求 promise */
const inflightRequests = new Map<string, Promise<void>>()

// ── Grace period timer ──────────────────────────────────────────────────────

/** detailKey → grace period timeout（最后 lease 释放后等待回收） */
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Grace period duration (ms)：收起详情后等待 30s 才回收 */
const GRACE_PERIOD_MS = 30_000

/** Byte budget：detail store 最大总字节数（默认 2MB） */
const BYTE_BUDGET = 2 * 1024 * 1024

/** Entry count budget：detail store 最大条目数 */
const ENTRY_BUDGET = 200

function cancelGraceTimer(detailKey: string): void {
  const timer = graceTimers.get(detailKey)
  if (timer) {
    clearTimeout(timer)
    graceTimers.delete(detailKey)
  }
}

function startGraceTimer(store: DetailCapabilityStore, detailKey: string): void {
  cancelGraceTimer(detailKey)
  const timer = setTimeout(() => {
    graceTimers.delete(detailKey)
    evictEntry(store, detailKey)
  }, GRACE_PERIOD_MS)
  graceTimers.set(detailKey, timer)
}

function cancelAllGraceTimers(): void {
  for (const timer of graceTimers.values()) {
    clearTimeout(timer)
  }
  graceTimers.clear()
}

function evictEntry(store: DetailCapabilityStore, detailKey: string): void {
  const entries = new Map(store.get(detailEntriesAtom))
  const entry = entries.get(detailKey)
  if (!entry) return

  // 不回收 pinned 或仍有 lease 的条目
  if (entry.pinned || entry.leases.size > 0) return

  if (entry.abortController) {
    entry.abortController.abort()
  }
  entries.delete(detailKey)
  store.set(detailEntriesAtom, entries)
  console.info(`[detailCapability] evicted detail key=${detailKey}`)
}

/**
 * LRU/byte-budget 回收：按 lastAccessed 从旧到新排序，移除超过预算的非 pinned 条目。
 */
function evictByBudgetIfNeeded(store: DetailCapabilityStore): void {
  const entries = new Map(store.get(detailEntriesAtom))
  if (entries.size <= ENTRY_BUDGET) {
    // 检查 byte budget
    let totalBytes = 0
    for (const e of entries.values()) {
      totalBytes += e.estimatedSize > 0 ? e.estimatedSize : (e.data?.length ?? 0)
    }
    if (totalBytes <= BYTE_BUDGET) return
  }

  // 按 lastAccessed 升序（最旧在前）
  const sorted = [...entries.entries()]
    .filter(([, e]) => !e.pinned && e.leases.size === 0)
    .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)

  let totalBytes = 0
  for (const e of entries.values()) {
    totalBytes += e.estimatedSize > 0 ? e.estimatedSize : (e.data?.length ?? 0)
  }

  for (const [key, entry] of sorted) {
    if (entries.size <= ENTRY_BUDGET && totalBytes <= BYTE_BUDGET) break
    const entrySize = entry.estimatedSize > 0 ? entry.estimatedSize : (entry.data?.length ?? 0)
    if (entry.abortController) entry.abortController.abort()
    entries.delete(key)
    totalBytes -= entrySize
    cancelGraceTimer(key)
    console.info(`[detailCapability] LRU evicted detail key=${key}`)
  }
  store.set(detailEntriesAtom, entries)
}

// ── Core functions ──────────────────────────────────────────────────────────

/**
 * 请求单条实体 L2 详情。
 * in-flight 去重：同 detailKey + revision 的并发请求合并为单次 IPC。
 */
export async function requestDetail(
  store: DetailCapabilityStore,
  detailKey: string,
  revision: number,
  sourceGeneration: string
): Promise<void> {
  const inflightKey = `${detailKey}:${revision}`
  const existing = inflightRequests.get(inflightKey)
  if (existing) {
    return existing
  }

  const promise = doRequestDetail(store, detailKey, revision, sourceGeneration).finally(() => {
    inflightRequests.delete(inflightKey)
  })
  inflightRequests.set(inflightKey, promise)
  return promise
}

async function doRequestDetail(
  store: DetailCapabilityStore,
  detailKey: string,
  revision: number,
  sourceGeneration: string
): Promise<void> {
  const entries = new Map(store.get(detailEntriesAtom))
  const existing = entries.get(detailKey)

  // 如果已有 ready 且 revision 匹配，直接返回
  if (existing?.status === 'ready' && existing.revision === revision) {
    return
  }

  // 创建 abort controller
  const abortController = new AbortController()

  // 更新状态为 loading
  const entry: DetailEntry = {
    ...createDefaultEntry(detailKey, revision),
    status: 'loading',
    abortController,
    lastAccessed: Date.now()
  }
  entries.set(detailKey, entry)
  store.set(detailEntriesAtom, entries)

  try {
    const request: DetailRequest = { detailKey, revision, sourceGeneration }
    const result = await window.api.invoke(IPC.DETAIL_REQUEST, request) as DetailResponse

    if (abortController.signal.aborted) {
      return
    }

    const currentEntries = new Map(store.get(detailEntriesAtom))
    const currentEntry = currentEntries.get(detailKey)

    // 检查 entry 是否仍存在且 revision 匹配
    if (!currentEntry || currentEntry.revision !== revision) {
      return
    }

    if (result.status === 'ready') {
      currentEntries.set(detailKey, {
        ...currentEntry,
        status: 'ready',
        data: result.data,
        error: undefined,
        lastAccessed: Date.now(),
        abortController: undefined,
        estimatedSize: result.data?.length ?? currentEntry.estimatedSize
      })
    } else if (result.status === 'invalidated') {
      currentEntries.set(detailKey, {
        ...currentEntry,
        status: 'stale',
        error: 'Source invalidated',
        abortController: undefined
      })
    } else {
      currentEntries.set(detailKey, {
        ...currentEntry,
        status: 'error',
        error: result.error || 'Unknown error',
        abortController: undefined
      })
    }

    store.set(detailEntriesAtom, currentEntries)
    if (result.status === 'ready') {
      evictByBudgetIfNeeded(store)
    }
  } catch (err) {
    if (abortController.signal.aborted) return

    const currentEntries = new Map(store.get(detailEntriesAtom))
    const currentEntry = currentEntries.get(detailKey)
    if (currentEntry && currentEntry.revision === revision) {
      currentEntries.set(detailKey, {
        ...currentEntry,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        abortController: undefined
      })
      store.set(detailEntriesAtom, currentEntries)
    }
  }
}

/**
 * 取消正在进行的详情请求。
 */
export function cancelDetail(store: DetailCapabilityStore, detailKey: string): void {
  const entries = new Map(store.get(detailEntriesAtom))
  const entry = entries.get(detailKey)
  if (entry?.abortController) {
    entry.abortController.abort()
  }
}

/**
 * 注册消费者 lease。
 */
export function acquireLease(store: DetailCapabilityStore, detailKey: string, consumerId: string): void {
  cancelGraceTimer(detailKey) // 新 lease 到来，取消 grace period
  const entries = new Map(store.get(detailEntriesAtom))
  const entry = entries.get(detailKey)
  if (entry) {
    entry.leases.add(consumerId)
    entry.lastAccessed = Date.now()
    store.set(detailEntriesAtom, entries)
  }
}

/**
 * 释放消费者 lease。最后一个释放后启动 grace 回收。
 */
export function releaseLease(store: DetailCapabilityStore, detailKey: string, consumerId: string): void {
  const entries = new Map(store.get(detailEntriesAtom))
  const entry = entries.get(detailKey)
  if (entry) {
    entry.leases.delete(consumerId)
    entry.lastAccessed = Date.now()
    store.set(detailEntriesAtom, entries)

    // 最后一个 lease 释放且未 pin 时启动 grace period
    if (entry.leases.size === 0 && !entry.pinned) {
      startGraceTimer(store, detailKey)
    }
  }
}

/**
 * Pin 详情（当前展开时 pin，禁止回收）。
 */
export function pinDetail(store: DetailCapabilityStore, detailKey: string): void {
  cancelGraceTimer(detailKey) // Pin 时取消 grace period
  const entries = new Map(store.get(detailEntriesAtom))
  const entry = entries.get(detailKey)
  if (entry) {
    entry.pinned = true
    store.set(detailEntriesAtom, entries)
  }
}

/**
 * Unpin 详情（解除 pin，进入 grace 期）。
 */
export function unpinDetail(store: DetailCapabilityStore, detailKey: string): void {
  const entries = new Map(store.get(detailEntriesAtom))
  const entry = entries.get(detailKey)
  if (entry) {
    entry.pinned = false
    entry.lastAccessed = Date.now()
    store.set(detailEntriesAtom, entries)

    // 无 lease 时启动 grace period
    if (entry.leases.size === 0) {
      startGraceTimer(store, detailKey)
    }
  }
}

/**
 * 预取详情（hover 意图延迟或 keyboard focus 时调用）。
 * 低优先级，可被 direct expand 抢占。
 */
export function prefetchDetail(
  store: DetailCapabilityStore,
  detailKey: string,
  revision: number,
  sourceGeneration: string
): void {
  const entries = store.get(detailEntriesAtom)
  const existing = entries.get(detailKey)

  // 已有 ready/loading 则不重复请求
  if (existing?.status === 'ready' || existing?.status === 'loading') {
    return
  }

  // 异步请求，不等待
  requestDetail(store, detailKey, revision, sourceGeneration).catch(() => {
    // 预取失败静默忽略
  })
}

/**
 * 处理 Main 推送的 DETAIL_INVALIDATED 通知。
 */
export function handleDetailInvalidation(
  store: DetailCapabilityStore,
  invalidation: DetailInvalidation
): void {
  const entries = new Map(store.get(detailEntriesAtom))
  const entry = entries.get(invalidation.detailKey)
  if (entry) {
    entries.set(invalidation.detailKey, {
      ...entry,
      status: 'stale',
      error: 'Source invalidated',
      data: undefined
    })
    store.set(detailEntriesAtom, entries)
  }
}

/**
 * 处理 Main 推送的 DETAIL_CHUNK（分块详情中间块）。
 */
export function handleDetailChunk(
  store: DetailCapabilityStore,
  payload: { detailKey: string; revision: number; chunk: string; bytesSent: number; totalBytes: number }
): void {
  const entries = new Map(store.get(detailEntriesAtom))
  const entry = entries.get(payload.detailKey)
  if (entry && entry.revision === payload.revision) {
    // 累积 chunk 到 data
    const existing = entry.data || ''
    entries.set(payload.detailKey, {
      ...entry,
      data: existing + payload.chunk,
      lastAccessed: Date.now()
    })
    store.set(detailEntriesAtom, entries)
  }
}

// ── 清理 ───────────────────────────────────────────────────────────────────

/**
 * 清理指定项目的全部 detail。
 * 项目切换时调用：detail 条目全部为当前项目作用域内实体，切换时统一清除。
 */
export function cleanupDetailByProject(store: DetailCapabilityStore, projectId: string): void {
  // 所有 detail 条目都属于当前项目（entityId 来自该项目的 JSONL），项目切换时全部清除
  cancelAllGraceTimers()
  cleanupAllDetails(store)
  console.info(`[detailCapability] cleanup by project=${projectId}, all details cleared`)
}

/**
 * 清理指定 Session 的全部 detail。
 * 当前 detailKeys 为 entityId，不含 sessionId 前缀，按全部清除处理。
 * 后续可通过 entityLocatorIndex 反查 sessionId 精确清理。
 */
export function cleanupDetailBySession(store: DetailCapabilityStore, sessionId: string): void {
  cancelAllGraceTimers()
  cleanupAllDetails(store)
  console.info(`[detailCapability] cleanup by session=${sessionId}, all details cleared`)
}

/**
 * 清理全部 detail（窗口销毁时调用）。
 */
export function cleanupAllDetails(store: DetailCapabilityStore): void {
  cancelAllGraceTimers()
  const entries = store.get(detailEntriesAtom)
  for (const entry of entries.values()) {
    if (entry.abortController) {
      entry.abortController.abort()
    }
  }
  store.set(detailEntriesAtom, new Map())
  inflightRequests.clear()
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function createDefaultEntry(detailKey: string, revision: number): DetailEntry {
  return {
    detailKey,
    revision,
    status: 'idle',
    leases: new Set(),
    pinned: false,
    lastAccessed: Date.now(),
    estimatedSize: -1
  }
}
