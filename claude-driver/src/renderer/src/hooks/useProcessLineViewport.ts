// 使用方法：在 ProcessLineCanvas.tsx 中使用：const viewport = useProcessLineViewport(reactFlowInstance)
// 编译说明：renderer 进程 browser bundle
// 代码说明：进程线画布四态视口管理 Hook——overview/focus/follow/locked 状态机
//           overview: fitView 所有框；focus: fitView 指定框；follow: 实时追踪；locked: 用户手动拖拽后停止自动化

import { useEffect, useRef, useCallback } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { viewportModeAtom, focusedSessionIdAtom } from '../atoms/viewport.atom'
import { activeSessionsAtom } from '../atoms/sessions.atom'

const FITVIEW_THROTTLE_MS = 500

/** fitView 方法签名（与 @xyflow/react useReactFlow().fitView 一致） */
interface FitViewOptions { nodes?: { id: string }[]; padding?: number; duration?: number }
interface FlowLike { fitView: (options?: FitViewOptions) => void }

interface ViewportControl {
  /** 通知用户开始手动拖拽（在 onMoveStart 中调用） */
  onUserMoveStart: () => void
  /** 通知用户停止手动拖拽（在 onMoveEnd 中调用） */
  onUserMoveEnd: () => void
  /** 按 Esc 或双击空白时调用，恢复 follow 模式 */
  onEscapeToFollow: () => void
  /** 展开某个 session 框时调用，切换到 focus 模式 */
  focusSession: (sessionId: string) => void
  /** 折叠 session 框时调用，恢复 overview 模式 */
  unfocusSession: () => void
  /** 通知有新节点插入（follow 模式下触发视口跟随） */
  onNewNodeInserted: (sessionId: string, nodeY: number) => void
}

export function useProcessLineViewport(
  flowRef: React.MutableRefObject<FlowLike | null>,
  activeSessionIds: string[]
): ViewportControl {
  const [mode, setMode] = useAtom(viewportModeAtom)
  const [focusedId, setFocusedId] = useAtom(focusedSessionIdAtom)
  const activeSessions = useAtomValue(activeSessionsAtom)

  // 区分"程序化"移动 vs 用户手动拖拽——防止 fitView 触发 onMoveStart 误切 locked
  const isProgrammaticRef = useRef(false)
  // fitView 节流 timer
  const fitViewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── fitView 节流调用 ──────────────────────────────────────────────────────
  const throttledFitView = useCallback((nodeIds?: string[]) => {
    console.log(`[Viewport][DIAG] throttledFitView called: nodeIds=[${nodeIds?.map(id => id.slice(0,8)).join(',') ?? 'ALL'}] flowRef=${!!flowRef.current} timerActive=${!!fitViewTimerRef.current}`)
    if (fitViewTimerRef.current) clearTimeout(fitViewTimerRef.current)
    fitViewTimerRef.current = setTimeout(() => {
      console.log(`[Viewport][DIAG] throttledFitView EXEC: nodeIds=[${nodeIds?.map(id => id.slice(0,8)).join(',') ?? 'ALL'}] flowRef=${!!flowRef.current}`)
      if (!flowRef.current) { console.warn('[Viewport][DIAG] throttledFitView ABORT: flowRef.current is null!'); return }
      isProgrammaticRef.current = true
      if (nodeIds && nodeIds.length > 0) {
        flowRef.current.fitView({ nodes: nodeIds.map((id) => ({ id })), padding: 0.05, duration: 300 })
      } else {
        flowRef.current.fitView({ padding: 0.1, duration: 300 })
      }
      console.log(`[Viewport][DIAG] fitView() call completed`)
      // 给动画时间结束后重置标志
      setTimeout(() => { isProgrammaticRef.current = false }, 400)
    }, FITVIEW_THROTTLE_MS)
  }, [flowRef])

  // ── 模式响应：mode 变化时触发对应视口调整 ────────────────────────────────
  useEffect(() => {
    console.log(`[Viewport][DIAG] modeEffect: mode=${mode} focusedId=${focusedId?.slice(0,8) ?? 'null'} flowRef=${!!flowRef.current}`)
    if (!flowRef.current) { console.warn('[Viewport][DIAG] modeEffect ABORT: flowRef.current is null!'); return }
    if (mode === 'overview') {
      console.log('[Viewport][DIAG] modeEffect → throttledFitView(ALL)')
      throttledFitView()
    } else if (mode === 'focus' && focusedId) {
      console.log(`[Viewport][DIAG] modeEffect → throttledFitView([${focusedId.slice(0,8)}])`)
      throttledFitView([focusedId])
    }
    // follow 模式的视口更新在 onNewNodeInserted 中处理
    // locked 模式不做任何自动调整
  }, [mode, focusedId, throttledFitView, flowRef])

  // ── 自动切换 follow 模式：有活跃 session 时 ──────────────────────────────
  useEffect(() => {
    const hasRunning = activeSessionIds.some((id) => {
      const s = activeSessions.get(id)
      return s?.status === 'Running'
    })
    if (hasRunning && (mode === 'overview')) {
      setMode('follow')
    } else if (!hasRunning && mode === 'follow') {
      setMode('overview')
    }
  }, [activeSessionIds, activeSessions, mode, setMode])

  // ── 暴露给外部的控制函数 ─────────────────────────────────────────────────
  const onUserMoveStart = useCallback(() => {
    if (isProgrammaticRef.current) return
    if (mode !== 'locked') {
      setMode('locked')
    }
  }, [mode, setMode])

  const onUserMoveEnd = useCallback(() => {
    // 不在 moveEnd 恢复——用户明确操作后保持 locked，等待 Esc/双击
  }, [])

  const onEscapeToFollow = useCallback(() => {
    setMode('follow')
  }, [setMode])

  const focusSession = useCallback((sessionId: string) => {
    setFocusedId(sessionId)
    setMode('focus')
  }, [setFocusedId, setMode])

  const unfocusSession = useCallback(() => {
    setFocusedId(null)
    setMode('overview')
  }, [setFocusedId, setMode])

  const onNewNodeInserted = useCallback((sessionId: string, _nodeY: number) => {
    if (mode !== 'follow') return
    // follow 模式：fitView 到活跃 session 框
    throttledFitView([sessionId])
  }, [mode, throttledFitView])

  return { onUserMoveStart, onUserMoveEnd, onEscapeToFollow, focusSession, unfocusSession, onNewNodeInserted }
}
