// 使用方法：由 AgentBlock.tsx 渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：工具大框——Tools / MCP / CLI 三列，展示当前工具调用实时快照

import React from 'react'
import { useT } from '../../i18n'
import type { ToolEntry } from '../../atoms/sessions.atom'
import './AgentBlock.css'

interface ToolsPanelProps {
  tools: ToolEntry[]
}

// 截断规则：≤3 全显，>3 前 2 条 + ···
function truncated(items: ToolEntry[]): { shown: ToolEntry[]; more: number } {
  if (items.length <= 3) return { shown: items, more: 0 }
  return { shown: items.slice(0, 2), more: items.length - 2 }
}

function ToolColumn({
  title,
  items,
}: {
  title: string
  items: ToolEntry[]
}): React.JSX.Element {
  const { shown, more } = truncated(items)
  return (
    <div className="ab-col">
      <div className="ab-col-head">{title}</div>
      {shown.length === 0 ? (
        <div className="ab-col-empty">—</div>
      ) : (
        <>
          {shown.map((t) => (
            <div
              key={t.id}
              className={`ab-tool-entry ab-tool-${t.status}`}
              title={t.displayText}
            >
              <span className="ab-tool-bullet">✦</span>
              <span className="ab-tool-name">{t.toolName}</span>
              {t.status === 'running' && <span className="ab-tool-spinner">⟳</span>}
              {t.status === 'failed' && <span className="ab-tool-fail">✕</span>}
              <span className="ab-tool-desc">{t.displayText}</span>
            </div>
          ))}
          {more > 0 && <div className="ab-col-more">···+{more}</div>}
        </>
      )}
    </div>
  )
}

function ToolsPanel({ tools }: ToolsPanelProps): React.JSX.Element {
  const { t } = useT()
  const toolItems = tools.filter((t) => t.category === 'tool')
  const mcpItems  = tools.filter((t) => t.category === 'mcp')
  const cliItems  = tools.filter((t) => t.category === 'cli')

  return (
    <div className="ab-panel ab-panel-tools">
      <div className="ab-panel-head">{t('projectMonitor.toolsPanel.title')}</div>
      <div className="ab-cols">
        <ToolColumn title="Tools" items={toolItems} />
        <ToolColumn title="MCP"   items={mcpItems} />
        <ToolColumn title="CLI"   items={cliItems} />
      </div>
    </div>
  )
}

export default ToolsPanel
