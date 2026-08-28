// 使用方法：在 ProcessLineCanvasInner 内调用；全局 ↑↓ 游标、↑↑/↓↓ 边界相机、←→ 框跳转
// 编译说明：renderer 进程 browser bundle

import { useEffect, useCallback, useRef } from 'react'
import { useStore } from 'jotai'
import type { ReactFlowInstance } from '@xyflow/react'
import { focusedSessionIdAtom, nodeJumpRequestAtom } from '../atoms/viewport.atom'
import { timelineBySessionAtom, lineInsertionsBySessionAtom, cursorNodeIndexAtom, scrubberIndexAtom } from '../atoms/timeline.atom'
import { sessionRelationsAtom } from '../atoms/sessions.atom'
import { buildJumpableNodes } from '../capabilities/jumpableNodes'
import type { FrameLayout } from './useSessionFrameLayout'
import { resolveHistoryHorizontalTarget } from './historyHorizontalNavigation'
import {
  IDLE_ARROW_MULTI_TAP_STATE,
  arrowMultiTapDeadline,
  transitionArrowMultiTap,
  type ArrowMultiTapAction,
  type ArrowMultiTapState,
  type ArrowMultiTapTransition,
  type HistoryFrameEdge,
  type VerticalArrowKey,
} from './historyArrowMultiTap'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
}

export function useGlobalKeyNav(
  rf: ReactFlowInstance,
  layouts: FrameLayout[],
  focusSession: (sessionId: string) => void,
  focusSessionEdge: (sessionId: string, edge: HistoryFrameEdge, source?: string) => void,
  canvasContainerRef: React.RefObject<HTMLDivElement | null>,
  scopeKey: string | null,
): void {
  const store = useStore()
  const multiTapStateRef = useRef<ArrowMultiTapState>(IDLE_ARROW_MULTI_TAP_STATE)
  const multiTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const multiTapTimerElapsedRef = useRef(false)
  const commitTransitionRef = useRef<(transition: ArrowMultiTapTransition) => void>(() => undefined)
  // KeyboardEvent.timeStamp 在不同 Chromium/浏览器实现中可能使用不同时间原点。
  // 首次事件建立与 performance.now() 的偏移，后续用事件发生时刻判断 200ms 窗口。
  const eventTimeOriginOffsetRef = useRef<number | null>(null)

  const getEventTime = useCallback((event: KeyboardEvent): number => {
    const eventTimestamp = event.timeStamp
    if (!Number.isFinite(eventTimestamp) || eventTimestamp <= 0) return performance.now()
    const currentTime = performance.now()
    const offset = eventTimeOriginOffsetRef.current
    if (offset === null) {
      eventTimeOriginOffsetRef.current = currentTime - eventTimestamp
      return currentTime
    }
    const normalized = eventTimestamp + offset
    // 系统时间源切换或测试环境伪造 timestamp 时回退执行时间，避免错误地延长候选。
    if (!Number.isFinite(normalized) || Math.abs(normalized - currentTime) > 60_000) return currentTime
    return normalized
  }, [])

  const moveVertical = useCallback((key: VerticalArrowKey): void => {
    const focusedId = store.get(focusedSessionIdAtom) ?? layouts[0]?.sessionId
    if (!focusedId) return

    const timelineNodes = store.get(timelineBySessionAtom(focusedId))
    const insertions = store.get(lineInsertionsBySessionAtom(focusedId))
    const jumpable = buildJumpableNodes(timelineNodes, insertions)
    if (jumpable.length === 0) return

    const cur = store.get(cursorNodeIndexAtom(focusedId))
    const next = key === 'ArrowDown'
      ? Math.min(cur < 0 ? 0 : cur + 1, jumpable.length - 1)
      : Math.max(cur < 0 ? jumpable.length - 1 : cur - 1, 0)
    const target = jumpable[next]
    if (!target) return

    store.set(cursorNodeIndexAtom(focusedId), next)
    const userInputs = timelineNodes.filter((node) => node.type === 'user_input')
    if (target.type === 'user_input') {
      const userInputIndex = userInputs.findIndex((node) => node.id === target.id)
      if (userInputIndex >= 0) store.set(scrubberIndexAtom(focusedId), userInputIndex)
    }
    store.set(nodeJumpRequestAtom, { sessionId: focusedId, nodeId: target.id, ts: Date.now() })
    console.log(`[KeyNav] ↑↓ cursor=${next} nodeId=${target.id.slice(0, 8)} type=${target.type}`)

    requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(`[data-nodeid="${target.id}"]`)
      const container = canvasContainerRef.current
      if (!element || !container) return
      const canvasRect = container.getBoundingClientRect()
      const newScreenY = element.getBoundingClientRect().top + element.clientHeight / 2
      const desiredScreenY = canvasRect.top + canvasRect.height / 2
      const delta = newScreenY - desiredScreenY
      if (Math.abs(delta) < 5) return
      const viewport = rf.getViewport()
      void rf.setViewport({ ...viewport, y: viewport.y - delta }, { duration: 100 })
    })
  }, [canvasContainerRef, layouts, rf, store])

  const executeActions = useCallback((actions: readonly ArrowMultiTapAction[]): void => {
    for (const action of actions) {
      if (action.type === 'single') {
        moveVertical(action.key)
        continue
      }
      const focusedId = store.get(focusedSessionIdAtom) ?? layouts[0]?.sessionId
      if (!focusedId) {
        console.warn(`[KeyNav] double-tap edge=${action.edge} skipped reason=no-anchor`)
        continue
      }
      console.info(`[KeyNav] double-tap confirmed edge=${action.edge} session=${focusedId.slice(0, 8)}`)
      focusSessionEdge(focusedId, action.edge, 'keyboard-double-tap')
    }
  }, [focusSessionEdge, layouts, moveVertical, store])

  const commitTransition = useCallback((transition: ArrowMultiTapTransition): void => {
    if (multiTapTimerRef.current) {
      clearTimeout(multiTapTimerRef.current)
      multiTapTimerRef.current = null
    }
    multiTapTimerElapsedRef.current = false
    multiTapStateRef.current = transition.state
    executeActions(transition.actions)
    if (transition.reason !== 'repeat' && transition.reason !== 'unmatched-keyup') {
      console.debug(`[KeyNav] multi-tap reason=${transition.reason} phase=${transition.state.phase}`)
    }
    const deadline = arrowMultiTapDeadline(transition.state)
    if (deadline === null) return
    // +1ms 保留规范中的“恰好 200ms 仍有效”边界。
    const delay = Math.max(0, deadline - performance.now() + 1)
    multiTapTimerRef.current = setTimeout(() => {
      multiTapTimerRef.current = null
      // 这是调度兜底而不是物理按键结论：Renderer 忙碌时 keyup 可能已经发生，
      // 但事件回调尚未执行。先标记到期，下一条真实键盘事件再按物理时间裁决。
      multiTapTimerElapsedRef.current = true
      if (multiTapStateRef.current.phase !== 'idle') {
        console.debug(`[KeyNav] multi-tap timer elapsed phase=${multiTapStateRef.current.phase}; awaiting event timestamp`)
      }
    }, delay)
  }, [executeActions])
  useEffect(() => {
    commitTransitionRef.current = commitTransition
  }, [commitTransition])

  const interruptCandidate = useCallback((flushPending: boolean): void => {
    if (multiTapStateRef.current.phase === 'idle') return
    commitTransition(transitionArrowMultiTap(multiTapStateRef.current, {
      type: 'interrupt',
      flushPending,
    }))
  }, [commitTransition])

  const reconcileElapsedTimer = useCallback((now: number): void => {
    if (!multiTapTimerElapsedRef.current) return
    const deadline = arrowMultiTapDeadline(multiTapStateRef.current)
    if (deadline !== null && now > deadline) {
      commitTransition(transitionArrowMultiTap(multiTapStateRef.current, {
        type: 'timeout',
        now,
      }))
    }
  }, [commitTransition])

  const handleKeyDown = useCallback((event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) {
      interruptCandidate(false)
      return
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      interruptCandidate(false)
      event.preventDefault()
      const currentId = store.get(focusedSessionIdAtom) ?? layouts[0]?.sessionId
      if (!currentId) return
      const direction = event.key === 'ArrowLeft' ? 'left' : 'right'
      const relations = store.get(sessionRelationsAtom)
      const nextId = resolveHistoryHorizontalTarget(currentId, direction, layouts, relations)
      if (nextId) {
        console.log(`[KeyNav] ←→ ${currentId.slice(0, 8)} → ${nextId.slice(0, 8)} (${direction})`)
        focusSession(nextId)
      } else {
        console.info(`[KeyNav] boundary current=${currentId.slice(0, 8)} direction=${direction} relation=${relations.get(currentId)?.type ?? 'root'}`)
      }
      return
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const eventTime = getEventTime(event)
      reconcileElapsedTimer(eventTime)
      commitTransition(transitionArrowMultiTap(multiTapStateRef.current, {
        type: 'keydown',
        key: event.key,
        repeat: event.repeat,
        now: eventTime,
      }))
      return
    }

    interruptCandidate(false)
  }, [commitTransition, focusSession, getEventTime, interruptCandidate, layouts, reconcileElapsedTimer, store])

  const handleKeyUp = useCallback((event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) {
      interruptCandidate(false)
      return
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const eventTime = getEventTime(event)
    reconcileElapsedTimer(eventTime)
    commitTransition(transitionArrowMultiTap(multiTapStateRef.current, {
      type: 'keyup',
      key: event.key,
      now: eventTime,
    }))
  }, [commitTransition, getEventTime, interruptCandidate, reconcileElapsedTimer])

  useEffect(() => {
    const handleBlur = (): void => interruptCandidate(false)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [handleKeyDown, handleKeyUp, interruptCandidate])

  useEffect(() => {
    if (multiTapTimerRef.current) clearTimeout(multiTapTimerRef.current)
    multiTapTimerRef.current = null
    multiTapTimerElapsedRef.current = false
    multiTapStateRef.current = IDLE_ARROW_MULTI_TAP_STATE
    console.debug(`[KeyNav] multi-tap reset reason=scope-change scope=${scopeKey ?? 'none'}`)
  }, [scopeKey])

  useEffect(() => () => {
    if (multiTapTimerRef.current) clearTimeout(multiTapTimerRef.current)
    multiTapTimerRef.current = null
    multiTapTimerElapsedRef.current = false
    multiTapStateRef.current = IDLE_ARROW_MULTI_TAP_STATE
  }, [])
}
