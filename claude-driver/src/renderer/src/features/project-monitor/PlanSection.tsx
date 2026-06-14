// 使用方法：由 LeftPanel.tsx 渲染在顶部折叠区
// 编译说明：renderer 进程 browser bundle
// 代码说明：执行计划折叠区——折叠态 30px 仅显示 header，展开态 200px 显示 Plan 树
//           数据源：直接订阅 planNodesByProjectAtom，usePlanIndicator 更新 atom 时自动重渲染

import React, { useState, useMemo, useCallback } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { useT } from '../../i18n'
import { planNodesByProjectAtom, projectsAtom } from '../../atoms/projects.atom'
import { parsePlanNodes } from '../../hooks/usePlanIndicator'
import { IPC } from '@shared/events/ipc-channels'
import type { PlanNode } from '@shared/types/index'
import './PlanSection.css'

// ── Plan 树节点类型 ──────────────────────────────────────────────────────────

interface PlanTreeNode {
  id: string
  level: 'M' | 'S' | 'T'
  title: string
  status: 'TODO' | 'DOING' | 'DONE'
  children: PlanTreeNode[]
}

// ── 将 planNodesByProjectAtom 的平铺列表转为树结构 ──────────────────────────

function buildTree(nodes: PlanNode[]): PlanTreeNode[] {
  const roots: PlanTreeNode[] = []
  let currentM: PlanTreeNode | null = null
  let currentS: PlanTreeNode | null = null

  for (const node of nodes) {
    const treeNode: PlanTreeNode = {
      id: node.id,
      level: node.level,
      title: node.title,
      status: node.status,
      children: [],
    }
    if (node.level === 'M') {
      currentM = treeNode
      currentS = null
      roots.push(currentM)
    } else if (node.level === 'S' && currentM) {
      currentS = treeNode
      currentM.children.push(currentS)
    } else if (node.level === 'T' && currentS) {
      currentS.children.push(treeNode)
    }
  }

  return roots
}

// ── 树节点渲染 ────────────────────────────────────────────────────────────

interface TreeNodeProps {
  node: PlanTreeNode
  depth: number
}

function TreeNode({ node, depth }: TreeNodeProps): React.JSX.Element {
  const [open, setOpen] = useState(node.status !== 'DONE')

  const statusIcon =
    node.status === 'DONE'  ? '✓' :
    node.status === 'DOING' ? '!' : '○'

  const hasChildren = node.children.length > 0

  return (
    <div className={`plan-node plan-node-depth-${depth}`}>
      <div
        className={`plan-node-header plan-status-${node.status.toLowerCase()}`}
        onClick={() => hasChildren && setOpen((v) => !v)}
        style={{ cursor: hasChildren ? 'pointer' : 'default' }}
      >
        <span className="plan-node-icon">{statusIcon}</span>
        <span className="plan-node-title">{node.title}</span>
        {hasChildren && (
          <span className="plan-node-toggle">{open ? '▾' : '▸'}</span>
        )}
      </div>
      {open && hasChildren && (
        <div className="plan-node-children">
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── 主组件 ────────────────────────────────────────────────────────────────

interface PlanSectionProps {
  projectId: string | null
}

function PlanSection({ projectId }: PlanSectionProps): React.JSX.Element {
  const { t } = useT()
  const store = useStore()
  const [collapsed, setCollapsed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // 直接订阅 planNodesByProjectAtom：usePlanIndicator 更新 atom 时自动重渲染
  const planNodes = useAtomValue(planNodesByProjectAtom(projectId ?? ''))
  const nodes = useMemo(() => buildTree(planNodes), [planNodes])

  const handleRefresh = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!projectId || refreshing) return
    setRefreshing(true)
    try {
      const projects = store.get(projectsAtom)
      const project = projects.get(projectId)
      if (!project) return
      const result = await window.api.invoke(IPC.PLAN_READ, project.path) as { ok: boolean; content?: string | null }
      if (result.ok && result.content) {
        const parsed = parsePlanNodes(result.content, projectId)
        store.set(planNodesByProjectAtom(projectId), parsed)
      }
    } finally {
      setRefreshing(false)
    }
  }, [projectId, refreshing, store])

  const doingCount = nodes.reduce((acc, m) => {
    const sCount = m.children.reduce((a, s) => {
      const tCount = s.children.filter((t) => t.status !== 'DONE').length
      return a + (s.status !== 'DONE' ? tCount || 1 : 0)
    }, 0)
    return acc + (m.status !== 'DONE' ? sCount || 1 : 0)
  }, 0)

  return (
    <div className={`plan-section ${collapsed ? 'plan-section-collapsed' : ''}`}>
      <div className="plan-header" onClick={() => setCollapsed((v) => !v)}>
        <span className="plan-header-icon">📋</span>
        <span className="plan-header-title">{t('projectMonitor.planSection.title')}</span>
        <span
          className={`plan-header-refresh${refreshing ? ' plan-header-refreshing' : ''}`}
          onClick={handleRefresh}
          title="刷新"
        >
          ↻
        </span>
        {!collapsed && doingCount > 0 && (
          <span className="plan-header-badge">{t('projectMonitor.planSection.pending', { count: doingCount })}</span>
        )}
        <span className="plan-header-toggle">{collapsed ? '▸' : '▾'}</span>
      </div>

      {!collapsed && (
        <div className="plan-body">
          {nodes.length === 0 && (
            <div className="plan-empty">{t('projectMonitor.planSection.notFound')}</div>
          )}
          {nodes.map((node) => (
            <TreeNode key={node.id} node={node} depth={0} />
          ))}
        </div>
      )}
    </div>
  )
}

export default PlanSection
