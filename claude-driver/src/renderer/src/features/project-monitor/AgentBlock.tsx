// 使用方法：由 LeftPanel.tsx 在有活跃 session 时渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：Agent Block——单个 session 的实时工作情况卡片，含工具框/经验框/Subagent卡片/消息输入行

import React, { useCallback } from 'react'
import { useStore } from 'jotai'
import { useT } from '../../i18n'
import { activeSessionsAtom, agentBlocksAtom } from '../../atoms/sessions.atom'
import { focusRequestAtom } from '../../atoms/viewport.atom'
import type { AgentBlockState } from '../../atoms/sessions.atom'
import type { Session } from '@shared/types/index'
import ToolsPanel from './ToolsPanel'
import ExperiencesPanel from './ExperiencesPanel'
import MessageInputBar from './MessageInputBar'
import './AgentBlock.css'

interface AgentBlockProps {
  session: Session
  block: AgentBlockState
  agentLabel: string   // 如 "Agent1"、"主线程"
  agentColor: string   // CSS 颜色字符串
}

function AgentBlock({ session, block, agentLabel, agentColor }: AgentBlockProps): React.JSX.Element {
  const { t } = useT()
  const store = useStore()

  const handleMessageSent = useCallback(() => {
    // activeSessionsAtom key 是 claudeId（PTY_BIND 后迁移），不是 ptyId（session.id）
    const key = session.claudeId ?? session.id
    store.set(activeSessionsAtom, (prev) => {
      const next = new Map(prev)
      const s = next.get(key)
      if (s && s.status === 'Paused') {
        next.set(key, { ...s, status: 'Running' })
      }
      return next
    })
    // 消息发送后，跳转视口到该 session 框
    const claudeId = session.claudeId ?? session.id
    console.log(`[AgentBlock] message sent, requesting focus on ${claudeId.slice(0,8)}`)
    store.set(focusRequestAtom, { sessionId: claudeId, ts: Date.now() })
  }, [session.claudeId, session.id, store])

  const handleDismissInsight = useCallback(() => {
    store.set(agentBlocksAtom, (prev) => {
      const next = new Map(prev)
      // agentBlocksAtom key 是 claudeId（block.sessionId），不是 PTY UUID（session.id）
      const b = next.get(block.sessionId)
      if (b) next.set(block.sessionId, { ...b, activeInsight: null })
      return next
    })
  }, [block.sessionId, store])

  const isActive = session.status === 'Running' || session.status === 'Paused'

  return (
    <div className="agent-block">
      {/* 头部行：状态圆点 + agent 标签 + 工作状态词 */}
      <div className="agent-block__header">
        <span
          className={`ab-dot ab-dot-${session.status.toLowerCase()}`}
          style={{ backgroundColor: agentColor }}
        />
        <span className="ab-agent-label" style={{ color: agentColor }}>{agentLabel}</span>
        {block.workStatusText && (
          <span className="ab-work-status">{block.workStatusText}</span>
        )}
        <span className={`ab-session-badge ab-badge-${session.status.toLowerCase()}`}>
          {session.status}
        </span>
      </div>

      {/* 工具框 + 经验框并排 */}
      <div className="agent-block__panels">
        <ToolsPanel tools={block.activeTools} />
        <ExperiencesPanel experiences={block.activeExperiences} />
      </div>

      {/* Subagent 状态卡片（仅有 subagent 时显示） */}
      {block.activeSubagent && (
        <div className="ab-subagent-card">
          <span className="ab-subagent-badge">Subagent</span>
          <span className="ab-subagent-desc">{block.activeSubagent.description}</span>
          <span className="ab-subagent-waiting">{t('projectMonitor.agentBlock.waitingForReturn')}</span>
        </div>
      )}

      {/* 活跃 Insight 金色块（仅有 insight 时显示） */}
      {block.activeInsight && (
        <div className="ab-insight-card">
          <span className="ab-insight-icon">◆</span>
          <span className="ab-insight-text">{block.activeInsight.slice(0, 80)}</span>
          <button className="ab-insight-close" onClick={handleDismissInsight}>✕</button>
        </div>
      )}

      {/* 消息输入行 */}
      {isActive && (
        <MessageInputBar
          sessionId={session.id}
          isRunning={isActive}
          agentLabel={agentLabel}
          agentColor={agentColor}
          onSent={handleMessageSent}
        />
      )}
    </div>
  )
}

export default AgentBlock
