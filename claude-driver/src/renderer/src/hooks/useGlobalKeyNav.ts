// 使用方法：在 ProcessLineCanvasInner 内调用 useGlobalKeyNav(rf, layouts, relationsMap)
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局键盘导航 Hook——↑↓ 框内精细游标 + 视口微平移；←→ 框间跳转（cluster小跳/跨cluster大跳）

import { useEffect, useCallback, useRef } from 'react'
import { useStore } from 'jotai'
import type { ReactFlowInstance } from '@xyflow/react'
import { focusedSessionIdAtom } from '../atoms/viewport.atom'
import { nodeJumpRequestAtom } from '../atoms/viewport.atom'
import { timelineBySessionAtom, lineInsertionsBySessionAtom, cursorNodeIndexAtom, scrubberIndexAtom } from '../atoms/timeline.atom'
import { sessionRelationsAtom } from '../atoms/sessions.atom'
import { buildJumpableNodes } from '../capabilities/jumpableNodes'
import type { FrameLayout } from './useSessionFrameLayout'
import { resolveHistoryHorizontalTarget } from './historyHorizontalNavigation'

export function useGlobalKeyNav(
  rf: ReactFlowInstance,
  layouts: FrameLayout[],
  focusSession: (sessionId: string) => void,
  canvasContainerRef: React.RefObject<HTMLDivElement | null>,
): void {
  const store = useStore()
  // 记录最近一次 cursor 节点 DOM 的屏幕 Y，用于视口微平移补偿
  const lastCursorScreenYRef = useRef<number | null>(null)

  // ── ←→ 框间导航 ──────────────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // 只在画布容器获焦时响应（防止与输入框冲突）
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const currentId = store.get(focusedSessionIdAtom) ?? layouts[0]?.sessionId
      if (!currentId) return
      const direction = e.key === 'ArrowLeft' ? 'left' : 'right'
      const relations = store.get(sessionRelationsAtom)
      const nextId = resolveHistoryHorizontalTarget(currentId, direction, layouts, relations)
      if (nextId) {
        console.log(`[KeyNav] ←→ ${currentId.slice(0,8)} → ${nextId.slice(0,8)} (${direction})`)
        focusSession(nextId)
      } else {
        console.info(`[KeyNav] boundary current=${currentId.slice(0,8)} direction=${direction} relation=${relations.get(currentId)?.type ?? 'root'}`)
      }
      return
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const focusedId = store.get(focusedSessionIdAtom) ?? layouts[0]?.sessionId
      if (!focusedId) return

      const timelineNodes = store.get(timelineBySessionAtom(focusedId))
      const insertions    = store.get(lineInsertionsBySessionAtom(focusedId))
      const jumpable      = buildJumpableNodes(timelineNodes, insertions)
      if (jumpable.length === 0) return

      const cur  = store.get(cursorNodeIndexAtom(focusedId))
      const next = e.key === 'ArrowDown'
        ? Math.min(cur < 0 ? 0 : cur + 1, jumpable.length - 1)
        : Math.max(cur < 0 ? jumpable.length - 1 : cur - 1, 0)

      const target = jumpable[next]
      if (!target) return

      // 记录当前游标 DOM 位置（用于视口微平移补偿）
      const prevEl = document.querySelector<HTMLElement>(`[data-nodeid="${jumpable[Math.max(0, cur)]?.id}"]`)
      const prevScreenY = prevEl ? prevEl.getBoundingClientRect().top + prevEl.clientHeight / 2 : null
      lastCursorScreenYRef.current = prevScreenY

      store.set(cursorNodeIndexAtom(focusedId), next)
      // 同步更新 scrubberIndexAtom（user_input 维度，供导航条滑块显示）
      const userInputs = timelineNodes.filter((n) => n.type === 'user_input')
      if (target.type === 'user_input') {
        const uiIdx = userInputs.findIndex((n) => n.id === target.id)
        if (uiIdx >= 0) store.set(scrubberIndexAtom(focusedId), uiIdx)
      }
      store.set(nodeJumpRequestAtom, { sessionId: focusedId, nodeId: target.id, ts: Date.now() })
      console.log(`[KeyNav] ↑↓ cursor=${next} nodeId=${target.id.slice(0,8)} type=${target.type}`)

      // 视口微平移：等 scrollTop 更新后（rAF）补偿 ΔY，让游标节点视觉位置相对稳定
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-nodeid="${target.id}"]`)
        if (!el || !canvasContainerRef.current) return
        const canvasRect = canvasContainerRef.current.getBoundingClientRect()
        const newScreenY = el.getBoundingClientRect().top + el.clientHeight / 2
        // 目标：节点中心对齐画布容器中心 Y（视觉上节点保持在视窗中央附近）
        const desiredScreenY = canvasRect.top + canvasRect.height / 2
        const delta = newScreenY - desiredScreenY
        if (Math.abs(delta) < 5) return   // 偏移极小则不调整
        const vp = rf.getViewport()
        rf.setViewport({ ...vp, y: vp.y - delta }, { duration: 100 })
      })
    }
  }, [store, layouts, focusSession, rf, canvasContainerRef])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}
