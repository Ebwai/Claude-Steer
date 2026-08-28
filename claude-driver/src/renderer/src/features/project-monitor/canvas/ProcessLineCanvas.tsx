// 使用方法：由 ProjectMonitorPage.tsx 替换原 ProcessTimeline 渲染在右半区域
// 编译说明：renderer 进程 browser bundle
// 代码说明：历史进程线画布——@xyflow/react 容器，内含 SessionFrameNode 自定义 Node
//           管理：session 发现 → Node 创建/布局 → 四态视口状态机 → branch Edge 连线
//           三种情形：1=单框 / 2=/branch继承记忆 / 3=多Session独立并排
//           注意：画布滚动用 panOnScroll=true，缩放改为 Ctrl+滚轮

import React, { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import { pathMatches } from '@renderer/utils/pathUtils'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type ReactFlowInstance,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import { useAtomValue, useAtom, useStore } from 'jotai'
import '@xyflow/react/dist/style.css'
import type { Session, HistoryDeleteInput, HistoryDeleteResult } from '@shared/types/index'
import { IPC } from '@shared/events/ipc-channels'

import { activeSessionsAtom, sessionRelationsAtom, agentLabelsAtom } from '../../../atoms/sessions.atom'
import { projectByIdAtom } from '../../../atoms/projects.atom'
import { viewportModeAtom, focusRequestAtom, focusedSessionIdAtom } from '../../../atoms/viewport.atom'
import { nodeYOffsetsAtom, allFrameHeightsAtom } from '../../../atoms/agent-block.atom'
import { historyDeleteStatesAtom, historyProjectsAtom } from '../../../atoms/history.atom'
import { useT } from '../../../i18n'
import { useProcessLineViewport } from '../../../hooks/useProcessLineViewport'
import { selectLatestSessionId } from '../../../hooks/historyViewportMath'
import { useSessionFrameLayout, FRAME_WIDTH } from '../../../hooks/useSessionFrameLayout'
import { useHistoryLoader } from '../../../hooks/useHistoryLoader'
import { useHistoryWorkingSet } from '../../../hooks/useHistoryWorkingSet'
import {
  createHistoryLayoutMeasurementGate,
  setHistoryLayoutMeasurementBlocked,
} from '../../../hooks/historyLayoutMeasurementGate'
import { useGlobalKeyNav } from '../../../hooks/useGlobalKeyNav'
import {
  beginHistoryDelete,
  commitHistoryDelete,
  failHistoryDelete,
} from '../../../capabilities/historyCapability'
import Modal from '../../../components/Modal/Modal'
import SessionFrameNode, { type SessionFrameData } from './SessionFrameNode'
import BranchEdge from './BranchEdge'
import GlobalHistoryDotNavigator from './GlobalHistoryDotNavigator'
import { selectOrderedMainSessionIds } from './historyDotNavigation'
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
const EMPTY_DETAILS_STATES = new Map<string, 'shell' | 'hydrating' | 'resident' | 'error'>()

interface ProcessLineCanvasProps {
  projectId: string | null
}

interface CanvasSessionView {
  session: Session
  source: 'realtime' | 'history'
  clusterId: string
  detailsState: 'shell' | 'hydrating' | 'resident' | 'error'
}

interface DeleteDialogTarget {
  sessionId: string
  scope: 'cluster' | 'branch'
  branchCount: number
  descendantCount: number
}

// ── 内部组件（需要 ReactFlowProvider 提供上下文后才能用 useReactFlow）─────────

function ProcessLineCanvasInner({ projectId }: ProcessLineCanvasProps): React.JSX.Element {
  const project        = useAtomValue(projectByIdAtom(projectId ?? ''))
  const activeSessions = useAtomValue(activeSessionsAtom)
  const relationsMap   = useAtomValue(sessionRelationsAtom)   // 订阅全局 Map，任意 branch 变化都触发重渲染
  const historyProjects = useAtomValue(historyProjectsAtom)
  const historyState    = projectId ? historyProjects.get(projectId) : undefined
  const deleteStates    = useAtomValue(historyDeleteStatesAtom)
  const agentLabels    = useAtomValue(agentLabelsAtom)
  const allHeights     = useAtomValue(allFrameHeightsAtom)    // 订阅全量框高度，任意框高度变化触发布局重算
  const [mode]         = useAtom(viewportModeAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)
  const [focusRequest, setFocusRequest] = useAtom(focusRequestAtom)
  const store          = useStore()
  const flowRef        = useRef<ReactFlowInstance | null>(null)
  const { t }            = useT()
  const rf                = useReactFlow()
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteDialogTarget | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [historyNotice, setHistoryNotice] = useState<string | null>(null)
  const layoutMeasurementGate = useMemo(() => createHistoryLayoutMeasurementGate(), [])

  // 历史 session 加载（在 ProcessLineCanvasInner 内调用，生命周期与画布一致）
  const historyLoader = useHistoryLoader(projectId)
  const setHistoryInteractionBlocked = useCallback((blocked: boolean): void => {
    // 冻结时 gate 先关；解冻时先冲刷动画期积累的最新高度，再允许详情/目录继续提交。
    setHistoryLayoutMeasurementBlocked(layoutMeasurementGate, blocked)
    historyLoader.setInteractionBlocked(blocked)
  }, [historyLoader, layoutMeasurementGate])

  useEffect(() => { flowRef.current = rf }, [rf])

  // ── 找出属于此项目的所有活跃 session ─────────────────────────────────────
  const projectSessions = useMemo<CanvasSessionView[]>(() => {
    if (!project) return []
    const byId = new Map<string, CanvasSessionView>()
    for (const cluster of historyState?.clusters ?? []) {
      const detailsState = historyState?.detailsStateByCluster.get(cluster.clusterId) ?? 'shell'
      for (const entry of cluster.sessions) {
        byId.set(entry.sessionId, {
          session: {
            id: entry.sessionId,
            claudeId: entry.sessionId,
            projectId: project.id,
            status: 'Completed',
            currentModel: null,
            tokenUsage: { current: null, max: null, usedPercentage: null },
            transcriptPath: null,
            cwd: entry.cwd,
            startedAt: entry.startedAt,
            endedAt: entry.endedAt,
            worktreePath: null,
          },
          source: 'history',
          clusterId: cluster.clusterId,
          detailsState,
        })
      }
    }
    for (const session of activeSessions.values()) {
      if (!pathMatches(session.cwd, project.path)) continue
      // 早期 PTY_BIND 的临时会话只负责让实时面板立即可输入；它没有真实 Claude UUID，
      // 不能成为历史节点。SessionStart/真实 PTY_BIND 会把它原子迁移为正式会话。
      if (session.isPtyPlaceholder) continue
      const sessionId = session.claudeId ?? session.id
      const historyView = byId.get(sessionId)
      const isRealtime = session.status === 'Running' || session.status === 'Paused'
      byId.set(sessionId, {
        session,
        source: isRealtime || !historyView ? 'realtime' : 'history',
        clusterId: historyView?.clusterId ?? sessionId,
        detailsState: isRealtime || !historyView ? 'resident' : historyView.detailsState,
      })
    }
    return Array.from(byId.values()).sort(
      (a, b) => a.session.startedAt - b.session.startedAt || (a.session.claudeId ?? a.session.id).localeCompare(b.session.claudeId ?? b.session.id),
    )
  }, [project, activeSessions, historyState])

  // Map key 现在是 claudeId；sessionId = claudeId（稳定锚点），用作 node.id 和 atomFamily key
  const sessionIds = useMemo(() => {
    const ids = projectSessions.map(({ session }) => session.claudeId ?? session.id)
    console.debug(`[Canvas] shells=${ids.length} relations=${relationsMap.size}`)
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
      const view = projectSessions.find(({ session }) => (session.claudeId ?? session.id) === id)
      if (view?.session.startedAt) map.set(id, view.session.startedAt)
    })
    return map
  }, [sessionIds, projectSessions])

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
  }, [sessionIds, store, historyState?.detailsStateByCluster])

  // ── 布局计算 ──────────────────────────────────────────────────────────────
  const layouts = useSessionFrameLayout(sessionIds, heightsMap, relationsMap, nodeYOffsetsMap, startTimesMap)

  const latestSessionId = useMemo(
    () => selectLatestSessionId(projectSessions.map(({ session }) => ({
      sessionId: session.claudeId ?? session.id,
      startedAt: session.startedAt,
    }))),
    [projectSessions],
  )
  const realtimeSessionAnchors = useMemo(
    () => projectSessions
      .filter((view) => view.source === 'realtime')
      .map(({ session }) => ({
        sessionId: session.claudeId ?? session.id,
        startedAt: session.startedAt,
      })),
    [projectSessions],
  )

  // ── 视口管理 ──────────────────────────────────────────────────────────────
  const {
    onUserMoveStart,
    onUserMoveEnd,
    onEscapeToFollow,
    focusSession,
    focusSessionEdge,
    cancelNavigation,
    interactionPhase,
    targetSessionId,
    navigationDirection,
  } = useProcessLineViewport(
    flowRef,
    sessionIds,
    layouts,
    canvasContainerRef,
    allHeights,
    projectId,
    latestSessionId,
    realtimeSessionAnchors,
    setHistoryInteractionBlocked,
  )

  const realtimeClusterIds = useMemo(
    () => new Set(projectSessions.filter((view) => view.source === 'realtime').map((view) => view.clusterId)),
    [projectSessions],
  )
  useHistoryWorkingSet({
    clusters: historyState?.clusters ?? [],
    detailsStateByCluster: historyState?.detailsStateByCluster ?? EMPTY_DETAILS_STATES,
    anchorSessionId: focusedSessionId,
    targetSessionId,
    realtimeClusterIds,
    direction: navigationDirection,
    interactionPhase,
    loader: historyLoader,
  })

  // ── 全局键盘导航（↑↓游标 + ←→框跳转） ───────────────────────────────────
  useGlobalKeyNav(rf, layouts, focusSession, focusSessionEdge, canvasContainerRef, projectId)

  // ── 响应外部写入的 focusRequest（来自 AgentBlock onSent 等场景）────────────
  // 与 ↓↓ 共用统一 explicit 相机事务：既有 90% 宽度、框底位于视口 3/4 的构图。
  useEffect(() => {
    if (!focusRequest) return
    const { sessionId } = focusRequest
    if (!sessionIds.includes(sessionId)) { setFocusRequest(null); return }

    focusSessionEdge(sessionId, 'bottom', 'message-sent')
    setFocusRequest(null)
  }, [focusRequest, sessionIds, focusSessionEdge, setFocusRequest])

  // ── orderedMainSessionIds：按 X 坐标稳定排序，只供全局主线点导航 ────────────
  // 必须放在所有早期 return 之前，确保 useMemo 每次渲染都被调用（React Hooks 规则）
  const orderedMainSessionIds = useMemo(
    () => selectOrderedMainSessionIds(layouts, relationsMap),
    [layouts, relationsMap],
  )

  const sessionViewById = useMemo(
    () => new Map(projectSessions.map((view) => [view.session.claudeId ?? view.session.id, view])),
    [projectSessions],
  )

  const handleRequestDelete = useCallback((sessionId: string) => {
    const view = sessionViewById.get(sessionId)
    if (!view || view.source !== 'history' || !historyState) return
    const isBranch = relationsMap.get(sessionId)?.type === 'branch'
    const cluster = historyState.clusters.find((item) => item.clusterId === view.clusterId)
    const childrenByParent = new Map<string, string[]>()
    for (const entry of cluster?.sessions ?? []) {
      if (!entry.parentSessionId) continue
      const children = childrenByParent.get(entry.parentSessionId) ?? []
      children.push(entry.sessionId)
      childrenByParent.set(entry.parentSessionId, children)
    }
    let descendantCount = 0
    const queue = [...(childrenByParent.get(sessionId) ?? [])]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const childId = queue.shift()!
      if (visited.has(childId)) continue
      visited.add(childId)
      descendantCount += 1
      queue.push(...(childrenByParent.get(childId) ?? []))
    }
    setDeleteError(null)
    setDeleteTarget({
      sessionId,
      scope: isBranch ? 'branch' : 'cluster',
      branchCount: Math.max(0, (cluster?.sessions.length ?? 1) - 1),
      descendantCount,
    })
  }, [historyState, relationsMap, sessionViewById])

  // ── 构建 ReactFlow Node 列表 ──────────────────────────────────────────────
  const nodes = useMemo<Node[]>(() => {
    return layouts.map(({ sessionId, x, y }, idx) => {
      const view = sessionViewById.get(sessionId)
      if (!view) return null
      const { session, source, clusterId, detailsState } = view
      const relation = relationsMap.get(sessionId)
      const historyLabel = relation?.type === 'branch'
        ? `历史 Branch${(relation.branchIndex ?? 1) > 1 ? relation.branchIndex : ''}`
        : t('projectMonitor.canvas.historyMainLine')
      const deleting = deleteStates.get(sessionId)?.status === 'deleting'
      const data: SessionFrameData = {
        projectId: projectId ?? '',
        sessionId,
        ptyId: source === 'realtime' ? session.id : undefined,
        session,
        source,
        detailsState,
        clusterId,
        deleteDisabled: session.status === 'Running' || session.status === 'Paused',
        isDeleting: deleting,
        layoutMeasurementGate,
        onRequestDelete: handleRequestDelete,
        onFocusBottom: (targetSessionId) =>
          focusSessionEdge(targetSessionId, 'bottom', 'header-bottom-button'),
        agentLabel: agentLabels.get(sessionId) ?? (source === 'history' ? historyLabel : idx === 0 ? t('projectMonitor.canvas.mainLine') : `Agent${idx + 1}`),
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
    }).filter((node): node is Node => node !== null)
  }, [layouts, heightsMap, sessionViewById, relationsMap, deleteStates, handleRequestDelete, layoutMeasurementGate, agentLabels, projectId, focusSessionEdge, t])

  // ── 构建 branch Edge 列表（情形2）─────────────────────────────────────────
  // sourceHandle/targetHandle 对应 SessionFrameNode 内动态注册的 Handle id
  const edges = useMemo<Edge[]>(() => {
    const result: Edge[] = []
    const nodeIds = new Set(nodes.map((node) => node.id))
    for (const [childSessionId, rel] of relationsMap) {
      if (rel.type !== 'branch' || !rel.parentSessionId) continue
      if (!nodeIds.has(rel.parentSessionId) || !nodeIds.has(childSessionId)) continue
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
  }, [relationsMap, nodes, t])

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

  const handleNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    const target = event.target as HTMLElement
    if (!target.closest('.sfn-header') || target.closest('button, input, textarea, select, a')) return
    focusSession(node.id)
  }, [focusSession])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || !projectId || !project) return
    const currentHistory = store.get(historyProjectsAtom).get(projectId)
    if (!currentHistory) return
    const input: HistoryDeleteInput = {
      projectId,
      projectPath: project.path,
      targetSessionId: deleteTarget.sessionId,
      scope: deleteTarget.scope,
      expectedGeneration: currentHistory.generation,
      operationId: crypto.randomUUID(),
    }
    // 删除必须先停止当前相机事务，再取消全部详情投影，防止旧结果复活被删框。
    cancelNavigation()
    setHistoryInteractionBlocked(true)
    beginHistoryDelete(store, input)
    setDeleteError(null)
    try {
      const result = await window.api.invoke(IPC.HISTORY_DELETE, input) as HistoryDeleteResult
      if (!result.ok) {
        failHistoryDelete(store, input, result)
        const key = result.errorCode === 'HISTORY_SESSION_RUNNING'
          ? 'projectMonitor.canvas.historyDeleteRunning'
          : result.errorCode === 'HISTORY_IO_LOCKED'
            ? 'projectMonitor.canvas.historyDeleteLocked'
            : result.errorCode === 'HISTORY_RELATION_CHANGED'
              ? 'projectMonitor.canvas.historyDeleteChanged'
              : 'projectMonitor.canvas.historyDeleteFailed'
        setDeleteError(t(key))
        setHistoryInteractionBlocked(false)
        console.error(`[Canvas] history delete failed operation=${input.operationId} code=${result.errorCode}: ${result.error}`)
        return
      }
      const outcome = commitHistoryDelete(store, projectId, result, store.get(focusedSessionIdAtom))
      setDeleteTarget(null)
      if (outcome.focusWasDeleted) {
        store.set(focusedSessionIdAtom, outcome.focusFallbackSessionId)
      }
      setHistoryInteractionBlocked(false)
      if (outcome.focusWasDeleted && outcome.focusFallbackSessionId) {
        requestAnimationFrame(() => focusSession(outcome.focusFallbackSessionId!))
      }
      if (result.cleanupPending) setHistoryNotice(t('projectMonitor.canvas.historyDeleteCleanupPending'))
      console.info(`[Canvas] history delete committed operation=${input.operationId} sessions=${result.deletedSessionIds.length}`)
    } catch (error) {
      const failed: Extract<HistoryDeleteResult, { ok: false }> = {
        ok: false,
        operationId: input.operationId,
        errorCode: 'HISTORY_IO_ERROR',
        error: String(error),
      }
      failHistoryDelete(store, input, failed)
      setHistoryInteractionBlocked(false)
      setDeleteError(t('projectMonitor.canvas.historyDeleteFailed'))
      console.error(`[Canvas] history delete invoke failed operation=${input.operationId}:`, error)
    }
  }, [cancelNavigation, deleteTarget, focusSession, historyLoader, projectId, project, setHistoryInteractionBlocked, store, t])

  useEffect(() => {
    if (!historyNotice) return
    const timer = window.setTimeout(() => setHistoryNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [historyNotice])

  // ── 空态判断（必须在所有 hooks 之后）────────────────────────────────────
  const isEmpty = !projectId || !project || projectSessions.length === 0

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
        minZoom={0.1}
        maxZoom={3}
        onMoveStart={onUserMoveStart}
        onMoveEnd={onUserMoveEnd}
        onNodeClick={handleNodeClick}
        proOptions={{ hideAttribution: true }}
        className="plc-flow"
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

      <Modal
        open={deleteTarget !== null}
        onClose={() => {
          const deleting = deleteTarget ? deleteStates.get(deleteTarget.sessionId)?.status === 'deleting' : false
          if (!deleting) {
            setDeleteTarget(null)
            setDeleteError(null)
          }
        }}
        title={deleteTarget?.scope === 'branch'
          ? t('projectMonitor.canvas.historyDeleteBranchTitle')
          : t('projectMonitor.canvas.historyDeleteMainTitle')}
        width={460}
        showClose={deleteTarget ? deleteStates.get(deleteTarget.sessionId)?.status !== 'deleting' : true}
      >
        {deleteTarget && (
          <div className="plc-history-delete-dialog">
            <p>
              {deleteTarget.scope === 'branch'
                ? t('projectMonitor.canvas.historyDeleteBranchDescription', { descendantCount: deleteTarget.descendantCount })
                : t('projectMonitor.canvas.historyDeleteMainDescription', { branchCount: deleteTarget.branchCount })}
            </p>
            {deleteError && <div className="plc-history-delete-error">{deleteError}</div>}
            <div className="plc-history-delete-actions">
              <button
                type="button"
                className="plc-history-delete-cancel"
                disabled={deleteStates.get(deleteTarget.sessionId)?.status === 'deleting'}
                onClick={() => { setDeleteTarget(null); setDeleteError(null) }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="plc-history-delete-confirm"
                disabled={deleteStates.get(deleteTarget.sessionId)?.status === 'deleting'}
                onClick={() => { void handleConfirmDelete() }}
              >
                {deleteStates.get(deleteTarget.sessionId)?.status === 'deleting'
                  ? t('projectMonitor.canvas.historyDeleting')
                  : t('projectMonitor.canvas.historyDeleteConfirm')}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {historyNotice && <div className="plc-history-notice">{historyNotice}</div>}

      {/* 全局主线 Agent 点导航（最右侧，Branch/Subagent 不占点） */}
      <GlobalHistoryDotNavigator
        orderedMainSessionIds={orderedMainSessionIds}
        focusedSessionId={focusedSessionId}
        onSessionFocus={focusSession}
      />

      {/* 视口模式指示器 */}
      <div className={`plc-mode-badge plc-mode-${mode}`}>
        {{ overview: t('projectMonitor.canvas.modeOverview'), focus: t('projectMonitor.canvas.modeFocus'), follow: t('projectMonitor.canvas.modeFollow'), locked: t('projectMonitor.canvas.modeLocked') }[mode]}
      </div>

      {/* 空态覆盖层（不卸载 ReactFlow，保留稳定相机与画布实例） */}
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
