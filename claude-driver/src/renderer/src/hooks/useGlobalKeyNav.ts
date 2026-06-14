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
import type { RelationsMap } from './useSessionFrameLayout'

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

  const getNextSessionId = useCallback((currentId: string, direction: 'left' | 'right'): string | null => {
    const relations = store.get(sessionRelationsAtom)

    // 判断当前 session 是 parent 还是 branch
    const ownRel = relations.get(currentId)
    const isBranch = ownRel?.type === 'branch'

    if (isBranch && ownRel?.parentSessionId) {
      const parentId = ownRel.parentSessionId
      const side     = ownRel.side ?? 'right'
      console.log(`[KeyNav] branch nav: id=${currentId.slice(0,8)} side=${side} dir=${direction} parent=${parentId.slice(0,8)}`)
      // 按"向内"方向（朝父框）→ 小跳回父框
      if (direction === 'left' && side === 'right') return parentId
      if (direction === 'right' && side === 'left') return parentId
      // 按"向外"方向（背离父框）→ 直接大跳到相邻 cluster parent
      // 不做 sibling 查找——否则自身会被包含导致返回 self（silent no-op）
      return getAdjacentClusterParent(parentId, direction, layouts, relations)
    }

    // 当前是 parent（cluster 代表）：先小跳到对应方向最近的 branch
    const targetSide = direction === 'right' ? 'right' : 'left'
    const children = Array.from(relations.entries())
      .filter(([, r]) => r.type === 'branch' && r.parentSessionId === currentId && (r.side ?? 'right') === targetSide)
      .sort((a, b) => (a[1].branchIndex ?? 0) - (b[1].branchIndex ?? 0))
    console.log(`[KeyNav] parent nav: id=${currentId.slice(0,8)} dir=${direction} targetSide=${targetSide} children=${children.length}`)
    if (children.length > 0) return children[0][0]  // branchIndex 最小（最近）
    // 无 branch → 大跳到相邻 cluster parent
    return getAdjacentClusterParent(currentId, direction, layouts, relations)
  }, [store, layouts])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // 只在画布容器获焦时响应（防止与输入框冲突）
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const currentId = store.get(focusedSessionIdAtom) ?? layouts[0]?.sessionId
      if (!currentId) return
      const direction = e.key === 'ArrowLeft' ? 'left' : 'right'
      const nextId = getNextSessionId(currentId, direction)
      if (nextId) {
        console.log(`[KeyNav] ←→ ${currentId.slice(0,8)} → ${nextId.slice(0,8)} (${direction})`)
        focusSession(nextId)
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
  }, [store, layouts, getNextSessionId, focusSession, rf, canvasContainerRef])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}

// ── 辅助：找相邻 cluster 的 parent ────────────────────────────────────────────

function getAdjacentClusterParent(
  currentId: string,
  direction: 'left' | 'right',
  layouts: FrameLayout[],
  relations: RelationsMap,
): string | null {
  // 过滤出所有 cluster parent（非 branch 子框）
  const branchChildSet = new Set(
    Array.from(relations.entries())
      .filter(([, r]) => r.type === 'branch')
      .map(([id]) => id)
  )
  const parents = layouts
    .filter((l) => !branchChildSet.has(l.sessionId))
    .sort((a, b) => a.x - b.x)

  const currentIdx = parents.findIndex((l) => l.sessionId === currentId)
  if (currentIdx < 0) return null
  const targetIdx = direction === 'right' ? currentIdx + 1 : currentIdx - 1
  return parents[targetIdx]?.sessionId ?? null
}
