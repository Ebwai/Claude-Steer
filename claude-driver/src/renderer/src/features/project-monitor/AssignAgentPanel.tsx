// 使用方法：由 ProcessTimeline AssistantActionBar 在「🤖 指派某个 Agent 工作」菜单项展开时渲染
// 编译说明：Vite + React 渲染进程，TSX 组件
// 代码说明：指派 Agent 面板 — 配置多行派发任务并通过 SESSION_INPUT 发送到 PTY stdin

import { useState, useCallback, useEffect, useRef } from 'react'
import { IPC } from '@shared/events/ipc-channels'
import { useT } from '../../i18n'
import './AssignAgentPanel.css'

interface AgentItem { name: string; model: string }
interface ItemGroup<T> {
  label: string
  source: 'builtin' | 'user' | 'plugin'
  pluginId?: string
  items: T[]
}
interface AllConfigGroups {
  agentGroups: ItemGroup<AgentItem>[]
}

interface AssignAgentPanelProps {
  sessionId: string
  projectPath: string
  onClose: () => void
}

interface AssignRow {
  id: string
  count: string
  agentName: string
  task: string
}

function makeDefaultRow(): AssignRow {
  return { id: crypto.randomUUID(), count: '1', agentName: 'agent', task: '这件事情' }
}

export default function AssignAgentPanel({ sessionId, projectPath, onClose }: AssignAgentPanelProps): React.JSX.Element {
  const { t } = useT()
  const [rows, setRows] = useState<AssignRow[]>([makeDefaultRow()])
  const [configGroups, setConfigGroups] = useState<AllConfigGroups | null>(null)
  const [projectAgents, setProjectAgents] = useState<AgentItem[]>([])
  const [dropdownRowId, setDropdownRowId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // validate with translation
  const validateCountLocal = useCallback((v: string): string | null => {
    const n = parseInt(v, 10)
    if (isNaN(n) || n < 1 || n > 4 || String(n) !== v.trim())
      return t('projectMonitor.assignAgent.countError')
    return null
  }, [t])

  // 挂载时并行拉取全局 agent 配置 + 项目级 agents
  useEffect(() => {
    void (async () => {
      const [cfgResult, projResult] = await Promise.all([
        window.api.invoke(IPC.CONFIG_READ) as Promise<AllConfigGroups>,
        window.api.invoke(IPC.AGENT_LIST_PROJECT, { projectPath }) as Promise<{ ok: boolean; items: AgentItem[] }>,
      ])
      console.log('[AssignAgentPanel] config loaded agentGroups=', cfgResult?.agentGroups?.length, 'projectAgents=', projResult?.items?.length)
      setConfigGroups(cfgResult ?? null)
      setProjectAgents(projResult?.items ?? [])
    })()
  }, [projectPath])

  // 点击面板外关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [onClose])

  const updateRow = useCallback((id: string, patch: Partial<AssignRow>) => {
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, ...patch } : r))
  }, [])

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, makeDefaultRow()])
  }, [])

  const allValid = rows.every((r) => validateCountLocal(r.count) === null && r.task.trim() !== '')

  const handleSend = useCallback(async () => {
    if (!allValid) return
    const text = rows.map((r) => `派发${r.count}个${r.agentName}去做${r.task}`).join('\n') + '\n'
    console.log(`[AssignAgentPanel] sending to sessionId=${sessionId} text=${text.slice(0, 80)}`)
    try {
      await window.api.invoke(IPC.SESSION_INPUT, { sessionId, text })
    } catch (err) {
      console.error('[AssignAgentPanel] SESSION_INPUT failed:', err)
    }
    onClose()
  }, [rows, allValid, sessionId, onClose])

  // 分组：框 A（builtin + user），框 C（plugin 每个一框）
  const globalGroups: Array<ItemGroup<AgentItem>> = (configGroups?.agentGroups ?? []).filter((g) => g.source !== 'plugin')
  const pluginGroups: Array<ItemGroup<AgentItem>> = (configGroups?.agentGroups ?? []).filter((g) => g.source === 'plugin')

  const selectAgent = useCallback((rowId: string, name: string) => {
    updateRow(rowId, { agentName: name })
    setDropdownRowId(null)
  }, [updateRow])

  return (
    <div className="aap-panel" ref={panelRef}>
      {rows.map((row, idx) => {
        const countErr = validateCountLocal(row.count)
        const isDropOpen = dropdownRowId === row.id
        return (
          <div key={row.id} className="aap-row-wrapper">
            <div className="aap-row">
              {/* 控件1：数量 */}
              <input
                type="text"
                className={`aap-count${countErr ? ' aap-count-err' : ''}`}
                value={row.count}
                onChange={(e) => updateRow(row.id, { count: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && allValid) void handleSend() }}
                title={t('projectMonitor.assignAgent.countTitle')}
              />
              {/* 控件2：Agent 下拉 */}
              <div className="aap-agent-select-wrap">
                <button
                  className="aap-agent-select"
                  onClick={() => setDropdownRowId(isDropOpen ? null : row.id)}
                  type="button"
                >
                  {row.agentName} ▾
                </button>
                {isDropOpen && (
                  <div className="aap-agent-dropdown">
                    {/* 框 A：全局 & 自定义 */}
                    <div className="aap-agent-group">
                      <div className="aap-agent-group-title">{t('projectMonitor.assignAgent.groupGlobal')}</div>
                      {globalGroups.flatMap((g) => g.items.map((item) => ({ ...item, _group: g.label }))).length === 0 ? (
                        <div className="aap-agent-empty">{t('projectMonitor.assignAgent.none')}</div>
                      ) : (
                        globalGroups.flatMap((g) => g.items.map((item) => ({ ...item, _group: g.label }))).map((item) => (
                          <div
                            key={`${item._group}-${item.name}`}
                            className="aap-agent-item"
                            onClick={() => selectAgent(row.id, item.name)}
                          >
                            <span className="aap-agent-name">{item.name}</span>
                            <span className="aap-agent-model">{item.model}</span>
                          </div>
                        ))
                      )}
                    </div>
                    {/* 框 B：项目级 */}
                    <div className="aap-agent-group">
                      <div className="aap-agent-group-title">{t('projectMonitor.assignAgent.groupProject')}</div>
                      {projectAgents.length === 0 ? (
                        <div className="aap-agent-empty">{t('projectMonitor.assignAgent.noProjectAgents')}</div>
                      ) : (
                        projectAgents.map((item) => (
                          <div
                            key={item.name}
                            className="aap-agent-item"
                            onClick={() => selectAgent(row.id, item.name)}
                          >
                            <span className="aap-agent-name">{item.name}</span>
                            <span className="aap-agent-model">{item.model}</span>
                          </div>
                        ))
                      )}
                    </div>
                    {/* 框 C：插件（有才显示） */}
                    {pluginGroups.map((pg) => (
                      <div key={pg.pluginId ?? pg.label} className="aap-agent-group">
                        <div className="aap-agent-group-title">{t('projectMonitor.assignAgent.groupPlugin', { name: pg.pluginId ?? pg.label })}</div>
                        {pg.items.length === 0 ? (
                          <div className="aap-agent-empty">{t('projectMonitor.assignAgent.none')}</div>
                        ) : (
                          pg.items.map((item) => (
                            <div
                              key={item.name}
                              className="aap-agent-item"
                              onClick={() => selectAgent(row.id, item.name)}
                            >
                              <span className="aap-agent-name">{item.name}</span>
                              <span className="aap-agent-model">{item.model}</span>
                            </div>
                          ))
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* 控件3：任务描述 */}
              <input
                type="text"
                className="aap-task"
                value={row.task}
                placeholder={t('projectMonitor.assignAgent.taskPlaceholder')}
                onChange={(e) => updateRow(row.id, { task: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && allValid) void handleSend() }}
              />
            </div>
            {countErr && <div className="aap-count-errmsg">{countErr}</div>}
            {idx < rows.length - 1 && <div className="aap-row-divider" />}
          </div>
        )
      })}
      <div className="aap-footer">
        <button className="aap-add-btn" onClick={addRow} type="button">{t('projectMonitor.assignAgent.addRow')}</button>
        <button
          className="aap-send-btn"
          onClick={() => void handleSend()}
          disabled={!allValid}
          type="button"
        >
          {t('projectMonitor.assignAgent.send')}
        </button>
      </div>
    </div>
  )
}
