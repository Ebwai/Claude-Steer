// 使用方法：import { detailEntriesAtom } from '@renderer/atoms/detail.atom'
// 编译说明：纯 Jotai atom，renderer-only
// 代码说明：统一披露契约的 Renderer detail store。按 detailKey + revision 管理详情状态。

import { atom } from 'jotai'
import type { DetailStatus } from '@shared/types/detail'

// ── Types ───────────────────────────────────────────────────────────────────

export interface DetailEntry {
  /** Main DetailService 分配的不透明 key */
  detailKey: string
  /** 详情版本号 */
  revision: number
  /** 当前状态 */
  status: DetailStatus
  /** 详情数据（ready 时存在） */
  data?: string
  /** 错误信息（error 时存在） */
  error?: string
  /** 消费者 lease 集合（最后一个释放后启动 grace 回收） */
  leases: Set<string>
  /** 当前展开时 pin，禁止回收 */
  pinned: boolean
  /** 最后访问时间 */
  lastAccessed: number
  /** 预估字节数（用于 cache 预算） */
  estimatedSize: number
  /** 请求取消控制器 */
  abortController?: AbortController
}

// ── Atom ────────────────────────────────────────────────────────────────────

/** detailKey → DetailEntry */
export const detailEntriesAtom = atom<Map<string, DetailEntry>>(new Map())

// ── 派生选择器（供 capability 使用）─────────────────────────────────────────

/**
 * 获取指定 detailKey 的详情条目（只读）。
 */
export const detailEntrySelector = atom((get) => {
  return (detailKey: string): DetailEntry | undefined => {
    return get(detailEntriesAtom).get(detailKey)
  }
})

/**
 * 计算当前 detail cache 的总字节数。
 */
export const detailCacheSizeAtom = atom((get) => {
  const entries = get(detailEntriesAtom)
  let total = 0
  for (const entry of entries.values()) {
    if (entry.status === 'ready' && entry.data) {
      total += entry.estimatedSize || entry.data.length
    }
  }
  return total
})

/**
 * 计算当前 detail cache 的条目数（ready 状态）。
 */
export const detailCacheCountAtom = atom((get) => {
  const entries = get(detailEntriesAtom)
  let count = 0
  for (const entry of entries.values()) {
    if (entry.status === 'ready') {
      count++
    }
  }
  return count
})
