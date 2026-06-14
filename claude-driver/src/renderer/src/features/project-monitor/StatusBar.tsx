// 使用方法：由 LeftPanel.tsx 在底部固定位置渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：底部状态栏——20px 高度，显示当前工作状态词 + 实时任务摘要 + 旋转图标
//           数据来源：工作状态词来自 agentBlocksAtom.workStatusText；
//                     任务摘要来自 timelineBySessionAtom 最新 assistant 节点前 60 字

import React from 'react'
import { useAtomValue } from 'jotai'
import { useT } from '../../i18n'
import { agentBlocksAtom, type AgentBlockState } from '../../atoms/sessions.atom'
import { pathMatches } from '@renderer/utils/pathUtils'
import type { Session } from '@shared/types/index'
import './StatusBar.css'

// 工作状态词 → CSS 颜色类
function statusColorClass(status: string): string {
  if (!status) return ''
  if (status.startsWith('Writing') || status.startsWith('Editing')) return 'sb-status--write'
  if (status.startsWith('Reading') || status.startsWith('Thinking')) return 'sb-status--read'
  if (status.startsWith('Running')) return 'sb-status--run'
  if (status.startsWith('Dispatching') || status.startsWith('Subagent')) return 'sb-status--agent'
  if (status === 'Done') return 'sb-status--done'
  return 'sb-status--default'
}

// ── 单 session 的状态摘要（需要 atom hook，抽为独立组件）────────────────────

interface SessionStatusProps {
  session: Session
  isRunning: boolean
}

function SessionStatus({ session, isRunning }: SessionStatusProps): React.JSX.Element {
  const agentBlocks = useAtomValue(agentBlocksAtom)

  // agentBlocksAtom 的 key 是 Claude Code 内部 session ID，不是 PTY UUID
  // 用 CWD 匹配找到对应 block（与 LeftPanel 的 AgentBlock 查找逻辑一致）
  const block: AgentBlockState | undefined = agentBlocks.get(session.id) ??
    Array.from(agentBlocks.values()).find(
      (b) => b.sessionCwd && pathMatches(session.cwd, b.sessionCwd)
    )

  const workStatus = block?.workStatusText ?? ''
  const colorClass = statusColorClass(workStatus)

  return (
    <>
      {workStatus && (
        <span className={`sb-status ${colorClass}`}>{workStatus}</span>
      )}
      {isRunning && (
        <span className="sb-spinner" aria-hidden="true">⟳</span>
      )}
    </>
  )
}

// ── StatusBar 主组件 ──────────────────────────────────────────────────────────

interface StatusBarProps {
  /** 当前项目的活跃 session 列表 */
  sessions: Session[]
}

function StatusBar({ sessions }: StatusBarProps): React.JSX.Element {
  const { t } = useT()
  const runningSessions = sessions.filter((s) => s.status === 'Running')
  const agentCount = runningSessions.length

  // 多 Agent 并行时取第一个作为"最活跃"显示
  const primarySession = runningSessions[0] ?? sessions[0]
  const isPrimaryRunning = primarySession?.status === 'Running'

  return (
    <div className="sb-bar">
      <span className="sb-prompt">&gt;</span>

      {agentCount > 1 ? (
        // 多 Agent 并行
        <>
          <span className="sb-agents">{t('projectMonitor.statusBar.agentsParallel', { count: agentCount })}</span>
          <span className="sb-sep">·</span>
          {primarySession && (
            <SessionStatus
              session={primarySession}
              isRunning={isPrimaryRunning}
            />
          )}
        </>
      ) : primarySession ? (
        // 单 session
        <SessionStatus
          session={primarySession}
          isRunning={isPrimaryRunning}
        />
      ) : (
        <span className="sb-idle">{t('projectMonitor.statusBar.idle')}</span>
      )}
    </div>
  )
}

export default StatusBar
