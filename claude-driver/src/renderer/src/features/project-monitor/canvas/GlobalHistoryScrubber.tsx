// 使用方法：在 ProcessLineCanvas.tsx 中，absolute 定位于画布容器最右侧
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局历史导航条——浏览器滚动条风格，单条覆盖整个画布高度
//           按 session 分段（段高比例按各 session 节点总数），段内 tick marks 标记 user_input 位置
//           鼠标拖拽滑块按 user_input 粒度跳转（快速定位），键盘游标另由 useGlobalKeyNav 驱动

import React, { useRef, useCallback, useEffect } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { timelineBySessionAtom, scrubberIndexAtom, cursorNodeIndexAtom } from '../../../atoms/timeline.atom'
import { lineInsertionsBySessionAtom } from '../../../atoms/timeline.atom'
import { nodeJumpRequestAtom, focusedSessionIdAtom } from '../../../atoms/viewport.atom'
import { buildJumpableNodes } from '../../../capabilities/jumpableNodes'

const TRACK_COLOR = 'rgba(255,255,255,0.05)'
const TICK_COLOR = 'rgba(255,255,255,0.18)'
const THUMB_COLOR = 'rgba(255,255,255,0.18)'
const THUMB_ACTIVE_COLOR = 'rgba(53,201,138,0.45)'
const SEP_COLOR = 'rgba(255,255,255,0.10)'
const MIN_SEGMENT_HEIGHT = 24   // px，每个 session 段的最小高度
const MIN_THUMB_HEIGHT   = 32   // px

interface GlobalHistoryScrubberProps {
  /** 按布局 X 坐标顺序排列的所有 sessionId */
  orderedSessionIds: string[]
  /** 点击某 session 段时切换聚焦 */
  onSessionFocus: (sessionId: string) => void
}

export default function GlobalHistoryScrubber({
  orderedSessionIds,
  onSessionFocus,
}: GlobalHistoryScrubberProps): React.JSX.Element {
  const store         = useStore()
  const focusedId     = useAtomValue(focusedSessionIdAtom)
  const trackRef      = useRef<HTMLDivElement>(null)
  const isDragging    = useRef(false)
  const dragSessionId = useRef<string | null>(null)

  // ── 读取各 session 节点数（驱动段高度计算）────────────────────────────────
  // 用 store.get 避免过度订阅——每次渲染时按需读取
  const segmentData = orderedSessionIds.map((sid) => {
    const nodes      = store.get(timelineBySessionAtom(sid))
    const insertions = store.get(lineInsertionsBySessionAtom(sid))
    const jumpable   = buildJumpableNodes(nodes, insertions)
    const userInputs = nodes.filter((n) => n.type === 'user_input')
    return { sid, totalNodes: Math.max(jumpable.length, 1), userInputCount: userInputs.length }
  })

  const totalNodes = segmentData.reduce((s, d) => s + d.totalNodes, 0) || 1

  // ── 拖拽：按 user_input 粒度跳转（快速定位）─────────────────────────────
  const jumpByRatio = useCallback((sid: string, ratioInSegment: number) => {
    const nodes     = store.get(timelineBySessionAtom(sid))
    const userInputs = nodes.filter((n) => n.type === 'user_input')
    if (userInputs.length === 0) return
    const idx = Math.min(
      userInputs.length - 1,
      Math.max(0, Math.floor(ratioInSegment * userInputs.length))
    )
    store.set(scrubberIndexAtom(sid), idx)
    // 同步把 cursor 移到对应 user_input 在 jumpableNodes 中的位置
    const insertions = store.get(lineInsertionsBySessionAtom(sid))
    const jumpable   = buildJumpableNodes(nodes, insertions)
    const targetNode = userInputs[idx]
    const jumpIdx    = jumpable.findIndex((j) => j.id === targetNode.id)
    if (jumpIdx >= 0) store.set(cursorNodeIndexAtom(sid), jumpIdx)
    store.set(nodeJumpRequestAtom, { sessionId: sid, nodeId: targetNode.id, ts: Date.now() })
    console.log(`[GlobalScrubber] jump sid=${sid.slice(0,8)} userInputIdx=${idx} nodeId=${targetNode.id.slice(0,8)}`)
  }, [store])

  // ── 从 clientY 解析出对应 session + segment 内比例 ────────────────────────
  const resolveFromClientY = useCallback((clientY: number): { sid: string; ratio: number } | null => {
    const track = trackRef.current
    if (!track) return null
    const rect = track.getBoundingClientRect()
    const relY = Math.max(0, Math.min(clientY - rect.top, rect.height))
    const trackH = rect.height

    let offsetY = 0
    for (const seg of segmentData) {
      const segH = Math.max(MIN_SEGMENT_HEIGHT, (seg.totalNodes / totalNodes) * trackH)
      if (relY <= offsetY + segH) {
        const ratioInSeg = (relY - offsetY) / segH
        return { sid: seg.sid, ratio: ratioInSeg }
      }
      offsetY += segH
    }
    // 点在最后段之外（浮点误差）
    const last = segmentData[segmentData.length - 1]
    return last ? { sid: last.sid, ratio: 1 } : null
  }, [segmentData, totalNodes])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const resolved = resolveFromClientY(e.clientY)
    if (!resolved) return
    isDragging.current    = true
    dragSessionId.current = resolved.sid
    onSessionFocus(resolved.sid)
    jumpByRatio(resolved.sid, resolved.ratio)
  }, [resolveFromClientY, onSessionFocus, jumpByRatio])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!isDragging.current || !dragSessionId.current) return
      const resolved = resolveFromClientY(e.clientY)
      if (!resolved || resolved.sid !== dragSessionId.current) return
      jumpByRatio(resolved.sid, resolved.ratio)
    }
    const onUp = (): void => {
      isDragging.current    = false
      dragSessionId.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resolveFromClientY, jumpByRatio])

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  if (orderedSessionIds.length === 0) return <></>

  return (
    <div
      ref={trackRef}
      onMouseDown={handleMouseDown}
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        width: 16,
        height: '100%',
        background: TRACK_COLOR,
        zIndex: 20,
        cursor: 'pointer',
        userSelect: 'none',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {segmentData.map((seg, idx) => (
        <SegmentTrack
          key={seg.sid}
          sid={seg.sid}
          totalNodes={seg.totalNodes}
          userInputCount={seg.userInputCount}
          globalTotalNodes={totalNodes}
          isFocused={seg.sid === focusedId}
          showSep={idx > 0}
          store={store}
        />
      ))}
    </div>
  )
}

// ── 单个 session 段 ───────────────────────────────────────────────────────────

interface SegmentTrackProps {
  sid: string
  totalNodes: number
  userInputCount: number
  globalTotalNodes: number
  isFocused: boolean
  showSep: boolean
  store: ReturnType<typeof useStore>
}

function SegmentTrack({
  sid,
  totalNodes,
  userInputCount,
  globalTotalNodes,
  isFocused,
  showSep,
  store,
}: SegmentTrackProps): React.JSX.Element {
  const scrubIdx  = useAtomValue(scrubberIndexAtom(sid))
  const cursorIdx = useAtomValue(cursorNodeIndexAtom(sid))

  // 滑块 Y%（鼠标拖拽位置，基于 user_input 索引）
  const nodes     = store.get(timelineBySessionAtom(sid))
  const userInputs = nodes.filter((n) => n.type === 'user_input')
  const uiTotal   = Math.max(userInputCount, 1)

  const thumbPct = scrubIdx < 0
    ? 100 - Math.max(MIN_THUMB_HEIGHT, 100 / uiTotal)
    : (scrubIdx / uiTotal) * 100

  // 键盘游标指示（绿色细线）
  const insertions = store.get(lineInsertionsBySessionAtom(sid))
  const jumpable   = buildJumpableNodes(nodes, insertions)
  const jumpTotal  = Math.max(jumpable.length, 1)
  const cursorPct  = cursorIdx >= 0 ? (cursorIdx / jumpTotal) * 100 : -1

  const flexGrow = Math.max(MIN_SEGMENT_HEIGHT, (totalNodes / globalTotalNodes) * 100)

  return (
    <div
      style={{
        position: 'relative',
        flexGrow,
        flexShrink: 0,
        minHeight: MIN_SEGMENT_HEIGHT,
        borderTop: showSep ? `1px solid ${SEP_COLOR}` : undefined,
      }}
    >
      {/* user_input tick marks */}
      {userInputs.map((node, i) => {
        const topPct = ((i + 0.5) / uiTotal) * 100
        return (
          <div
            key={node.id}
            style={{
              position: 'absolute',
              left: '15%',
              right: '15%',
              top: `${topPct}%`,
              height: 1.5,
              background: TICK_COLOR,
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
            }}
          />
        )
      })}

      {/* 键盘游标细线（绿色，仅聚焦 session 显示） */}
      {isFocused && cursorPct >= 0 && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: `${cursorPct}%`,
            height: 2,
            background: 'rgba(53,201,138,0.85)',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            borderRadius: 1,
          }}
        />
      )}

      {/* 滑块 thumb */}
      <div
        style={{
          position: 'absolute',
          left: 2,
          right: 2,
          top: `${thumbPct}%`,
          height: `${Math.max(MIN_THUMB_HEIGHT, 100 / uiTotal)}%`,
          background: isFocused ? THUMB_ACTIVE_COLOR : THUMB_COLOR,
          borderRadius: 3,
          transition: isDraggingRef ? 'none' : 'top 0.12s, background 0.15s',
          pointerEvents: 'none',
          minHeight: MIN_THUMB_HEIGHT,
        }}
      />
    </div>
  )
}

// 全局拖拽状态引用（供 SegmentTrack 的 transition 判断）
const isDraggingRef = false
