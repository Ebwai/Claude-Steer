// 使用方法：由 GlobalMonitorPage.tsx 渲染在左半区域
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局监控左半画板——@xyflow/react 无限画板，dot-grid 背景，项目卡片节点，FAB 按钮组
//           plan 数据由 usePlanIndicator hook 写入 planNodesByProjectAtom，此处只读取

import React, { useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Node,
  type NodeTypes,
  type NodeMouseHandler,
} from '@xyflow/react'
import { useAtomValue  } from 'jotai'
import '@xyflow/react/dist/style.css'

import {
  claimedProjectsAtom,
  pendingProjectCountAtom,
  allPlanNodesMapAtom,
} from '../../atoms/projects.atom'
import { activeSessionsAtom } from '../../atoms/sessions.atom'
import UserNode, { type UserNodeType } from './nodes/UserNode'
import ProjectCardNode, { type ProjectCardNodeType } from './nodes/ProjectCardNode'
import SmallProjectNode, { type SmallProjectNodeType } from './nodes/SmallProjectNode'
import { useT } from '../../i18n'
import { IPC } from '@shared/events/ipc-channels'
import './CanvasPanel.css'

// ── 布局常量 ──────────────────────────────────────────────────────────────────
const CARD_W = 248
const CARD_GAP = 16
const CARD_H = 180
const SMALL_W = 155   // 待确认角标宽度（与 SmallProjectNode 一致）
void SMALL_W
const START_X = 20
const START_Y = 20
const USER_H = 36
const SECTION_H = 32

// ── 节点类型注册（组件外定义，避免每次渲染重建引用导致重新 mount）────────────
const nodeTypes: NodeTypes = {
  userNode: UserNode as NodeTypes[string],
  projectCard: ProjectCardNode as NodeTypes[string],
  smallProject: SmallProjectNode as NodeTypes[string],
}

// ── 布局工具函数 ──────────────────────────────────────────────────────────────

function buildCardPositions(count: number): Array<{ x: number; y: number }> {
  return Array.from({ length: count }, (_, i) => ({
    x: START_X + (i % 2) * (CARD_W + CARD_GAP),
    y: START_Y + USER_H + SECTION_H + Math.floor(i / 2) * (CARD_H + CARD_GAP),
  }))
}

function buildBadgePosition(cardCount: number): { x: number; y: number } {
  const cardRows = Math.ceil(cardCount / 2)
  const baseY = START_Y + USER_H + SECTION_H + cardRows * (CARD_H + CARD_GAP) + SECTION_H + 8
  return { x: START_X, y: baseY }
}

// ── CanvasPanel Props ─────────────────────────────────────────────────────────

interface CanvasPanelProps {
  onCreateProject: () => void
  /** 双击项目卡片时导航到项目监控页（由 AppInner 注入） */
  onNavigateToProject?: (projectId: string) => void
}

// ── CanvasPanel 组件 ──────────────────────────────────────────────────────────

function CanvasPanel({ onCreateProject, onNavigateToProject }: CanvasPanelProps): React.JSX.Element {
  const { t } = useT()
  const claimedProjects = useAtomValue(claimedProjectsAtom)
  const activeSessions  = useAtomValue(activeSessionsAtom)
  const pendingCount    = useAtomValue(pendingProjectCountAtom)
  // 订阅所有项目的 plan 数据聚合——任意项目 plan 更新时触发重绘
  const planNodesMap    = useAtomValue(allPlanNodesMapAtom)

  const handleChat = useCallback(async () => {
    console.log('[CanvasPanel] 💬 闲聊：启动裸 PTY')
    try {
      const result = await window.api.invoke(IPC.CHAT_START) as { ok: boolean; sessionId?: string; error?: string }
      if (!result.ok || !result.sessionId) {
        console.error('[CanvasPanel] CHAT_START failed:', result.error)
        return
      }
      await window.api.invoke(IPC.CHAT_WINDOW_OPEN, { sessionId: result.sessionId })
    } catch (err) {
      console.error('[CanvasPanel] chat start error:', err)
    }
  }, [])

  // 节点双击 → 导航到项目监控页（ReactFlow 专用回调，避免画板事件拦截）
  const handleNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.type === 'projectCard') {
        const projectId = (node.data as { project: { id: string } }).project.id
        console.log(`[App:NAV] 双击项目卡片，导航到项目监控页: projectId=${projectId}`)
        onNavigateToProject?.(projectId)
      }
    },
    [onNavigateToProject],
  )
  // planNodesByProjectAtom 由 usePlanIndicator 在 plan 文件变动时自动刷新
  const nodes = useMemo<Node[]>(() => {
    const result: Node[] = []

    // 1. 用户节点
    result.push({
      id: 'user',
      type: 'userNode',
      position: { x: START_X, y: START_Y },
      data: { username: t('canvasPanel.username') },
      draggable: false,
      selectable: false,
    } satisfies UserNodeType)

    // 2. 所有已认领项目（claimStatus=1）全部显示为大卡片
    const cardPositions = buildCardPositions(claimedProjects.length)
    claimedProjects.forEach((project, i) => {
      const session = project.activeSessionId
        ? (activeSessions.get(project.activeSessionId) ?? null)
        : null

      const planNodes = planNodesMap.get(project.id) ?? []

      result.push({
        id: `project-card-${project.id}`,
        type: 'projectCard',
        position: cardPositions[i],
        data: {
          project,
          session,
          planNodes,
          onDoubleClick: (id: string) => {
            console.log(`[App:NAV] 双击项目卡片，导航到项目监控页: projectId=${id}`)
            onNavigateToProject?.(id)
          },
        },
        draggable: false,
        selectable: false,
      } satisfies ProjectCardNodeType)
    })

    // 3. 待确认角标
    if (pendingCount > 0) {
      result.push({
        id: 'pending-badge',
        type: 'smallProject',
        position: buildBadgePosition(claimedProjects.length),
        data: {
          project: {
            id: '__pending__',
            name: t('canvasPanel.pendingCount', { count: pendingCount }),
            path: '',
            claimStatus: 0,
            isGitRepo: false,
            activeSessionId: null,
            sessionIds: [],
            lastActiveAt: 0,
          },
          isPending: true,
        },
        draggable: false,
        selectable: false,
      } satisfies SmallProjectNodeType)
    }

    return result
  }, [claimedProjects, activeSessions, pendingCount, planNodesMap, onNavigateToProject])

  return (
    <div className="canvas-panel">
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={true}
        zoomOnScroll={true}
        minZoom={0.3}
        maxZoom={4}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        zoomOnDoubleClick={false}
        onNodeClick={() => { /* 仅为了让 hasPointerEvents=true，否则节点 pointer-events:none */ }}
        onNodeDoubleClick={handleNodeDoubleClick}
        proOptions={{ hideAttribution: true }}
        className="canvas-flow"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#252530"
          style={{ opacity: 0.26 }}
        />
      </ReactFlow>

      {/* FAB 按钮（悬浮在画板左下角）*/}
      <div className="canvas-fabs">
        <button className="fab-btn fab-primary" onClick={onCreateProject}>{t('canvasPanel.newProject')}</button>
        <button className="fab-btn fab-ghost" onClick={() => { void handleChat() }}>{t('canvasPanel.chat')}</button>
      </div>
    </div>
  )
}

export default CanvasPanel
