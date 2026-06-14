// 使用方法：由 AgentBlock.tsx 渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：经验大框——Skills / 工作流 两列，展示当前经验调用实时快照

import React from 'react'
import { useT } from '../../i18n'
import type { ExperienceEntry } from '../../atoms/sessions.atom'
import './AgentBlock.css'

interface ExperiencesPanelProps {
  experiences: ExperienceEntry[]
}

function truncated(items: ExperienceEntry[]): { shown: ExperienceEntry[]; more: number } {
  if (items.length <= 3) return { shown: items, more: 0 }
  return { shown: items.slice(0, 2), more: items.length - 2 }
}

function ExpColumn({
  title,
  items,
}: {
  title: string
  items: ExperienceEntry[]
}): React.JSX.Element {
  const { shown, more } = truncated(items)
  return (
    <div className="ab-col">
      <div className="ab-col-head">{title}</div>
      {shown.length === 0 ? (
        <div className="ab-col-empty">—</div>
      ) : (
        <>
          {shown.map((e) => (
            <div
              key={e.id}
              className={`ab-tool-entry ab-tool-${e.status}`}
              title={e.name}
            >
              <span className="ab-tool-bullet">◈</span>
              <span className="ab-tool-name">{e.name}</span>
              {e.status === 'running' && <span className="ab-tool-spinner">⟳</span>}
            </div>
          ))}
          {more > 0 && <div className="ab-col-more">···+{more}</div>}
        </>
      )}
    </div>
  )
}

function ExperiencesPanel({ experiences }: ExperiencesPanelProps): React.JSX.Element {
  const { t } = useT()
  const skillItems    = experiences.filter((e) => e.category === 'skill')
  const workflowItems = experiences.filter((e) => e.category === 'workflow')

  return (
    <div className="ab-panel ab-panel-exp">
      <div className="ab-panel-head">{t('projectMonitor.experiences.title')}</div>
      <div className="ab-cols">
        <ExpColumn title="Skills" items={skillItems} />
        <ExpColumn title={t('projectMonitor.experiences.workflows')} items={workflowItems} />
      </div>
    </div>
  )
}

export default ExperiencesPanel
