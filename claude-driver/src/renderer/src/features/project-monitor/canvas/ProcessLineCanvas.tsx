// 使用方法：由 ProjectMonitorPage.tsx 替换原 ProcessTimeline 渲染在右半区域
// 编译说明：renderer 进程 browser bundle
// 代码说明：历史进程线画布——@xyflow/react 容器，内含 SessionFrameNode 自定义 Node
//           管理：session 发现 → Node 创建/布局 → 四态视口状态机 → branch Edge 连线
//           三种情形：1=单框 / 2=/branch继承记忆 / 3=多Session独立并排
//           注意：画布滚动用 panOnScroll=true，缩放改为 Ctrl+滚轮

import React, { useMemo, useCallback, useRef, useEffect, useInsertionEffect, useLayoutEffect } from 'react'
import { pathMatches } from '@renderer/utils/pathUtils'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import { useAtomValue, useAtom, useStore } from 'jotai'
import '@xyflow/react/dist/style.css'

import { activeSessionsAtom, sessionRelationsAtom, agentLabelsAtom } from '../../../atoms/sessions.atom'
import { projectByIdAtom } from '../../../atoms/projects.atom'
import { viewportModeAtom, focusRequestAtom, focusedSessionIdAtom } from '../../../atoms/viewport.atom'
import { nodeYOffsetsAtom, allFrameHeightsAtom } from '../../../atoms/agent-block.atom'
import { useT } from '../../../i18n'
import { useProcessLineViewport } from '../../../hooks/useProcessLineViewport'
import { useSessionFrameLayout, FRAME_WIDTH } from '../../../hooks/useSessionFrameLayout'
import { useHistoryLoader } from '../../../hooks/useHistoryLoader'
import { useGlobalKeyNav } from '../../../hooks/useGlobalKeyNav'
import SessionFrameNode, { type SessionFrameData } from './SessionFrameNode'
import BranchEdge from './BranchEdge'
import GlobalHistoryScrubber from './GlobalHistoryScrubber'
import './ProcessLineCanvas.css'

// ── 节点 / 边类型注册（组件外，避免每次渲染重建引用） ────────────────────────

const nodeTypes: NodeTypes = {
  sessionFrame: SessionFrameNode as NodeTypes[string],
}

const edgeTypes: EdgeTypes = {
  branchEdge: BranchEdge as EdgeTypes[string],
}

// ── Agent 颜色系（与 LeftPanel 一致） ────────────────────────────────────────

const AGENT_COLORS = ['#35C98A', '#5B9BD5', '#DA7756', '#8B6FCB']

interface ProcessLineCanvasProps {
  projectId: string | null
}

// ── 内部组件（需要 ReactFlowProvider 提供上下文后才能用 useReactFlow）─────────

function ProcessLineCanvasInner({ projectId }: ProcessLineCanvasProps): React.JSX.Element {
  const project        = useAtomValue(projectByIdAtom(projectId ?? ''))
  const activeSessions = useAtomValue(activeSessionsAtom)
  const relationsMap   = useAtomValue(sessionRelationsAtom)   // 订阅全局 Map，任意 branch 变化都触发重渲染
  const agentLabels    = useAtomValue(agentLabelsAtom)
  const allHeights     = useAtomValue(allFrameHeightsAtom)    // 订阅全量框高度，任意框高度变化触发布局重算
  const [mode]         = useAtom(viewportModeAtom)
  const [focusRequest, setFocusRequest] = useAtom(focusRequestAtom)
  const store          = useStore()
  const flowRef        = useRef<{ fitView: (opts?: { nodes?: { id: string }[]; padding?: number; duration?: number }) => void } | null>(null)
  const { t }            = useT()
  const rf                = useReactFlow()
  const canvasContainerRef = useRef<HTMLDivElement>(null)

  // ── [DIAG] 渲染/Effect 计数器（DOM 可见，不依赖 console.log）──────────────
  const diagCounters = useRef({ render: 0, insertionEffect: 0, layoutEffect: 0, effect: 0 })
  diagCounters.current.render++
  // 在 render body 中直接打 log（非 hook callback），每轮渲染必定执行
  console.log(`[Canvas][RENDER_BODY] render=#${diagCounters.current.render} mode=${store.get(viewportModeAtom)} focused=${store.get(focusedSessionIdAtom)?.slice(0,8) ?? 'null'} hasRef=${!!canvasContainerRef.current}`)

  useInsertionEffect(() => {
    diagCounters.current.insertionEffect++
    console.log(`[Canvas][INSERTION] #${diagCounters.current.insertionEffect}`)
  })

  useLayoutEffect(() => {
    diagCounters.current.layoutEffect++
    console.log(`[Canvas][LAYOUT_EFFECT] #${diagCounters.current.layoutEffect}`)
  })

  useEffect(() => {
    diagCounters.current.effect++
    console.log(`[Canvas][EFFECT] #${diagCounters.current.effect}`)
  })

  // 历史 session 加载（在 ProcessLineCanvasInner 内调用，生命周期与画布一致）
  useHistoryLoader()

  useEffect(() => { flowRef.current = rf }, [rf])

  // ── 找出属于此项目的所有活跃 session ─────────────────────────────────────
  const projectSessions = useMemo(() => {
    if (!project) return []
    return Array.from(activeSessions.values()).filter(
      (s) => pathMatches(s.cwd, project.path)
    )
  }, [project, activeSessions])

  // Map key 现在是 claudeId；sessionId = claudeId（稳定锚点），用作 node.id 和 atomFamily key
  const sessionIds = useMemo(() => {
    const ids = projectSessions.map((s) => s.claudeId ?? s.id)
    console.log(`[Canvas] projectSessions(${ids.length}):`, projectSessions.map(s => `${s.claudeId?.slice(0,8)} status=${s.status}`))
    console.log(`[Canvas] relationsMap entries:`, Array.from(relationsMap.entries()).map(([k,v]) => `child=${k.slice(0,8)} parent=${v.parentSessionId?.slice(0,8)} side=${v.side} lineLen=${v.lineLength}`))
    return ids
  }, [projectSessions, relationsMap])

  // ── 框高度：优先使用 allFrameHeightsAtom（DOM 实测，驱动 Y 轴时间堆叠布局） ──
  const heightsMap = useMemo(() => {
    const map = new Map<string, number>()
    sessionIds.forEach((id) => {
      map.set(id, allHeights.get(id) ?? 400)
    })
    return map
  }, [sessionIds, allHeights])

  // ── session startedAt 时间戳（Y 轴堆叠排序依据）─────────────────────────
  const startTimesMap = useMemo(() => {
    const map = new Map<string, number>()
    sessionIds.forEach((id) => {
      const s = activeSessions.get(id)
      if (s?.startedAt) map.set(id, s.startedAt)
    })
    return map
  }, [sessionIds, activeSessions])

  // ── 节点精确 Y 偏移（branch 子框 Y + source Handle 定位）────────────────
  // store.get 读取当前快照；nodeYOffsets 变化时 updateNodeInternals 已通知 xyflow 更新 Handle，
  // 布局会在 allHeights 下次变化时用最新 offsets 重算（高频场景足够精确）
  const nodeYOffsetsMap = useMemo(() => {
    const map = new Map<string, number[]>()
    sessionIds.forEach((id) => {
      const offsets = store.get(nodeYOffsetsAtom(id))
      if (offsets.length > 0) map.set(id, offsets)
    })
    return map
  }, [sessionIds, store])

  // ── 布局计算 ──────────────────────────────────────────────────────────────
  const layouts = useSessionFrameLayout(sessionIds, heightsMap, relationsMap, nodeYOffsetsMap, startTimesMap)

  // ── 视口管理 ──────────────────────────────────────────────────────────────
  const { onUserMoveStart, onUserMoveEnd, onEscapeToFollow, focusSession } = useProcessLineViewport(
    flowRef,
    sessionIds
  )

  // ── 全局键盘导航（↑↓游标 + ←→框跳转） ───────────────────────────────────
  useGlobalKeyNav(rf, layouts, focusSession, canvasContainerRef)

  // ── 检测新加入的 session，自动聚焦（新 session = 之前没有、现在有）──────────
  const prevSessionIdsRef = useRef<string[]>([])
  useEffect(() => {
    const prev = prevSessionIdsRef.current
    const added = sessionIds.filter((id) => !prev.includes(id))
    if (added.length > 0 && prev.length > 0) {
      // 有新 session 且不是首次加载（首次不触发跳转，保持 overview）
      const target = added[added.length - 1]
      console.log(`[Canvas] new session detected, focusing: ${target.slice(0,8)}`)
      focusSession(target)
    }
    prevSessionIdsRef.current = sessionIds
  }, [sessionIds, focusSession])

  // ── 响应外部写入的 focusRequest（来自 AgentBlock onSent 等场景）────────────
  // 特殊定位逻辑：zoom 使框宽占满容器 90%，Y 方向使框底部对齐视口从上 3/4 处
  useEffect(() => {
    if (!focusRequest) return
    const { sessionId } = focusRequest
    if (!sessionIds.includes(sessionId)) { setFocusRequest(null); return }

    const layout = layouts.find((l) => l.sessionId === sessionId)
    const container = canvasContainerRef.current
    if (!layout || !container) {
      console.log(`[Canvas] focusRequest fallback fitView: ${sessionId.slice(0,8)}`)
      focusSession(sessionId)
      setFocusRequest(null)
      return
    }

    const containerW = container.clientWidth
    const containerH = container.clientHeight
    const frameH = allHeights.get(sessionId) ?? 400

    // zoom: 框宽占容器 90%
    const zoom = (containerW * 0.9) / FRAME_WIDTH
    // x: 框水平居中
    const vpX = containerW / 2 - (layout.x + FRAME_WIDTH / 2) * zoom
    // y: 框底部落在视口 3/4 处
    const vpY = containerH * 0.75 - (layout.y + frameH) * zoom

    console.log(`[Canvas] focusRequest bottom-align: session=${sessionId.slice(0,8)} zoom=${zoom.toFixed(3)} vpX=${vpX.toFixed(0)} vpY=${vpY.toFixed(0)}`)
    rf.setViewport({ x: vpX, y: vpY, zoom }, { duration: 350 })
    // 锁定视口，防止 mode effect 的 fitView 覆盖此位置
    store.set(viewportModeAtom, 'locked')

    setFocusRequest(null)
  }, [focusRequest, sessionIds, layouts, allHeights, canvasContainerRef, rf, store, focusSession, setFocusRequest])

  // ── [DIAG] 容器尺寸 + 节点/边状态 + 视口位置诊断 ──────────────────────
  // 直接读 store 避免闭包引用未初始化的 const（TDZ 错误）
  useEffect(() => {
    try {
      const el = canvasContainerRef.current
      const currentMode = store.get(viewportModeAtom)
      const currentFocused = store.get(focusedSessionIdAtom)
      const currentSessions = store.get(activeSessionsAtom)
      const currentProj = store.get(projectByIdAtom(projectId ?? ''))
      const projectSessionsCount = currentProj
        ? Array.from(currentSessions.values()).filter(
            (s) => pathMatches(s.cwd, currentProj.path)
          ).length
        : 0
      console.log(`[Canvas][DIAG] render: hasRef=${!!el} projectSessions=${projectSessionsCount} mode=${currentMode} focused=${currentFocused?.slice(0,8) ?? 'null'}`)
      if (!el) return
      const rect = el.getBoundingClientRect()
      const rfVp = rf.getViewport()
      console.log(`[Canvas][DIAG] rect=${rect.width}x${rect.height} vp=(${rfVp.x.toFixed(0)},${rfVp.y.toFixed(0)}) zoom=${rfVp.zoom.toFixed(4)}`)
    } catch (err) {
      console.error(`[Canvas][DIAG] ERROR:`, err)
    }
  })

  // ── orderedSessionIds：按 X 坐标排序，cluster parent 优先（供全局导航条分段）─
  // 必须放在所有早期 return 之前，确保 useMemo 每次渲染都被调用（React Hooks 规则）
  const orderedSessionIds = useMemo(() => {
    const branchSet = new Set(
      Array.from(relationsMap.entries())
        .filter(([, r]) => r.type === 'branch')
        .map(([id]) => id)
    )
    return [...layouts]
      .sort((a, b) => a.x - b.x)
      .filter((l) => !branchSet.has(l.sessionId))
      .map((l) => l.sessionId)
  }, [layouts, relationsMap])

  // ── 构建 ReactFlow Node 列表 ──────────────────────────────────────────────
  const nodes = useMemo<Node[]>(() => {
    return layouts.map(({ sessionId, x, y }, idx) => {
      const session = activeSessions.get(sessionId)
      const data: SessionFrameData = {
        sessionId,
        ptyId: session?.id ?? sessionId,
        agentLabel: agentLabels.get(sessionId) ?? (idx === 0 ? t('projectMonitor.canvas.mainLine') : `Agent${idx + 1}`),
        agentColor: AGENT_COLORS[idx % AGENT_COLORS.length],
        isExpanded: true,
        estimatedHeight: heightsMap.get(sessionId) ?? 400,
      }
      return {
        id: sessionId,
        type: 'sessionFrame',
        position: { x, y },
        data,
        draggable: false,
        selectable: true,
        style: { width: FRAME_WIDTH },
      } as Node
    })
  }, [layouts, heightsMap, activeSessions, agentLabels])

  // ── 构建 branch Edge 列表（情形2）─────────────────────────────────────────
  // sourceHandle/targetHandle 对应 SessionFrameNode 内动态注册的 Handle id
  const edges = useMemo<Edge[]>(() => {
    const result: Edge[] = []
    for (const [childSessionId, rel] of relationsMap) {
      if (rel.type !== 'branch' || !rel.parentSessionId) continue
      result.push({
        id: `branch-${rel.parentSessionId}-${childSessionId}`,
        source: rel.parentSessionId,
        target: childSessionId,
        sourceHandle: `src-${childSessionId}`,   // 父框上精确定位的 source handle
        targetHandle: 'branch-target',            // 子框左/右上角的 target handle
        type: 'branchEdge',
        data: { label: t('projectMonitor.canvas.inheritMemory') },
      } as Edge)
    }
    return result
  }, [relationsMap])

  // ── 情形3：多独立 Session 时的垂直分隔线（CSS absolute，不用 Edge）──────
  // 分隔线位置 = 两相邻独立框中间的画布 X 坐标（在 ReactFlow 外层 overlay div 中渲染）
  const independentLayouts = useMemo(
    () => layouts.filter((l) => {
      const rel = relationsMap.get(l.sessionId)
      return !rel || rel.type !== 'branch'
    }),
    [layouts, relationsMap]
  )

  // ── 键盘事件（仅 Esc，↑↓←→ 由 useGlobalKeyNav 通过 window 事件处理）──────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onEscapeToFollow()
  }, [onEscapeToFollow])

  const handleContainerDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.react-flow__node')) return
    onEscapeToFollow()
  }, [onEscapeToFollow])

  // ── 空态判断（必须在所有 hooks 之后）────────────────────────────────────
  const isEmpty = !projectId || !project || projectSessions.length === 0
  const fitViewOptions = useMemo(() => ({ padding: 0.1 }), [])

  // ── 无项目选中 → 空态提示 ──────────────────────────────────────────────────
  if (!projectId || !project) {
    return (
      <div className="plc-empty">
        <span className="plc-empty-icon">◈</span>
        <span>{t('projectMonitor.canvas.selectProjectAbove')}</span>
      </div>
    )
  }

  return (
    <div
      ref={canvasContainerRef}
      className="plc-container"
      onKeyDown={handleKeyDown}
      onDoubleClick={handleContainerDoubleClick}
      tabIndex={0}
    >
      <ReactFlow
        nodes={isEmpty ? [] : nodes}
        edges={isEmpty ? [] : edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnScroll={true}
        zoomOnScroll={false}
        zoomOnPinch={true}
        panOnDrag={[1, 2]}
        minZoom={0.3}
        maxZoom={3}
        onMoveStart={onUserMoveStart}
        onMoveEnd={onUserMoveEnd}
        proOptions={{ hideAttribution: true }}
        className="plc-flow"
        fitView
        fitViewOptions={fitViewOptions}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#252530"
          style={{ opacity: 0.2 }}
        />

        {/* 情形3：多独立 Session 之间的竖向分隔线（SVG overlay） */}
        {independentLayouts.length > 1 && independentLayouts.slice(0, -1).map((layout) => {
          // 分隔线的 canvas X = 当前框右边缘 + 间距一半
          const dividerX = layout.x + FRAME_WIDTH + 20
          return (
            <div
              key={`divider-${layout.sessionId}`}
              style={{
                position: 'absolute',
                left: dividerX,
                top: 0,
                width: 2,
                height: '100%',
                background: 'rgba(255,255,255,0.07)',
                pointerEvents: 'none',
              }}
            />
          )
        })}
      </ReactFlow>

      {/* 全局历史导航条（最右侧，浏览器滚动条风格） */}
      <GlobalHistoryScrubber
        orderedSessionIds={orderedSessionIds}
        onSessionFocus={focusSession}
      />

      {/* 视口模式指示器 + DIAG 计数器 */}
      <div className={`plc-mode-badge plc-mode-${mode}`} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10 }}>
        <span>{{ overview: t('projectMonitor.canvas.modeOverview'), focus: t('projectMonitor.canvas.modeFocus'), follow: t('projectMonitor.canvas.modeFollow'), locked: t('projectMonitor.canvas.modeLocked') }[mode]}</span>
        <span style={{ opacity: 0.7 }}>R:{diagCounters.current.render} I:{diagCounters.current.insertionEffect} L:{diagCounters.current.layoutEffect} E:{diagCounters.current.effect}</span>
      </div>

      {/* 空态覆盖层（不卸载 ReactFlow，防止 fitView 重新计算） */}
      {isEmpty && (
        <div className="plc-empty-overlay">
          <span className="plc-empty-icon">⏸</span>
          <span>{t('projectMonitor.canvas.noRunningSession')}</span>
          <span className="plc-empty-sub">{t('projectMonitor.canvas.processLineHint')}</span>
        </div>
      )}
    </div>
  )
}

// ── 外层包装：ReactFlowProvider 必须包裹使用 useReactFlow 的组件 ───────────────

function ProcessLineCanvas(props: ProcessLineCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <ProcessLineCanvasInner {...props} />
    </ReactFlowProvider>
  )
}

export default ProcessLineCanvas
