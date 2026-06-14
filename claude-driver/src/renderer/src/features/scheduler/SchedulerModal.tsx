// 使用方法：<SchedulerModal onClose={fn} />，由 RightPanel.tsx 在 showScheduler=true 时渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：定时触发 Modal——两 Tab（Claude介入 / 脚本触发）
//           Claude介入：选择已认领项目 → 填间隔 + 提示词 → 创建 loop session

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import Modal from '../../components/Modal/Modal'
import { claimedProjectsAtom } from '../../atoms/projects.atom'
import { schedulerTasksAtom, type SchedulerTask } from '../../atoms/scheduler.atom'
import { IPC } from '@shared/events/ipc-channels'
import { useT } from '../../i18n'
import './SchedulerModal.css'

type Tab = 'claude' | 'script'

interface SchedulerModalProps {
  onClose: () => void
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

function formatExpiry(createdAt: number): { days: number; expired: boolean } {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
  const diff = createdAt + SEVEN_DAYS - Date.now()
  if (diff <= 0) return { days: 0, expired: true }
  const days = Math.ceil(diff / (24 * 60 * 60 * 1000))
  return { days, expired: false }
}

function projectNameFromPath(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

// ── 任务卡片 ────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task: SchedulerTask
  onToggle: (projectPath: string, active: boolean) => void
  onDelete: (taskId: string) => void
  onRecreate: (task: SchedulerTask) => void
  toggling: boolean
}

function TaskCard({ task, onToggle, onDelete, onRecreate, toggling }: TaskCardProps): React.JSX.Element {
  const { t } = useT()
  const expiry = formatExpiry(task.createdAt)
  const expiryLabel = expiry.expired ? t('scheduler.expired') : t('scheduler.expiresInDays', { days: expiry.days })

  return (
    <div className="sm-task-item">
      <div className="sm-task-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span className={`sm-status-dot${task.isActive ? ' sm-status-dot--active' : ''}`} />
          <span className="sm-task-project">{projectNameFromPath(task.projectPath)}</span>
        </div>
        <div className="sm-task-actions">
          {expiry.expired ? (
            <button
              className="sm-btn-recreate"
              onClick={() => onRecreate(task)}
              disabled={toggling}
              title={t('scheduler.recreate')}
            >
              ↺ {t('scheduler.recreate')}
            </button>
          ) : (
            <label
              className="sm-toggle"
              title={
                !task.claudeId
                  ? t('scheduler.sessionInitHint')
                  : task.isActive ? t('scheduler.runningClickToPause') : t('scheduler.pausedClickToResume')
              }
            >
              <input
                type="checkbox"
                checked={task.isActive}
                disabled={toggling || !task.claudeId}
                onChange={(e) => onToggle(task.projectPath, e.target.checked)}
              />
              <span className="sm-toggle-track" />
            </label>
          )}
          <button
            className="sm-btn-delete"
            onClick={() => onDelete(task.taskId)}
            title={t('scheduler.deleteTask')}
          >
            🗑
          </button>
        </div>
      </div>

      <div className="sm-task-path">{task.projectPath}</div>

      <div className="sm-task-meta">
        <span className="sm-task-interval">{t('scheduler.everyN', { interval: task.interval })}</span>
        <span className="sm-task-prompt">{task.prompt.slice(0, 40)}{task.prompt.length > 40 ? '…' : ''}</span>
        <span className={`sm-task-expire${expiry.expired ? ' sm-task-expire--expired' : ''}`}>
          {expiryLabel}
        </span>
      </div>
    </div>
  )
}

// ── 主组件 ──────────────────────────────────────────────────────────────────

function SchedulerModal({ onClose }: SchedulerModalProps): React.JSX.Element {
  const { t } = useT()
  const [activeTab, setActiveTab] = useState<Tab>('claude')

  const claimedProjects = useAtomValue(claimedProjectsAtom)
  const tasks           = useAtomValue(schedulerTasksAtom)
  const setTasks        = useSetAtom(schedulerTasksAtom)

  // 创建表单状态
  const [selectedPath, setSelectedPath] = useState<string>('')
  const [interval, setInterval]         = useState('1h')
  const [prompt, setPrompt]             = useState('')
  const [creating, setCreating]         = useState(false)
  const [createError, setCreateError]   = useState('')

  // toggle 中的项目路径（避免重复操作）+ 错误信息
  const [togglingProject, setTogglingProject] = useState<string | null>(null)
  const [toggleError, setToggleError]         = useState('')

  // 项目列表（只取认领项目）
  const projectOptions = useMemo(() => Array.from(claimedProjects), [claimedProjects])

  // 初始化选中第一个项目
  useEffect(() => {
    if (!selectedPath && projectOptions.length > 0) {
      setSelectedPath(projectOptions[0].path)
    }
  }, [projectOptions, selectedPath])

  // 加载任务列表
  const loadTasks = useCallback(async () => {
    try {
      const res = await window.api.invoke(IPC.SCHEDULER_LIST) as { ok: boolean; tasks: SchedulerTask[] }
      if (res.ok) {
        setTasks(res.tasks)
      }
    } catch (err) {
      console.error('[Scheduler] list failed:', err)
    }
  }, [setTasks])

  // 初次加载 + 每 3s 轮询刷新 isActive（PTY 可能在后台退出）
  useEffect(() => {
    void loadTasks()
    const timer = window.setInterval(() => { void loadTasks() }, 3000)
    return () => window.clearInterval(timer)
  }, [loadTasks])

  // 创建任务
  const handleCreate = useCallback(async () => {
    if (!selectedPath || !interval.trim() || !prompt.trim()) return
    setCreating(true)
    setCreateError('')
    try {
      const res = await window.api.invoke(IPC.SCHEDULER_CREATE, {
        projectPath: selectedPath,
        interval: interval.trim(),
        prompt: prompt.trim(),
      }) as { ok: boolean; taskId?: string; error?: string }

      if (!res.ok) {
        setCreateError(res.error ?? t('scheduler.createFailed'))
        console.error('[Scheduler] create failed:', res.error)
      } else {
        console.log(`[Scheduler] task created: ${res.taskId}`)
        setPrompt('')
        await loadTasks()
      }
    } catch (err) {
      setCreateError(String(err))
      console.error('[Scheduler] create error:', err)
    } finally {
      setCreating(false)
    }
  }, [selectedPath, interval, prompt, loadTasks, t])

  // Toggle 暂停/恢复
  const handleToggle = useCallback(async (projectPath: string, active: boolean) => {
    setTogglingProject(projectPath)
    setToggleError('')
    try {
      const res = await window.api.invoke(IPC.SCHEDULER_TOGGLE, { projectPath, active }) as { ok: boolean; error?: string }
      if (!res.ok) {
        console.error('[Scheduler] toggle failed:', res.error)
        setToggleError(res.error ?? t('scheduler.operationFailed'))
      } else {
        console.log(`[Scheduler] toggle ${projectPath} → ${active ? 'active' : 'paused'}`)
        await loadTasks()
      }
    } catch (err) {
      console.error('[Scheduler] toggle error:', err)
      setToggleError(String(err))
    } finally {
      setTogglingProject(null)
    }
  }, [loadTasks, t])

  // 删除任务
  const handleDelete = useCallback(async (taskId: string) => {
    try {
      await window.api.invoke(IPC.SCHEDULER_DELETE, { taskId })
      console.log(`[Scheduler] task deleted: ${taskId}`)
      await loadTasks()
    } catch (err) {
      console.error('[Scheduler] delete error:', err)
    }
  }, [loadTasks])

  // 重新创建过期任务
  const handleRecreate = useCallback(async (task: SchedulerTask) => {
    setCreating(true)
    setCreateError('')
    try {
      const res = await window.api.invoke(IPC.SCHEDULER_CREATE, {
        projectPath: task.projectPath,
        interval: task.interval,
        prompt: task.prompt,
      }) as { ok: boolean; taskId?: string; error?: string }

      if (!res.ok) {
        setCreateError(res.error ?? t('scheduler.recreateFailed'))
        console.error('[Scheduler] recreate failed:', res.error)
      } else {
        // 删除旧的过期记录
        await window.api.invoke(IPC.SCHEDULER_DELETE, { taskId: task.taskId })
        console.log(`[Scheduler] recreated task: ${res.taskId} (old: ${task.taskId})`)
        await loadTasks()
      }
    } catch (err) {
      setCreateError(String(err))
      console.error('[Scheduler] recreate error:', err)
    } finally {
      setCreating(false)
    }
  }, [loadTasks, t])

  return (
    <Modal open={true} onClose={onClose} title={<><span>⏰</span> {t('scheduler.title')}</>} width={520}>
      {/* 负 margin 抵消 modal-body 的内边距，让 Tab 导航贴边 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0, margin: '-16px -18px' }}>
        {/* Tab 导航 */}
        <div className="sm-tabs">
          <div
            className={`sm-tab${activeTab === 'claude' ? ' sm-tab--active' : ''}`}
            onClick={() => setActiveTab('claude')}
          >
            {t('scheduler.tabClaude')}
          </div>
          <div
            className={`sm-tab${activeTab === 'script' ? ' sm-tab--active' : ''}`}
            onClick={() => setActiveTab('script')}
          >
            {t('scheduler.tabScript')}
          </div>
        </div>

        {/* 内容区 */}
        <div className="sm-body">
          {activeTab === 'script' && (
            <div className="sm-placeholder">
              <span className="sm-placeholder-icon">🚧</span>
              <span>{t('scheduler.comingSoon')}</span>
            </div>
          )}

          {activeTab === 'claude' && (
            <>
              {/* 创建表单 */}
              <div className="sm-form">
                <div className="sm-form-title">{t('scheduler.newTask')}</div>

                <div className="sm-field">
                  <span className="sm-label">{t('scheduler.project')}</span>
                  {projectOptions.length === 0 ? (
                    <span className="sm-hint">{t('scheduler.noClaimedProjects')}</span>
                  ) : (
                    <select
                      className="sm-select"
                      value={selectedPath}
                      onChange={(e) => setSelectedPath(e.target.value)}
                    >
                      {projectOptions.map((p) => (
                        <option key={p.path} value={p.path}>
                          {p.name} — {p.path}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="sm-field">
                  <span className="sm-label">{t('scheduler.interval')}</span>
                  <input
                    className="sm-input"
                    placeholder={t('scheduler.intervalPlaceholder')}
                    value={interval}
                    onChange={(e) => setInterval(e.target.value)}
                    style={{ width: 120 }}
                  />
                  <span className="sm-hint">{t('scheduler.intervalHint')}</span>
                </div>

                <div className="sm-field">
                  <span className="sm-label">{t('scheduler.prompt')}</span>
                  <textarea
                    className="sm-textarea"
                    placeholder={t('scheduler.promptPlaceholder')}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </div>

                {createError && <div className="sm-error">{createError}</div>}

                <button
                  className="sm-create-btn"
                  disabled={creating || !selectedPath || !interval.trim() || !prompt.trim()}
                  onClick={() => void handleCreate()}
                >
                  {creating ? t('scheduler.creating') : t('scheduler.createTask')}
                </button>
              </div>

              {/* 任务列表 */}
              <div className="sm-list-title">{t('scheduler.createdTasks', { count: tasks.length })}</div>
              {toggleError && <div className="sm-error">{toggleError}</div>}

              {tasks.length === 0 ? (
                <div className="sm-task-empty">{t('scheduler.noTasks')}</div>
              ) : (
                tasks.map((task) => (
                  <TaskCard
                    key={task.taskId}
                    task={task}
                    onToggle={handleToggle}
                    onDelete={handleDelete}
                    onRecreate={handleRecreate}
                    toggling={togglingProject === task.projectPath}
                  />
                ))
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

export default SchedulerModal
