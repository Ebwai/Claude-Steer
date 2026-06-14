// 使用方法：由 ProcessTimeline.tsx 在每条"分配任务"插入线之后内联渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：Subagent 迷你时间线块——独立坐标系（sab-axis 在 left:20px），
//           内部工具调用使用 LineInsertionItem（右向），JSONL 节点叠加显示
//           CSS 变量覆盖：--ins-padding-left:40px / --ins-axis-left:20px

import React, { useState } from 'react'
import { useAtomValue } from 'jotai'
import { subagentTimelineAtom, lineInsertionsBySessionAtom, type TimelineNode } from '../../atoms/timeline.atom'
import LineInsertionItem from './LineInsertionItem'
import { useT } from '../../i18n'
import './SubagentBlock.css'

interface SubagentBlockProps {
  /** 父 session claudeId（用于订阅父 session 插入线，查找返回线） */
  sessionId: string
  /** subagent 唯一 ID（来自 Hook agent_id 字段） */
  agentId: string
  /** subagent 任务描述（可选，优先级低于插入线自带的 description） */
  description?: string
  /**
   * 对应"分配任务"插入线的 customWidth（px）
   * 用于计算 SubagentBlock 的 margin-left
   * 默认值：144（1 个槽位）
   */
  dispatchWidth?: number
  /**
   * 对应"分配任务"插入线的 toolUseId
   * SubagentBlock 通过此值在父 session 插入线中精确找到"返回任务结果"线
   */
  toolUseId?: string
}

// ── JSONL 节点渲染（有 JSONL 数据时使用）────────────────────────────────────

interface MiniNodeProps {
  node: TimelineNode
  toolResults: Map<string, TimelineNode>
}

function MiniNode({ node, toolResults }: MiniNodeProps): React.JSX.Element {
  const { t } = useT()
  const [expanded, setExpanded] = useState(false)
  const MAX_TEXT = 300

  if (node.type === 'user_input') {
    return (
      <div className="sab-node sab-node-user">
        <span className="sab-dot sab-dot-user" />
        <div className="sab-user-bubble">
          <span className="sab-user-prefix">{t('projectMonitor.subagent.taskPrefix')}</span>
          <span className="sab-user-text">{node.text}</span>
        </div>
      </div>
    )
  }

  if (node.type === 'assistant') {
    const text = node.text ?? ''
    const isLong = text.length > MAX_TEXT
    return (
      <div className="sab-node sab-node-assistant">
        <span className="sab-dot sab-dot-assistant" />
        <div className="sab-assistant-card">
          <div className="sab-assistant-text">
            {isLong && !expanded ? text.slice(0, MAX_TEXT) + '…' : text}
          </div>
          {isLong && (
            <button className="sab-expand-btn" onClick={() => setExpanded((v) => !v)}>
              {expanded ? t('projectMonitor.subagent.collapse') : t('projectMonitor.subagent.expandFullText')}
            </button>
          )}
        </div>
      </div>
    )
  }

  if (node.type === 'tool_use') {
    const result = node.toolUseId ? toolResults.get(node.toolUseId) : undefined
    return (
      <div className="sab-node sab-node-tool">
        <span className="sab-dot sab-dot-tool" />
        <div className="sab-tool-box">
          <span className="sab-tool-name">{node.toolName}</span>
          <span className="sab-tool-text">{node.toolDisplayText}</span>
          {result && (
            <span className={`sab-tool-result ${result.isError ? 'sab-tool-error' : 'sab-tool-ok'}`}>
              {result.isError ? '✗' : '✓'}
            </span>
          )}
        </div>
      </div>
    )
  }

  return <></>
}

// ── 主组件 ─────────────────────────────────────────────────────────────────

function SubagentBlock({ sessionId, agentId, description: descriptionProp, dispatchWidth = 144, toolUseId }: SubagentBlockProps): React.JSX.Element {
  const { t } = useT()
  const timelineKey = `${sessionId}::${agentId}`
  const nodes = useAtomValue(subagentTimelineAtom(timelineKey))
  const insertions = useAtomValue(lineInsertionsBySessionAtom(agentId))
  // 从父 session 插入线中找到对应的"返回任务结果"线（通过 toolUseId 精确匹配）
  const parentInsertions = useAtomValue(lineInsertionsBySessionAtom(sessionId))
  const returnInsertion = toolUseId
    ? parentInsertions.find((ins) => ins.toolUseId === toolUseId && ins.lineLabel === '返回任务结果')
    : undefined
  const [collapsed, setCollapsed] = useState(false)

  // 描述文本：prop > 插入线 description > 插入线 displayText
  const description = (descriptionProp
    ?? (insertions[0]?.badgeContent?.description as string | undefined)
    ?? (insertions[0]?.badgeContent?.displayText as string | undefined)
  ) ?? ''

  // 构建 tool_result 查找表
  const toolResults = new Map<string, TimelineNode>()
  for (const n of nodes) {
    if (n.type === 'tool_result' && n.toolUseId) {
      toolResults.set(n.toolUseId, n)
    }
  }

  const visibleNodes = nodes.filter((n) => n.type === 'user_input' || n.type === 'assistant')
  // 插入线数量作为"步骤数"展示（Hook 触发更及时）
  const stepCount = Math.max(visibleNodes.length, insertions.length)

  // 分配任务线为左向（右端贴 axis=750px，左端 = 750 - dispatchWidth）
  // 内容流 x=0 对应 padding-left=770px 处
  // 线左端相对内容流 = 750 - dispatchWidth - 770 = -(20 + dispatchWidth)
  // SubagentBlock 宽 340px，margin-left 使其右边缘恰好对准线左端
  // 块右边 x = marginLeft + 340；令其等于线左端 -(20+dispatchWidth)
  // → marginLeft = -(20 + dispatchWidth) - 340 = -(360 + dispatchWidth)
  const blockStyle: React.CSSProperties = {
    marginLeft: `${-(360 + dispatchWidth)}px`,
  }

  return (
    <React.Fragment>
      <div className="sab-block" style={blockStyle}>
        {/* ── 折叠头部 ── */}
        <div
          className={`sab-header ${!collapsed ? 'sab-header-open' : ''}`}
          onClick={() => setCollapsed((v) => !v)}
        >
          <span className="sab-icon">◎</span>
          <span className="sab-label">Subagent</span>
          {description && (
            <span className="sab-desc">
              {description.length > 60 ? description.slice(0, 60) + '…' : description}
            </span>
          )}
          <span className="sab-count">{stepCount > 0 ? t('projectMonitor.subagent.steps', { count: stepCount }) : t('projectMonitor.subagent.executing')}</span>
          <span className="sab-toggle">{collapsed ? '▶' : '▼'}</span>
        </div>

        {!collapsed && (
          <div className="sab-timeline-body">
            {/* 竖线时间轴（left:20px，独立坐标系）*/}
            <div className="sab-axis" />

            {visibleNodes.length === 0 && insertions.length === 0 ? (
              /* 空态：subagent 刚启动，Hook 还未到达 */
              <div className="sab-empty">
                <span className="sab-dot sab-dot-running" />
                <span className="sab-running-text">{t('projectMonitor.subagent.executing')}</span>
              </div>
            ) : visibleNodes.length === 0 ? (
              /* 只有 Hook 插入线（最常见情况：JSONL 未检测到时仍能显示工具调用）*/
              insertions.map((ins) => (
                <LineInsertionItem key={ins.id} insertion={ins} />
              ))
            ) : (
              /* 有 JSONL 节点：按时间戳穿插插入线 */
              visibleNodes.map((node, idx) => {
                const nextNode = visibleNodes[idx + 1]
                const windowStart = node.parsedAt
                const windowEnd = nextNode ? nextNode.parsedAt : Infinity
                const nodeInsertions = insertions.filter(
                  (ins) => ins.timestamp >= windowStart && ins.timestamp < windowEnd
                )
                return (
                  <React.Fragment key={node.id}>
                    <MiniNode node={node} toolResults={toolResults} />
                    {nodeInsertions.map((ins) => (
                      <LineInsertionItem key={ins.id} insertion={ins} />
                    ))}
                  </React.Fragment>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* 返回任务结果线：作为 sab-block 的兄弟节点，在 ptl-container 坐标系中渲染
          Y 坐标 = sab-block 底部下方，精确关联，不受 sab CSS 变量影响 */}
      {returnInsertion && (
        <LineInsertionItem key={`return-${returnInsertion.id}`} insertion={returnInsertion} />
      )}
    </React.Fragment>
  )
}

export default SubagentBlock
