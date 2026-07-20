// 使用方法：由 App.tsx 在 hash 路由 #/notifications 时渲染（独立通知窗口页面）
// 编译说明：renderer 进程 browser bundle
// 代码说明：独立通知窗口页根——自建 handler 工厂子集 + 项目分割 + 2 行通知项 + 展开详情
//           数据源：permissionRequestsAtom（权限请求）+ runningProjectsAtom（运行中项目）

import React, { useEffect, useState, useCallback } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { createPermissionHandler } from '../../business/permissionHandler'
import { createPtyBindHandler } from '../../business/ptyBindHandler'
import { createSessionLifecycle } from '../../business/sessionLifecycle'
import { runningProjectsAtom, projectsAtom, type RunningProject } from '../../atoms/projects.atom'
import { permissionRequestsAtom, type PermissionRequest } from '../../atoms/permission.atom'
import { dequeueRequest } from '../../capabilities/permissionQueue'
import { activeSessionsAtom } from '../../atoms/session-core.atom'
import { ptyBindingsAtom } from '../../atoms/pty-binding.atom'
import { IPC } from '@shared/events/ipc-channels'
import type { SessionStatus } from '@shared/types/index'
import { useT } from '../../i18n'
import { pathMatches } from '../../utils/pathUtils'
import './NotificationWindowPage.css'

// ── 辅助：将 toolInput 转为可读详情文本 ─────────────────────────

function buildDetailText(toolName: string, toolInput: Record<string, unknown>): string {
  if (!toolInput || Object.keys(toolInput).length === 0) return ''
  switch (toolName) {
    case 'Read':
      return [toolInput.filePath, toolInput.rangeLabel].filter(Boolean).join(' | ')
    case 'Write':
      return String(toolInput.filePath ?? '')
    case 'Edit':
      return [toolInput.filePath, toolInput.replaceAll === 'true' ? '(replaceAll)' : ''].filter(Boolean).join(' ')
    case 'MultiEdit':
      return `${toolInput.filePath ?? ''} (${toolInput.editCount ?? '?'} edits)`
    case 'Bash':
      return `$ ${toolInput.command ?? toolInput.description ?? ''}`
    case 'Grep':
      return `pattern: "${toolInput.pattern ?? ''}" in ${toolInput.searchPath ?? ''}`
    case 'Glob':
      return String(toolInput.pattern ?? '')
    case 'WebFetch':
      return String(toolInput.url ?? '')
    case 'WebSearch':
      return `query: ${toolInput.query ?? ''}`
    default:
      return toolInput.displayName
        ? `${toolInput.displayName} ${toolInput.description ?? ''}`
        : JSON.stringify(toolInput, null, 2)
  }
}

// ── 工具类型 → 颜色（复用历史面板 type 配色）─────────────────────

function getToolColor(toolName: string): string {
  // 工具类（action 层）：橙色 #e6430d
  const toolNames = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode']
  if (toolNames.includes(toolName) || toolName.startsWith('mcp__')) return '#e6430d'
  // 经验/交互类：棕色 #DA7756
  return '#DA7756'
}

// ════════════════════════════════════════════════════════════════
// 单条通知项（2 行布局）
// ════════════════════════════════════════════════════════════════

interface NotificationItemProps {
  req: PermissionRequest
}

function NotificationItem({ req }: NotificationItemProps): React.JSX.Element {
  const { t } = useT()
  const store = useStore()
  const [expanded, setExpanded] = useState(false)
  const [showInput, setShowInput] = useState(false)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null)

  const handleDecide = useCallback(async (approved: boolean) => {
    setPending(approved ? 'approve' : 'deny')
    try {
      await window.api.invoke(IPC.PERMISSION_RESPOND, {
        sessionId: req.sessionId,
        ptySessionId: req.ptySessionId,
        approved,
        message: message.trim() || undefined,
      })
      // IPC 成功后立即从列表移除（不等 PermissionDenied Hook，同意场景无 Hook）
      dequeueRequest(store, req.requestId)
    } catch (err) {
      console.error('[NW] PERMISSION_RESPOND failed:', err)
      setPending(null)
    }
  }, [req, message, store])

  const handleDismiss = useCallback(async () => {
    try {
      await window.api.invoke(IPC.PERMISSION_DISMISS, { requestId: req.requestId })
      // 关闭后从列表移除
      dequeueRequest(store, req.requestId)
    } catch (err) {
      console.error('[NW] PERMISSION_DISMISS failed:', err)
    }
  }, [req.requestId, store])

  const detailText = buildDetailText(req.toolName, req.toolInput as Record<string, unknown>)
  const hasDetail = !!detailText
  const toolColor = getToolColor(req.toolName)

  return (
    <div className="nw-item" style={{ borderLeftColor: toolColor }}>
      {/* Line 1: Agent框名称 + 调用名称 + 展开按钮 + 关闭按钮 */}
      <div className="nw-item-line1">
        <span className="nw-item-agent">{req.agentName}</span>
        <span className="nw-item-tool" style={{ color: toolColor }}>{req.toolName}</span>
        {hasDetail && (
          <button
            className="nw-item-expand"
            onClick={() => setExpanded(!expanded)}
            style={{ color: toolColor }}
          >
            {expanded ? '▲' : '▼'}
          </button>
        )}
        <button className="nw-item-dismiss" onClick={handleDismiss} disabled={!!pending}>✕</button>
      </div>

      {/* 展开详情（工具调用参数） */}
      {expanded && hasDetail && (
        <div className="nw-item-detail">
          <pre className="nw-item-json">{detailText}</pre>
          {req.description && req.description !== detailText && (
            <div className="nw-item-desc">{req.description}</div>
          )}
        </div>
      )}

      {/* Line 2: 4 交互 Yes/No（逻辑同 RequestApprovalPanel） */}
      <div className="nw-item-line2">
        {!showInput ? (
          <>
            <button className="nw-btn nw-btn--approve" onClick={() => setShowInput(true)} disabled={!!pending}>
              {t('projectMonitor.approval.approve')}
            </button>
            <button className="nw-btn nw-btn--deny" onClick={() => setShowInput(true)} disabled={!!pending}>
              {t('projectMonitor.approval.deny')}
            </button>
          </>
        ) : (
          <>
            <input
              className="nw-input"
              placeholder={t('projectMonitor.approval.additionalInfo')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleDecide(true)
                if (e.key === 'Escape') setShowInput(false)
              }}
              autoFocus
            />
            <button className="nw-btn nw-btn--approve" onClick={() => void handleDecide(true)} disabled={!!pending}>
              {pending === 'approve' ? '…' : t('projectMonitor.approval.approve')}
            </button>
            {message.trim() && (
              <button className="nw-btn nw-btn--approve-msg" onClick={() => void handleDecide(true)} disabled={!!pending}>
                {t('projectMonitor.approval.approveWithMessage')}
              </button>
            )}
            <button className="nw-btn nw-btn--deny" onClick={() => void handleDecide(false)} disabled={!!pending}>
              {pending === 'deny' ? '…' : t('projectMonitor.approval.deny')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// 系统通知项（insight 完成等 info 类型）
// ════════════════════════════════════════════════════════════════

interface InsightNotification {
  id: string
  title: string
  message: string
  reportPath: string
  createdAt: number
}

// ════════════════════════════════════════════════════════════════
// 主页面
// ════════════════════════════════════════════════════════════════

export default function NotificationWindowPage(): React.JSX.Element {
  const store = useStore()
  const { t } = useT()
  const [insightNotifs, setInsightNotifs] = useState<InsightNotification[]>([])

  // 注册 handler 工厂子集（不使用 ref 防护——React StrictMode double-invoke 下 ref 会导致 handlers 丢失）
  useEffect(() => {
    const permHandler = createPermissionHandler(store)
    const unsubs1 = permHandler.register()

    const ptyBindHandler = createPtyBindHandler(store)
    const unsubs2 = ptyBindHandler.register()

    const sessionLifecycle = createSessionLifecycle(store)
    const unsubs3 = sessionLifecycle.register()

    // 加载项目列表
    void window.api.invoke(IPC.PROJECT_LIST).then((raw: unknown) => {
      const projects = (raw as import('@shared/types/index').Project[]) ?? []
      const map = new Map(projects.map(p => [p.id, p]))
      store.set(projectsAtom, map)
    })

    // 监听 SESSION_STATUS：更新 activeSessionsAtom 状态（Running → Completed/Interrupted）
    // PTY_UNBIND 由主进程 onExit 直接发送，handleUnbind 负责 removeFromRealtime 清理 ptySessionIdsAtom
    const unsubSessionStatus = window.api.on(IPC.SESSION_STATUS, (data: unknown) => {
      const { sessionId: rawId, status } = data as { sessionId: string; status?: SessionStatus }
      if (!status) return
      const ptyBindings = store.get(ptyBindingsAtom)
      const claudeId = ptyBindings.ptyToClaudeMap.get(rawId) ?? rawId
      store.set(activeSessionsAtom, (prev) => {
        const session = prev.get(claudeId)
        if (!session) return prev
        const next = new Map(prev)
        next.set(claudeId, {
          ...session,
          status,
          endedAt: status === 'Completed' || status === 'Interrupted' ? Date.now() : session.endedAt,
        })
        return next
      })
    })

    // 监听 INSIGHT_REPORT_READY：insight 报告生成完成
    const unsubInsight = window.api.on(IPC.INSIGHT_REPORT_READY, (...args: unknown[]) => {
      const payload = args[0] as { filePath: string }
      setInsightNotifs((prev) => {
        const id = `insight-${payload.filePath}`
        if (prev.some((n) => n.id === id)) return prev  // 去重
        return [...prev, {
          id,
          title: t('globalMonitor.soul.insightReadyTitle'),
          message: t('globalMonitor.soul.insightReadyMessage'),
          reportPath: payload.filePath,
          createdAt: Date.now(),
        }]
      })
    })

    return () => {
      unsubs1.forEach(fn => fn())
      unsubs2.forEach(fn => fn())
      unsubs3.forEach(fn => fn())
      unsubSessionStatus()
      unsubInsight()
    }
  }, [store])

  const runningProjects = useAtomValue(runningProjectsAtom)
  const requests = useAtomValue(permissionRequestsAtom)
  const activeSessions = useAtomValue(activeSessionsAtom)
  const allProjects = useAtomValue(projectsAtom)

  // 按项目分组请求（sessionId -> projectId via pathMatches）
  const requestsByProject = new Map<string, PermissionRequest[]>()
  const unknownRequests: PermissionRequest[] = []

  for (const req of requests) {
    const session = activeSessions.get(req.sessionId)
    let matchedProjectId = ''
    if (session) {
      for (const rp of runningProjects) {
        const project = allProjects.get(rp.projectId)
        if (project && pathMatches(session.cwd, project.path)) {
          matchedProjectId = rp.projectId
          break
        }
      }
    }
    if (matchedProjectId) {
      if (!requestsByProject.has(matchedProjectId)) requestsByProject.set(matchedProjectId, [])
      requestsByProject.get(matchedProjectId)!.push(req)
    } else {
      unknownRequests.push(req)
    }
  }

  const dismissInsight = useCallback((id: string) => {
    setInsightNotifs((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const openReport = useCallback(async (filePath: string) => {
    await window.api.invoke(IPC.OPEN_WEBVIEW, { filePath, title: 'Insight Report' })
  }, [])

  return (
    <div className="nw-container">
      {/* 空状态 */}
      {runningProjects.length === 0 && requests.length === 0 && insightNotifs.length === 0 && (
        <div className="nw-empty">
          <span className="nw-empty-icon">✓</span>
          <span>{t('notifications.empty')}</span>
        </div>
      )}

      {/* 按运行中项目分割 */}
      {runningProjects.map((rp: RunningProject) => {
        const projectRequests = requestsByProject.get(rp.projectId) ?? []
        return (
          <div key={rp.projectId} className="nw-project-section">
            <div className="nw-project-header">
              <span className="nw-project-name">{rp.name}</span>
              {projectRequests.length > 0 && (
                <span className="nw-project-badge">{projectRequests.length}</span>
              )}
            </div>
            <div className="nw-project-list">
              {projectRequests.map((req: PermissionRequest) => (
                <NotificationItem key={req.requestId} req={req} />
              ))}
              {projectRequests.length === 0 && (
                <div className="nw-project-empty">{t('notifications.noRequests')}</div>
              )}
            </div>
          </div>
        )
      })}

      {/* 未匹配项目的请求（兜底区） */}
      {unknownRequests.length > 0 && (
        <div className="nw-project-section">
          <div className="nw-project-header">
            <span className="nw-project-name">{t('notifications.otherRequests')}</span>
            <span className="nw-project-badge">{unknownRequests.length}</span>
          </div>
          <div className="nw-project-list">
            {unknownRequests.map((req: PermissionRequest) => (
              <NotificationItem key={req.requestId} req={req} />
            ))}
          </div>
        </div>
      )}

      {/* 系统通知（insight 完成等） */}
      {insightNotifs.length > 0 && (
        <div className="nw-project-section">
          <div className="nw-project-header">
            <span className="nw-project-name">{t('notifications.systemMessages')}</span>
            <span className="nw-project-badge">{insightNotifs.length}</span>
          </div>
          <div className="nw-project-list">
            {insightNotifs.map((n) => (
              <div key={n.id} className="nw-item" style={{ borderLeftColor: '#4fc3f7' }}>
                <div className="nw-item-line1">
                  <span className="nw-item-tool" style={{ color: '#4fc3f7' }}>{n.title}</span>
                  <button className="nw-item-dismiss" onClick={() => dismissInsight(n.id)}>✕</button>
                </div>
                <div className="nw-item-line2">
                  <button className="nw-btn nw-btn--approve" onClick={() => void openReport(n.reportPath)}>
                    {t('notifications.openReport')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
