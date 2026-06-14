// 使用方法：在 CanvasPanel.tsx 的 nodeTypes 中注册为 'projectCard'
// 编译说明：renderer 进程 browser bundle
// 代码说明：项目卡片节点——显示项目名、运行状态、M 级 plan 列表、双击跳转提示
//           plan 条目旁的倒三角执行指示器由 planIndicatorsByProjectAtom 驱动

import React, { useEffect } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { type NodeProps, type Node } from '@xyflow/react'
import type { Project, Session, PlanNode } from '@shared/types/index'
import { planIndicatorsByProjectAtom } from '../../../atoms/projects.atom'
import { useT } from '../../../i18n'
import './ProjectCardNode.css'

export type ProjectCardNodeData = {
  project: Project
  session: Session | null
  planNodes: PlanNode[]
  onDoubleClick?: (projectId: string) => void
}

export type ProjectCardNodeType = Node<ProjectCardNodeData, 'projectCard'>

// 状态指示器类型
type PlanItemStatus = 'done' | 'doing' | 'todo'

function getItemStatus(node: PlanNode): PlanItemStatus {
  if (node.status === 'DONE') return 'done'
  if (node.status === 'DOING') return 'doing'
  return 'todo'
}

// M 任务全完成后 3min 销毁指示器的延迟
const COMPLETED_DESTROY_MS = 3 * 60 * 1000

function ProjectCardNode({ data }: NodeProps<ProjectCardNodeType>): React.JSX.Element {
  const { t } = useT()
  const { project, session, planNodes, onDoubleClick } = data
  const isRunning = session?.status === 'Running'
  const mNodes = planNodes.filter((n) => n.level === 'M').slice(0, 4)

  // 订阅本项目的倒三角指示器列表
  const indicators = useAtomValue(planIndicatorsByProjectAtom(project.id))
  const store = useStore()

  // 检测 M 任务全完成：若所有 M 节点都是 DONE，则将活跃指示器标记为 completed 并 3min 后销毁
  useEffect(() => {
    if (mNodes.length === 0) return
    const allMDone = mNodes.every((n) => n.status === 'DONE')
    if (!allMDone) return

    // 找到所有 active/possibly-paused 指示器，标记为 completed
    const activeIndicators = indicators.filter(
      (ind) => ind.status === 'active' || ind.status === 'possibly-paused'
    )
    if (activeIndicators.length === 0) return

    store.set(planIndicatorsByProjectAtom(project.id), (prev) =>
      prev.map((ind) =>
        ind.status !== 'completed' ? { ...ind, status: 'completed' as const } : ind
      )
    )

    // 3min 后全部清除
    const timer = setTimeout(() => {
      store.set(planIndicatorsByProjectAtom(project.id), [])
    }, COMPLETED_DESTROY_MS)

    return () => clearTimeout(timer)
  }, [mNodes, indicators, project.id, store])

  const handleDoubleClick = (): void => {
    onDoubleClick?.(project.id)
  }

  return (
    <div
      className={`pcn-wrap ${isRunning ? 'pcn-active' : ''}`}
      onDoubleClick={handleDoubleClick}
    >
      {/* 卡片头部：状态点 + 项目名 + 双击提示 */}
      <div className="pcn-header">
        <div className={`pcn-dot ${isRunning ? 'pcn-dot-run' : 'pcn-dot-idle'}`} />
        <div className="pcn-info">
          <div className="pcn-title">{project.name}</div>
          <div className="pcn-sub">
            {isRunning ? (
              <>
                <span className="pcn-running">{t('projectCard.running')}</span>
                {session?.currentModel && (
                  <span>· {session.currentModel.replace('claude-', '')}</span>
                )}
              </>
            ) : (
              <span>{t('projectCard.idle')}</span>
            )}
          </div>
        </div>
        <div className="pcn-hint" title={t('projectCard.doubleClickTooltip')}>
          {t('projectCard.doubleClickHint')}
        </div>
      </div>

      {/* Plan 列表（M 级别目标） */}
      {mNodes.length > 0 && (
        <div className="pcn-plan">
          {mNodes.map((node) => {
            const st = getItemStatus(node)
            // 找到与该 plan 节点 ID 相关的指示器（planNodeId 可能为前缀匹配）
            const nodeIndicators = indicators.filter(
              (ind) => ind.planNodeId === node.id || ind.planNodeId.startsWith(node.id + '-')
            )
            const hasActive = nodeIndicators.some((ind) => ind.status === 'active')
            const hasPaused = nodeIndicators.some((ind) => ind.status === 'possibly-paused')
            const hasCompleted = nodeIndicators.some((ind) => ind.status === 'completed')

            return (
              <div key={node.id} className="pcn-plan-item">
                <div className={`pcn-ps pcn-ps-${st}`}>
                  {st === 'done' && '✓'}
                  {st === 'doing' && <span className="pcn-ps-pulse" />}
                </div>
                {/* 倒三角执行指示器：由 PostToolUse plan 文件变动驱动 */}
                {(st === 'doing' || hasActive || hasPaused || hasCompleted) && (
                  <span
                    className={`pcn-ptr ${
                      hasActive ? 'pcn-ptr-active' :
                      hasPaused ? 'pcn-ptr-paused' :
                      hasCompleted ? 'pcn-ptr-completed' : ''
                    }`}
                    title={
                      hasActive ? t('projectCard.indicatorActive') :
                      hasPaused ? t('projectCard.indicatorPaused') :
                      hasCompleted ? t('projectCard.indicatorCompleted') : t('projectCard.indicatorActive')
                    }
                  >
                    ▾
                  </span>
                )}
                <span className={`pcn-pl pcn-pl-${st}`}>{node.title}</span>
                <span className="pcn-tag">{node.level}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* 空 plan 占位 */}
      {mNodes.length === 0 && (
        <div className="pcn-empty">{t('projectCard.noPlan')}</div>
      )}
    </div>
  )
}

export default ProjectCardNode
