// 使用方法：ProcessLineCanvas 将 ReactFlow、稳定 layouts、框高和容器传入
// 编译说明：renderer 进程 browser bundle
// 代码说明：首屏/新增会话/历史显式导航统一走固定相机；当前实时锚点增长越界时仅纵向跟随

import { useEffect, useRef, useCallback, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { viewportModeAtom, focusedSessionIdAtom } from '../atoms/viewport.atom'
import { activeSessionsAtom } from '../atoms/sessions.atom'
import type { FrameLayout } from './useSessionFrameLayout'
import {
  HISTORY_BOTTOM_FOLLOW_DURATION_MS,
  HISTORY_BOTTOM_CAMERA_DURATION_MS,
  HISTORY_CAMERA_DURATION_MS,
  HISTORY_CAMERA_INTERPOLATE,
  canHistoryCameraOwnerPreempt,
  computeHistoryBottomCameraTarget,
  computeHistoryCameraTarget,
  easeOutCubic,
  evaluateHistoryBottomFollow,
  isHistoryCameraOperationCurrent,
  selectLatestAddedSessionId,
  selectViewingAnchor,
  type AnchorBottomBaseline,
  type HistoryCameraOwner,
  type SessionCameraAnchor,
  type ViewportLike,
} from './historyViewportMath'
import type { HistoryFrameEdge } from './historyArrowMultiTap'
import type { HistoryInteractionPhase, HistoryNavigationDirection } from './historyWorkingSet'

const OVERVIEW_FITVIEW_DELAY_MS = 500

interface FitViewOptions { padding?: number; duration?: number }
interface FlowLike {
  fitView: (options?: FitViewOptions) => void | Promise<unknown>
  getViewport: () => ViewportLike
  setViewport: (
    viewport: ViewportLike,
    options?: {
      duration?: number
      ease?: (progress: number) => number
      interpolate?: 'smooth' | 'linear'
    },
  ) => void | Promise<unknown>
}

interface ViewportControl {
  onUserMoveStart: (event?: MouseEvent | TouchEvent | null) => void
  onUserMoveEnd: (event?: MouseEvent | TouchEvent | null) => void
  onEscapeToFollow: () => void
  focusSession: (sessionId: string) => void
  focusSessionEdge: (sessionId: string, edge: HistoryFrameEdge, source?: string) => void
  unfocusSession: () => void
  cancelNavigation: () => void
  interactionPhase: HistoryInteractionPhase
  targetSessionId: string | null
  navigationDirection: HistoryNavigationDirection
}

export function useProcessLineViewport(
  flowRef: React.MutableRefObject<FlowLike | null>,
  activeSessionIds: string[],
  layouts: FrameLayout[],
  canvasContainerRef: React.RefObject<HTMLDivElement | null>,
  frameHeights: ReadonlyMap<string, number>,
  scopeKey: string | null,
  initialAnchorSessionId: string | null,
  realtimeSessionAnchors: readonly SessionCameraAnchor[],
  onHistoryInteractionBlocked?: (blocked: boolean) => void,
): ViewportControl {
  const [mode, setMode] = useAtom(viewportModeAtom)
  const [focusedId, setFocusedId] = useAtom(focusedSessionIdAtom)
  const activeSessions = useAtomValue(activeSessionsAtom)
  const [interactionPhase, setInteractionPhase] = useState<HistoryInteractionPhase>('idle')
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null)
  const [navigationDirection, setNavigationDirection] = useState<HistoryNavigationDirection>(null)
  const [bottomFollowRevision, setBottomFollowRevision] = useState(0)

  const isProgrammaticRef = useRef(false)
  const fitViewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const programmaticResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animationTokenRef = useRef(0)
  const cameraStartFrameRef = useRef<number | null>(null)
  const autoFocusFrameRef = useRef<number | null>(null)
  const viewportAnimationActiveRef = useRef(false)
  const cameraOwnerRef = useRef<HistoryCameraOwner>('idle')
  const bottomBaselineRef = useRef<AnchorBottomBaseline | null>(null)
  const bottomFollowPendingRef = useRef(false)
  const bottomFollowDecisionRef = useRef<string | null>(null)
  const initialFocusScopeRef = useRef<string | null>(null)
  const knownRealtimeSessionIdsRef = useRef<Set<string>>(new Set())

  const cancelAnimation = useCallback(() => {
    animationTokenRef.current += 1
    if (cameraStartFrameRef.current !== null) {
      cancelAnimationFrame(cameraStartFrameRef.current)
      cameraStartFrameRef.current = null
    }
    const wasActive = viewportAnimationActiveRef.current
    viewportAnimationActiveRef.current = false
    const flow = flowRef.current
    // 空闲时禁止发一次 no-op viewport 事务；它也会触发 React Flow move 生命周期。
    if (wasActive && flow) void flow.setViewport(flow.getViewport(), { duration: 0 })
  }, [flowRef])

  const resetBottomFollowBaseline = useCallback((reason: string): void => {
    const previous = bottomBaselineRef.current
    if (previous) {
      console.debug(
        `[Viewport] bottom-follow baseline reset reason=${reason} session=${previous.sessionId.slice(0, 8)} height=${previous.height.toFixed(1)} armed=${previous.armed}`,
      )
    }
    bottomBaselineRef.current = null
    bottomFollowPendingRef.current = false
    bottomFollowDecisionRef.current = null
  }, [])

  const cancelNavigation = useCallback(() => {
    cameraOwnerRef.current = 'idle'
    resetBottomFollowBaseline('cancel-navigation')
    cancelAnimation()
    isProgrammaticRef.current = false
    setTargetSessionId(null)
    setNavigationDirection(null)
    setInteractionPhase('idle')
    onHistoryInteractionBlocked?.(false)
  }, [cancelAnimation, onHistoryInteractionBlocked, resetBottomFollowBaseline])

  const markProgrammaticFor = useCallback((duration: number) => {
    isProgrammaticRef.current = true
    viewportAnimationActiveRef.current = true
    if (programmaticResetTimerRef.current) clearTimeout(programmaticResetTimerRef.current)
    programmaticResetTimerRef.current = setTimeout(() => {
      isProgrammaticRef.current = false
      viewportAnimationActiveRef.current = false
    }, duration + 80)
  }, [])

  const fitOverviewNow = useCallback((duration = 300) => {
    if (!flowRef.current) return
    markProgrammaticFor(duration)
    void flowRef.current.fitView({ padding: 0.1, duration })
    console.info('[Viewport] auto-fit source=overview ids=all')
  }, [flowRef, markProgrammaticFor])

  const scheduleOverviewFitView = useCallback(() => {
    if (fitViewTimerRef.current) clearTimeout(fitViewTimerRef.current)
    fitViewTimerRef.current = setTimeout(() => fitOverviewNow(), OVERVIEW_FITVIEW_DELAY_MS)
  }, [fitOverviewNow])

  useEffect(() => {
    cameraOwnerRef.current = 'idle'
    resetBottomFollowBaseline('scope-change')
    cancelAnimation()
    if (autoFocusFrameRef.current !== null) {
      cancelAnimationFrame(autoFocusFrameRef.current)
      autoFocusFrameRef.current = null
    }
    onHistoryInteractionBlocked?.(false)
    initialFocusScopeRef.current = null
    knownRealtimeSessionIdsRef.current = new Set()
    // 项目切换后的 React 状态复位放到下一帧，避免 effect 内同步级联 render。
    const frame = requestAnimationFrame(() => {
      setInteractionPhase('idle')
      setTargetSessionId(null)
      setNavigationDirection(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [scopeKey, cancelAnimation, onHistoryInteractionBlocked, resetBottomFollowBaseline])

  useEffect(() => {
    if (mode === 'overview') scheduleOverviewFitView()
    else if (fitViewTimerRef.current) {
      clearTimeout(fitViewTimerRef.current)
      fitViewTimerRef.current = null
    }
  }, [mode, scheduleOverviewFitView])

  useEffect(() => {
    const hasRunning = activeSessionIds.some((id) => activeSessions.get(id)?.status === 'Running')
    if (hasRunning && mode === 'overview') setMode('follow')
    else if (!hasRunning && mode === 'follow') setMode('overview')
  }, [activeSessionIds, activeSessions, mode, setMode])

  const focusSessionEdge = useCallback((sessionId: string, edge: HistoryFrameEdge, source = 'navigation') => {
    const flow = flowRef.current
    const container = canvasContainerRef.current
    const layout = layouts.find((item) => item.sessionId === sessionId)
    if (!flow || !container || !layout || container.clientWidth <= 0 || container.clientHeight <= 0) {
      console.warn(`[Viewport] edge-camera skipped edge=${edge} source=${source} session=${sessionId.slice(0, 8)} reason=missing-geometry flow=${!!flow} container=${!!container} layout=${!!layout}`)
      return
    }
    const frameHeight = edge === 'bottom' ? frameHeights.get(sessionId) : undefined
    if (edge === 'bottom' && frameHeight === undefined) {
      console.warn(`[Viewport] edge-camera skipped edge=bottom source=${source} session=${sessionId.slice(0, 8)} reason=missing-height`)
      return
    }

    // overview 可能已经排队一个 500ms fitView；固定会话相机必须先取消它，
    // 否则迟到 fitView 会在 260ms 动画结束后覆盖确定构图。
    if (fitViewTimerRef.current) {
      clearTimeout(fitViewTimerRef.current)
      fitViewTimerRef.current = null
    }
    const currentLayout = layouts.find((item) => item.sessionId === (targetSessionId ?? focusedId))
    const direction: HistoryNavigationDirection = currentLayout
      ? layout.x < currentLayout.x ? 'left' : layout.x > currentLayout.x ? 'right' : null
      : null
    const previousOwner = cameraOwnerRef.current
    if (!canHistoryCameraOwnerPreempt(previousOwner, 'explicit')) {
      console.debug(
        `[Viewport] edge-camera skipped edge=${edge} source=${source} by owner=${previousOwner} session=${sessionId.slice(0, 8)}`,
      )
      return
    }
    cameraOwnerRef.current = 'explicit'
    resetBottomFollowBaseline(`explicit-${edge}`)
    if (previousOwner === 'bottom-follow') {
      console.info(`[Viewport] camera preempt owner=bottom-follow by=explicit session=${sessionId.slice(0, 8)}`)
    }
    cancelAnimation()
    const token = animationTokenRef.current
    const intentAt = performance.now()
    const viewportSize = { width: container.clientWidth, height: container.clientHeight }
    const targetViewport = edge === 'top'
      ? computeHistoryCameraTarget(layout, viewportSize)
      : computeHistoryBottomCameraTarget(layout, frameHeight!, viewportSize)
    const duration = edge === 'top' ? HISTORY_CAMERA_DURATION_MS : HISTORY_BOTTOM_CAMERA_DURATION_MS
    if (programmaticResetTimerRef.current) {
      clearTimeout(programmaticResetTimerRef.current)
      programmaticResetTimerRef.current = null
    }
    isProgrammaticRef.current = true
    // 必须先取消历史详情/冻结正文提交，再启动 React Flow 相机动画。
    onHistoryInteractionBlocked?.(true)
    setTargetSessionId(sessionId)
    setNavigationDirection(direction)
    setInteractionPhase('animating')
    // 连续按键必须立即把导航基准推进到新目标；相机动画仍从当前真实 viewport 开始。
    setFocusedId(sessionId)
    setMode('focus')

    // 给焦点/工作集状态一个 render frame 先提交，再启动 transform。相比旧版 500ms debounce，
    // 这里最多等待一帧；同时避免 React reconciliation 与相机首帧争用 renderer 主线程。
    cameraStartFrameRef.current = requestAnimationFrame(() => {
      cameraStartFrameRef.current = null
      if (!isHistoryCameraOperationCurrent(cameraOwnerRef.current, animationTokenRef.current, 'explicit', token)) return
      const startViewport = flow.getViewport()
      viewportAnimationActiveRef.current = true
      console.info(
        `[Viewport] edge-camera start token=${token} edge=${edge} source=${source} session=${sessionId.slice(0, 8)} direction=${direction ?? 'same'} interpolate=${HISTORY_CAMERA_INTERPOLATE} prepare=${(performance.now() - intentAt).toFixed(1)}ms distance=${Math.hypot(targetViewport.x - startViewport.x, targetViewport.y - startViewport.y).toFixed(0)}px from=(${startViewport.x.toFixed(0)},${startViewport.y.toFixed(0)},${startViewport.zoom.toFixed(3)}) to=(${targetViewport.x.toFixed(0)},${targetViewport.y.toFixed(0)},${targetViewport.zoom.toFixed(3)})`,
      )

      // 使用 React Flow 内建过渡；不在 React 层逐帧提交 viewport。
      void Promise.resolve(flow.setViewport(targetViewport, {
        duration,
        ease: easeOutCubic,
        interpolate: HISTORY_CAMERA_INTERPOLATE,
      })).then(() => {
        if (!isHistoryCameraOperationCurrent(cameraOwnerRef.current, animationTokenRef.current, 'explicit', token)) return
        viewportAnimationActiveRef.current = false
        setInteractionPhase('settling')
        programmaticResetTimerRef.current = setTimeout(() => {
          if (!isHistoryCameraOperationCurrent(cameraOwnerRef.current, animationTokenRef.current, 'explicit', token)) return
          cameraOwnerRef.current = 'idle'
          isProgrammaticRef.current = false
          setTargetSessionId(null)
          setInteractionPhase('idle')
          onHistoryInteractionBlocked?.(false)
          console.info(`[Viewport] edge-camera settled token=${token} edge=${edge} source=${source} session=${sessionId.slice(0, 8)}`)
        }, 80)
      }).catch((error) => {
        if (!isHistoryCameraOperationCurrent(cameraOwnerRef.current, animationTokenRef.current, 'explicit', token)) return
        cameraOwnerRef.current = 'idle'
        viewportAnimationActiveRef.current = false
        isProgrammaticRef.current = false
        setTargetSessionId(null)
        setInteractionPhase('idle')
        onHistoryInteractionBlocked?.(false)
        console.error(`[Viewport] edge-camera failed token=${token} edge=${edge} source=${source} session=${sessionId.slice(0, 8)}:`, error)
      })
    })
  }, [flowRef, canvasContainerRef, layouts, frameHeights, targetSessionId, focusedId, cancelAnimation, resetBottomFollowBaseline, setFocusedId, setMode, onHistoryInteractionBlocked])

  const focusSession = useCallback((sessionId: string) => {
    focusSessionEdge(sessionId, 'top', 'focus')
  }, [focusSessionEdge])

  const scheduleFixedFocus = useCallback((sessionId: string): void => {
    if (autoFocusFrameRef.current !== null) cancelAnimationFrame(autoFocusFrameRef.current)
    autoFocusFrameRef.current = requestAnimationFrame(() => {
      autoFocusFrameRef.current = null
      focusSession(sessionId)
    })
  }, [focusSession])

  // 项目进入与正式新会话共用唯一固定相机入口：
  // 1) 每个项目作用域只对 latest anchor 执行一次首屏聚焦；
  // 2) 首屏完成后，仅聚焦同一项目实时集合中新出现的最新 sessionId。
  // 空项目首次启动会命中分支 1，不会再被分支 2 重复聚焦。
  useEffect(() => {
    if (!scopeKey) return
    if (initialFocusScopeRef.current !== scopeKey) {
      if (!initialAnchorSessionId) return
      if (!layouts.some((layout) => layout.sessionId === initialAnchorSessionId)) return
      initialFocusScopeRef.current = scopeKey
      knownRealtimeSessionIdsRef.current = new Set(
        realtimeSessionAnchors.map((candidate) => candidate.sessionId),
      )
      console.info(
        `[Viewport] initial latest-session focus scope=${scopeKey} session=${initialAnchorSessionId.slice(0, 8)}`,
      )
      scheduleFixedFocus(initialAnchorSessionId)
      return
    }

    const addedSessionId = selectLatestAddedSessionId(
      knownRealtimeSessionIdsRef.current,
      realtimeSessionAnchors,
    )
    knownRealtimeSessionIdsRef.current = new Set(
      realtimeSessionAnchors.map((candidate) => candidate.sessionId),
    )
    if (!addedSessionId) return
    console.info(`[Viewport] new realtime-session focus session=${addedSessionId.slice(0, 8)}`)
    scheduleFixedFocus(addedSessionId)
  }, [scopeKey, initialAnchorSessionId, realtimeSessionAnchors, layouts, scheduleFixedFocus])

  // 当前 realtime 锚点只在“已可见底部之后继续增长并累计越界”时做 Y-only 跟随。
  // 显式导航/manual 通过同步 cameraOwner ref 抢占，避免 React state 尚未提交时发生竞态。
  useEffect(() => {
    const flow = flowRef.current
    const container = canvasContainerRef.current
    const layout = layouts.find((item) => item.sessionId === focusedId)
    const frameHeight = focusedId ? frameHeights.get(focusedId) : undefined
    const isRealtimeAnchor = focusedId
      ? realtimeSessionAnchors.some((candidate) => candidate.sessionId === focusedId)
      : false

    if (
      !focusedId ||
      mode === 'overview' ||
      !isRealtimeAnchor ||
      !flow ||
      !container ||
      !layout ||
      frameHeight === undefined ||
      container.clientWidth <= 0 ||
      container.clientHeight <= 0
    ) {
      if (bottomBaselineRef.current) resetBottomFollowBaseline('ineligible-anchor')
      return
    }

    if (cameraOwnerRef.current !== 'idle' || interactionPhase !== 'idle') {
      if (cameraOwnerRef.current === 'bottom-follow') bottomFollowPendingRef.current = true
      return
    }

    const evaluation = evaluateHistoryBottomFollow(bottomBaselineRef.current, {
      sessionId: focusedId,
      frameHeight,
      layout,
      viewport: flow.getViewport(),
      viewportSize: {
        width: container.clientWidth,
        height: container.clientHeight,
      },
    })
    bottomBaselineRef.current = evaluation.baseline

    const decisionKey = `${focusedId}:${evaluation.reason}:${evaluation.baseline.armed}`
    if (
      evaluation.reason !== 'baseline' &&
      evaluation.reason !== 'height-reset' &&
      evaluation.reason !== 'follow' &&
      bottomFollowDecisionRef.current !== decisionKey
    ) {
      console.debug(
        `[Viewport] bottom-follow decision session=${focusedId.slice(0, 8)} reason=${evaluation.reason} height=${frameHeight.toFixed(1)} armed=${evaluation.baseline.armed}`,
      )
    }
    bottomFollowDecisionRef.current = decisionKey

    if (evaluation.reason === 'baseline') {
      console.info(
        `[Viewport] bottom-follow baseline session=${focusedId.slice(0, 8)} height=${evaluation.baseline.height.toFixed(1)} armed=${evaluation.baseline.armed}`,
      )
    }
    if (!evaluation.target) return

    cameraOwnerRef.current = 'bottom-follow'
    bottomFollowPendingRef.current = false
    animationTokenRef.current += 1
    const token = animationTokenRef.current
    if (programmaticResetTimerRef.current) {
      clearTimeout(programmaticResetTimerRef.current)
      programmaticResetTimerRef.current = null
    }
    isProgrammaticRef.current = true
    viewportAnimationActiveRef.current = true
    console.info(
      `[Viewport] bottom-follow start token=${token} session=${focusedId.slice(0, 8)} height=${frameHeight.toFixed(1)} overflow=${evaluation.overflowPx.toFixed(1)}px`,
    )

    void Promise.resolve(flow.setViewport(evaluation.target, {
      duration: HISTORY_BOTTOM_FOLLOW_DURATION_MS,
      ease: easeOutCubic,
      interpolate: HISTORY_CAMERA_INTERPOLATE,
    })).then(() => {
      if (!isHistoryCameraOperationCurrent(cameraOwnerRef.current, animationTokenRef.current, 'bottom-follow', token)) return
      const hadPendingGrowth = bottomFollowPendingRef.current
      cameraOwnerRef.current = 'idle'
      bottomFollowPendingRef.current = false
      viewportAnimationActiveRef.current = false
      isProgrammaticRef.current = false
      console.info(
        `[Viewport] bottom-follow settled token=${token} session=${focusedId.slice(0, 8)} pending=${hadPendingGrowth}`,
      )
      setBottomFollowRevision((revision) => revision + 1)
    }).catch((error) => {
      if (!isHistoryCameraOperationCurrent(cameraOwnerRef.current, animationTokenRef.current, 'bottom-follow', token)) return
      cameraOwnerRef.current = 'idle'
      bottomFollowPendingRef.current = false
      viewportAnimationActiveRef.current = false
      isProgrammaticRef.current = false
      console.error(`[Viewport] bottom-follow failed token=${token} session=${focusedId.slice(0, 8)}:`, error)
      setBottomFollowRevision((revision) => revision + 1)
    })
  }, [
    bottomFollowRevision,
    canvasContainerRef,
    flowRef,
    focusedId,
    frameHeights,
    interactionPhase,
    layouts,
    mode,
    realtimeSessionAnchors,
    resetBottomFollowBaseline,
  ])

  const onUserMoveStart = useCallback((event?: MouseEvent | TouchEvent | null) => {
    if (isProgrammaticRef.current && !event) return
    const previousOwner = cameraOwnerRef.current
    cameraOwnerRef.current = 'manual'
    resetBottomFollowBaseline('manual-move')
    if (previousOwner === 'bottom-follow') {
      console.info('[Viewport] camera preempt owner=bottom-follow by=manual')
    }
    cancelAnimation()
    isProgrammaticRef.current = false
    onHistoryInteractionBlocked?.(true)
    setTargetSessionId(null)
    setInteractionPhase('manual')
    if (mode !== 'locked') setMode('locked')
    console.debug('[Viewport] manual move start')
  }, [cancelAnimation, mode, setMode, onHistoryInteractionBlocked, resetBottomFollowBaseline])

  const onUserMoveEnd = useCallback((event?: MouseEvent | TouchEvent | null) => {
    if (isProgrammaticRef.current && !event) return
    const flow = flowRef.current
    const container = canvasContainerRef.current
    if (!flow || !container) return
    const anchor = selectViewingAnchor(
      layouts,
      flow.getViewport(),
      { width: container.clientWidth, height: container.clientHeight },
      frameHeights,
    )
    if (anchor) setFocusedId(anchor)
    setInteractionPhase('settling')
    requestAnimationFrame(() => {
      cameraOwnerRef.current = 'idle'
      setInteractionPhase('idle')
      onHistoryInteractionBlocked?.(false)
    })
    console.info(`[Viewport] manual move end anchor=${anchor?.slice(0, 8) ?? 'none'}`)
  }, [flowRef, canvasContainerRef, layouts, frameHeights, setFocusedId, onHistoryInteractionBlocked])

  const onEscapeToFollow = useCallback(() => {
    cancelNavigation()
    setMode('follow')
  }, [cancelNavigation, setMode])

  const unfocusSession = useCallback(() => {
    cameraOwnerRef.current = 'idle'
    resetBottomFollowBaseline('unfocus')
    cancelAnimation()
    setFocusedId(null)
    setMode('overview')
  }, [cancelAnimation, resetBottomFollowBaseline, setFocusedId, setMode])

  useEffect(() => () => {
    cameraOwnerRef.current = 'idle'
    resetBottomFollowBaseline('unmount')
    cancelAnimation()
    if (autoFocusFrameRef.current !== null) cancelAnimationFrame(autoFocusFrameRef.current)
    onHistoryInteractionBlocked?.(false)
    if (fitViewTimerRef.current) clearTimeout(fitViewTimerRef.current)
    if (programmaticResetTimerRef.current) clearTimeout(programmaticResetTimerRef.current)
  }, [cancelAnimation, onHistoryInteractionBlocked, resetBottomFollowBaseline])

  return {
    onUserMoveStart,
    onUserMoveEnd,
    onEscapeToFollow,
    focusSession,
    focusSessionEdge,
    unfocusSession,
    cancelNavigation,
    interactionPhase,
    targetSessionId,
    navigationDirection,
  }
}
