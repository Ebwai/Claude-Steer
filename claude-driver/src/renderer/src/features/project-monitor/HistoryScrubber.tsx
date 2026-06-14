// 使用方法：在 SessionFrameNode 内与 ProcessTimeline 并列放置，absolute 定位覆盖右侧 16px
// 编译说明：renderer 进程 browser bundle
// 代码说明：历史拉动条组件——展示 user_input 区间分隔点 + 可拖拽滑块
//           滚动目标是 ptl-container 的 scrollTop，不是 @xyflow 画布坐标

import React, { useRef, useCallback, useEffect } from 'react'
import { useAtom } from 'jotai'
import { scrubberIndexAtom } from '../../atoms/timeline.atom'
import type { TimelineNode } from '../../atoms/timeline.atom'

interface HistoryScrubberProps {
  sessionId: string
  /** 只传 type === 'user_input' 的节点列表 */
  userInputNodes: TimelineNode[]
  /** 跳转到指定 user_input 节点 */
  onJumpTo: (nodeId: string) => void
}

const TRACK_COLOR = 'rgba(255,255,255,0.06)'
const DOT_COLOR = 'rgba(255,255,255,0.28)'
const DOT_ACTIVE_COLOR = '#35C98A'
const THUMB_COLOR = 'rgba(255,255,255,0.22)'
const THUMB_ACTIVE_COLOR = 'rgba(53,201,138,0.5)'
const MIN_THUMB_HEIGHT = 20

export default function HistoryScrubber({ sessionId, userInputNodes, onJumpTo }: HistoryScrubberProps): React.JSX.Element {
  const [scrubIndex, setScrubIndex] = useAtom(scrubberIndexAtom(sessionId))
  const trackRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)

  const total = userInputNodes.length

  // ── 位置计算 ─────────────────────────────────────────────────────────────

  const thumbHeightPct = Math.max(MIN_THUMB_HEIGHT, (1 / total) * 100)

  /** 根据当前 index 计算滑块顶部百分比（-1 = 底部跟随 → 100% - thumbHeightPct） */
  const thumbTopPct = (): number => {
    if (scrubIndex < 0) return 100 - thumbHeightPct
    return (scrubIndex / total) * 100
  }

  // ── 拖拽逻辑 ─────────────────────────────────────────────────────────────

  const indexFromY = useCallback((clientY: number): number => {
    const track = trackRef.current
    if (!track) return -1
    const rect = track.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    return Math.min(total - 1, Math.floor(ratio * total))
  }, [total])

  const jumpToIndex = useCallback((idx: number) => {
    setScrubIndex(idx)
    const node = userInputNodes[idx]
    if (node) onJumpTo(node.id)
  }, [userInputNodes, setScrubIndex, onJumpTo])

  const handleTrackMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const idx = indexFromY(e.clientY)
    if (idx >= 0) jumpToIndex(idx)
    isDraggingRef.current = true
  }, [indexFromY, jumpToIndex])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!isDraggingRef.current) return
      const idx = indexFromY(e.clientY)
      if (idx >= 0) jumpToIndex(idx)
    }
    const onMouseUp = (): void => { isDraggingRef.current = false }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [indexFromY, jumpToIndex])

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  if (total === 0) return <></>

  return (
    <div
      ref={trackRef}
      onMouseDown={handleTrackMouseDown}
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        width: 16,
        height: '100%',
        background: TRACK_COLOR,
        zIndex: 10,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {/* 区间分隔点 */}
      {userInputNodes.map((node, idx) => {
        const topPct = ((idx + 0.5) / total) * 100
        const isActive = scrubIndex === idx
        return (
          <div
            key={node.id}
            style={{
              position: 'absolute',
              left: '50%',
              top: `${topPct}%`,
              transform: 'translate(-50%, -50%)',
              width: isActive ? 8 : 5,
              height: isActive ? 8 : 5,
              borderRadius: '50%',
              background: isActive ? DOT_ACTIVE_COLOR : DOT_COLOR,
              transition: 'all 0.15s',
              pointerEvents: 'none',
            }}
          />
        )
      })}

      {/* 滑块 */}
      <div
        style={{
          position: 'absolute',
          left: 2,
          right: 2,
          top: `${thumbTopPct()}%`,
          height: `${thumbHeightPct}%`,
          background: scrubIndex >= 0 ? THUMB_ACTIVE_COLOR : THUMB_COLOR,
          borderRadius: 4,
          transition: isDraggingRef.current ? 'none' : 'top 0.15s, background 0.2s',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
