// 使用方法：const { expanded, toggle, summaryText, displayText, hasMore } = useDetailDisclosure({ detailId, fullText, detailRef? })
// 编译说明：renderer-only（依赖 Jotai store + detailCapability + detail.atom）
// 代码说明：统一披露契约的 disclosure 状态管理 hook。所有展开/收起入口复用。
//           当 detailRef 存在时，展开后通过 detailCapability 按需获取全文；否则使用内联 fullText。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useStore } from 'jotai'
import {
  acquireLease,
  releaseLease,
  requestDetail,
  cancelDetail,
} from '@renderer/capabilities/detailCapability'
import { detailEntriesAtom } from '@renderer/atoms/detail.atom'

/** 公开摘要行数常量，供各组件统一使用 */
export const SUMMARY_LINES = 4

interface DetailRefLike {
  detailKey: string
  revision: number
  sourceGeneration: string
}

interface UseDetailDisclosureOptions {
  /** 唯一标识，用于 detailKey 和 consumerId 生成 */
  detailId: string
  /** 当前可用文本（detailRef 存在时为 4 行摘要，否则为完整全文） */
  fullText: string
  /** 摘要行数（默认 SUMMARY_LINES=4） */
  summaryLines?: number
  /** L1→L2 关联：存在时展开通过 detailCapability 按需获取全文 */
  detailRef?: DetailRefLike | null
  /** 标记文本已被截断（由 main IPC 或 historyCapability 设置） */
  textTruncated?: boolean
}

interface UseDetailDisclosureReturn {
  /** 是否展开 */
  expanded: boolean
  /** 切换展开/收起 */
  toggle: () => void
  /** 摘要文本（始终可用） */
  summaryText: string
  /** 展示文本：展开时全文（detailRef 就绪或 inline fullText），收起时为空 */
  displayText: string
  /** 是否有更多内容可展开 */
  hasMore: boolean
  /** 加载状态 */
  status: 'loading' | 'ready' | 'error'
  /** 错误消息 */
  error?: string
}

const CONSUMER_PREFIX = 'disclosure'

/**
 * 统一披露契约的展开/收起状态管理 hook。
 *
 * 两种模式：
 * 1. inline 模式（detailRef 不存在）：fullText 即全文，展开直接显示
 * 2. on-demand 模式（detailRef 存在）：fullText 为摘要，展开后通过 DETAIL_REQUEST IPC 获取全文
 */
export function useDetailDisclosure({
  detailId,
  fullText,
  summaryLines = SUMMARY_LINES,
  detailRef,
  textTruncated,
}: UseDetailDisclosureOptions): UseDetailDisclosureReturn {
  const store = useStore()
  const [expanded, setExpanded] = useState(false)
  const consumerId = `${CONSUMER_PREFIX}:${detailId}`
  const prevExpandedRef = useRef(false)

  // ── Detail atom 监听（on-demand 模式） ──────────────────────────────────────

  const detailEntries = useAtomValue(detailEntriesAtom)
  const detailEntry = detailRef ? detailEntries.get(detailRef.detailKey) : undefined

  // ── Summary computation ────────────────────────────────────────────────────

  const lines = useMemo(() => fullText.split('\n'), [fullText])
  // hasMore 判断：文本被截断（textTruncated）或行数超过阈值
  const hasMore = textTruncated || lines.length > summaryLines

  const summaryText = useMemo(() => {
    if (!hasMore && !detailRef) return fullText
    return lines.slice(0, summaryLines).join('\n')
  }, [lines, hasMore, fullText, summaryLines, detailRef])

  // ── Display text ───────────────────────────────────────────────────────────

  let displayText = ''
  let status: 'loading' | 'ready' | 'error' = 'ready'
  let error: string | undefined

  if (expanded) {
    if (detailRef) {
      // on-demand 模式：从 detail.atom 读取
      if (detailEntry?.status === 'ready' && detailEntry.data) {
        displayText = detailEntry.data
        status = 'ready'
      } else if (detailEntry?.status === 'error') {
        displayText = ''
        status = 'error'
        error = detailEntry.error
      } else {
        displayText = ''
        status = 'loading'
      }
    } else {
      // inline 模式：直接使用 fullText
      displayText = fullText
      status = 'ready'
    }
  }

  // ── Toggle ─────────────────────────────────────────────────────────────────

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      console.info(
        `[useDetailDisclosure] toggle id=${detailId} expanded=${!prev} hasDetailRef=${!!detailRef}`
      )
      return !prev
    })
  }, [detailId, detailRef])

  // ── Detail request on expand (on-demand 模式) ──────────────────────────────

  useEffect(() => {
    if (!detailRef) return
    if (!expanded) return
    if (detailEntry?.status === 'ready') return // 已有缓存

    console.info(
      `[useDetailDisclosure] requestDetail key=${detailRef.detailKey} rev=${detailRef.revision}`
    )
    requestDetail(store, detailRef.detailKey, detailRef.revision, detailRef.sourceGeneration).catch(
      (err) => {
        console.error('[useDetailDisclosure] requestDetail failed:', err)
      }
    )
  }, [expanded, detailRef, detailEntry?.status, store])

  // ── Cancel on collapse (on-demand 模式) ────────────────────────────────────

  const prevExpandedForCancelRef = useRef(false)
  useEffect(() => {
    if (!detailRef) return
    const wasExpanded = prevExpandedForCancelRef.current
    prevExpandedForCancelRef.current = expanded

    if (!expanded && wasExpanded) {
      // 收起时取消正在进行的请求
      cancelDetail(store, detailRef.detailKey)
    }
  }, [expanded, detailRef, store])

  // ── Lease lifecycle ────────────────────────────────────────────────────────

  useEffect(() => {
    const wasExpanded = prevExpandedRef.current
    prevExpandedRef.current = expanded

    if (expanded && !wasExpanded) {
      console.info(
        `[useDetailDisclosure] acquireLease id=${detailId} consumer=${consumerId}`
      )
      acquireLease(store, detailId, consumerId)
    } else if (!expanded && wasExpanded) {
      console.info(
        `[useDetailDisclosure] releaseLease id=${detailId} consumer=${consumerId}`
      )
      releaseLease(store, detailId, consumerId)
    }
  }, [expanded, store, detailId, consumerId])

  // ── Cleanup on unmount ─────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (prevExpandedRef.current) {
        console.info(
          `[useDetailDisclosure] unmount releaseLease id=${detailId} consumer=${consumerId}`
        )
        releaseLease(store, detailId, consumerId)
        prevExpandedRef.current = false
      }
    }
  }, [store, detailId, consumerId])

  return {
    expanded,
    toggle,
    summaryText,
    displayText,
    hasMore,
    status,
    error,
  }
}
