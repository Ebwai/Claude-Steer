// 使用方法：由 LeftPanel.tsx 在四层布局的层④位置渲染（常驻）
// 编译说明：renderer 进程 browser bundle
// 代码说明：上下文面板（层④）——显示当前 session 已加载的上下文组件列表
//           持久组件（System/CLAUDE.md/Memory/Skills）：始终硬编码显示，不依赖 Hook
//           动态组件（读取文件/WebFetch）：来自 contextPanelAtom，由 Hook 事件追踪累计
//           compact 时清除动态组件，持久组件保留

import React, { useState } from 'react'
import { useAtomValue } from 'jotai'
import { useT } from '../../i18n'
import { contextPanelAtom, type ContextComponent } from '../../atoms/sessions.atom'
import type { Session } from '@shared/types/index'
import './ContextPanel.css'

// 始终显示的持久组件（不依赖 Hook 事件，直接硬编码）
const PERSISTENT_COMPONENTS: ContextComponent[] = [
  { id: 'System',    type: 'System',    label: 'System Prompt', tokenEstimate: 0, persistent: true },
  { id: 'CLAUDE.md', type: 'CLAUDE.md', label: 'CLAUDE.md',     tokenEstimate: 0, persistent: true },
  { id: 'Memory',    type: 'Memory',    label: 'Auto Memory',   tokenEstimate: 0, persistent: true },
  { id: 'Skills',    type: 'Skills',    label: 'Skills',        tokenEstimate: 0, persistent: true },
]

// 组件类型 → 短标签
function typeLabel(type: ContextComponent['type']): string {
  switch (type) {
    case 'System':     return 'SYS'
    case 'CLAUDE.md':  return 'MD'
    case 'Memory':     return 'MEM'
    case 'Skills':     return 'SKL'
    case 'MCP':        return 'MCP'
    case 'Rules':      return 'RUL'
    case 'file':       return 'FILE'
    case 'WebFetch':   return 'WEB'
    case 'user-input': return 'USR'
  }
}

// 组件类型 → CSS 颜色类
function typeColorClass(type: ContextComponent['type']): string {
  switch (type) {
    case 'System':
    case 'CLAUDE.md':
    case 'Memory':
    case 'Skills':
    case 'MCP':
    case 'Rules':      return 'ctx-tag--persist'
    case 'file':       return 'ctx-tag--file'
    case 'WebFetch':   return 'ctx-tag--web'
    case 'user-input': return 'ctx-tag--user'
  }
}

interface ContextPanelProps {
  sessions: Session[]
  /** 主 session ID（用于读取对应 atom 的动态组件） */
  primarySessionId: string
}

/** 单个 session 的动态组件列表（Read 文件 / WebFetch） */
function DynamicComponents({ sessionId }: { sessionId: string }): React.JSX.Element {
  const allComponents = useAtomValue(contextPanelAtom(sessionId))
  // contextPanelAtom 中只存动态组件（persistent=false）
  const dynamicComps = allComponents.filter((c) => !c.persistent)

  if (dynamicComps.length === 0) return <></>

  return (
    <>
      <div className="ctx-divider" />
      {dynamicComps.map((comp) => (
        <div key={comp.id} className="ctx-item">
          <span className={`ctx-tag ${typeColorClass(comp.type)}`}>{typeLabel(comp.type)}</span>
          {comp.url ? (
            <a
              className="ctx-label ctx-label--link"
              href={comp.url}
              target="_blank"
              rel="noreferrer"
              title={comp.url}
            >
              {comp.label}
            </a>
          ) : (
            <span className="ctx-label" title={comp.label}>{comp.label}</span>
          )}
          {comp.tokenEstimate > 0 && (
            <span className="ctx-tokens">
              ≈{comp.tokenEstimate >= 1000
                ? `${(comp.tokenEstimate / 1000).toFixed(1)}K`
                : comp.tokenEstimate}
            </span>
          )}
        </div>
      ))}
    </>
  )
}

function ContextPanel({ sessions, primarySessionId }: ContextPanelProps): React.JSX.Element {
  const { t } = useT()
  const [selectedId, setSelectedId] = useState<string>(primarySessionId)

  // 当前选中的 session ID（若 sessions 变化导致 selectedId 无效，回退到主 session）
  const activeId = sessions.some((s) => s.id === selectedId) ? selectedId : primarySessionId

  const hasMultiple = sessions.length > 1

  return (
    <div className="ctx-panel">
      {/* ── 标题栏 ── */}
      <div className="ctx-header">
        <span className="ctx-title">{t('projectMonitor.context.title')}</span>

        {/* 多 Agent 切换按钮 */}
        {hasMultiple && (
          <div className="ctx-agent-tabs">
            {sessions.map((s, idx) => (
              <button
                key={s.id}
                className={`ctx-agent-tab ${s.id === activeId ? 'ctx-agent-tab--active' : ''}`}
                onClick={() => setSelectedId(s.id)}
              >
                {idx === 0 ? t('projectMonitor.context.mainThread') : `Agent${idx + 1}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── 组件列表 ── */}
      <div className="ctx-list">
        {/* 持久组件：始终显示，硬编码，不依赖 Hook */}
        {PERSISTENT_COMPONENTS.map((comp) => (
          <div key={comp.id} className="ctx-item">
            <span className={`ctx-tag ${typeColorClass(comp.type)}`}>{typeLabel(comp.type)}</span>
            <span className="ctx-label">{comp.label}</span>
          </div>
        ))}

        {/* 动态组件：来自 contextPanelAtom，有 session 时才读取 */}
        {activeId && <DynamicComponents sessionId={activeId} />}
      </div>
    </div>
  )
}

export default ContextPanel
