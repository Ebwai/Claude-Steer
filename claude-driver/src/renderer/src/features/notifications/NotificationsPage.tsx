// 使用方法：由 App.tsx 在 activeTab === 'notifications' 时渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：消息通知页面根组件——左侧请求/信息列表 + 右侧详情面板
//           数据源：permissionRequestsAtom（权限请求）+ notificationQueueAtom（info 消息）

import React, { useState, useCallback, useMemo } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { permissionRequestsAtom, type PermissionRequest } from '../../atoms/permission.atom'
import { notificationQueueAtom } from '../../atoms/notification.atom'
import type { Notification } from '@shared/types/index'
import { dequeueRequest } from '../../capabilities/permissionQueue'
import { IPC } from '@shared/events/ipc-channels'
import { useT } from '../../i18n'
import './NotificationsPage.css'

// ════════════════════════════════════════════════
// 左侧：请求列表
// ════════════════════════════════════════════════

interface NotificationListProps {
  requests: PermissionRequest[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** bare=true 时只渲染条目，不渲染外层 div 和 header（用于嵌入父列表） */
  bare?: boolean
}

function NotificationList({ requests, selectedId, onSelect, bare }: NotificationListProps): React.JSX.Element {
  const { t } = useT()
  // FIFO 顺序（receivedAt 升序），按 agentName 分组
  const groups = useMemo(() => {
    const sorted = [...requests].sort((a, b) => a.receivedAt - b.receivedAt)
    const map = new Map<string, PermissionRequest[]>()
    for (const req of sorted) {
      const key = req.agentName
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(req)
    }
    return map
  }, [requests])

  const items = (
    <>
      {Array.from(groups.entries()).map(([agentName, groupItems]) => (
        <React.Fragment key={agentName}>
          <div className="nfp-group-header nfp-group-header-sub">
            <span className="nfp-group-dot" />
            <span>{agentName}</span>
          </div>
          {groupItems.map((req) => (
            <div
              key={req.requestId}
              className={`nfp-item${selectedId === req.requestId ? ' nfp-item--selected' : ''}`}
              onClick={() => onSelect(req.requestId)}
            >
              <span className="nfp-item-tool">{req.toolName}</span>
              <span className="nfp-item-desc">{req.description}</span>
            </div>
          ))}
        </React.Fragment>
      ))}
    </>
  )

  if (bare) return <>{items}</>

  if (requests.length === 0) {
    return (
      <div className="nfp-list">
        <div className="nfp-list-header">
          <span>{t('notifications.title')}</span>
        </div>
        <div className="nfp-empty">
          <span className="nfp-empty-icon">✓</span>
          <span>{t('notifications.empty')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="nfp-list">
      <div className="nfp-list-header">
        <span>{t('notifications.title')}</span>
        <span className="nfp-list-badge">{requests.length}</span>
      </div>
      {items}
    </div>
  )
}

// ════════════════════════════════════════════════
// 右侧：详情面板
// ════════════════════════════════════════════════

interface NotificationDetailProps {
  requestId: string | null
  requests: PermissionRequest[]
  onDone: (requestId: string) => void
}

function NotificationDetail({ requestId, requests, onDone }: NotificationDetailProps): React.JSX.Element {
  const { t } = useT()
  const [showExtra, setShowExtra] = useState(false)
  const [extraMsg, setExtraMsg] = useState('')
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState('')

  const req = requests.find((r) => r.requestId === requestId) ?? null

  const handleRespond = useCallback(async (approved: boolean, message: string) => {
    if (!req) return
    setPending(approved ? 'approve' : 'deny')
    setError('')
    try {
      await window.api.invoke(IPC.PERMISSION_RESPOND, {
        sessionId: req.sessionId,
        ptySessionId: req.ptySessionId,
        approved,
        message: message.trim() || undefined,
      })
      console.log(`[Notif] respond ok: ${req.requestId} approved=${approved}`)
      onDone(req.requestId)
    } catch (err) {
      console.error('[Notif] PERMISSION_RESPOND failed:', err)
      setError(t('notifications.sendFailed', { error: String(err).slice(0, 80) }))
      setPending(null)
    }
  }, [req, onDone])

  // req 切换时重置输入状态
  React.useEffect(() => {
    setShowExtra(false)
    setExtraMsg('')
    setPending(null)
    setError('')
  }, [requestId])

  if (!req) {
    return (
      <div className="nfp-detail">
        <div className="nfp-detail-placeholder">{t('notifications.selectHint')}</div>
      </div>
    )
  }

  const toolInputStr = JSON.stringify(req.toolInput, null, 2)
  const hasInput = toolInputStr !== '{}'

  return (
    <div className="nfp-detail">
      {/* 标题行 */}
      <div className="nfp-detail-title">
        <span className="nfp-detail-agent">{req.agentName}</span>
        <span className="nfp-detail-label">{t('notifications.requestExecution')}</span>
      </div>

      {/* 操作描述块 */}
      <div className="nfp-detail-body">
        <div className="nfp-detail-tool">{req.toolName}</div>
        <div className="nfp-detail-desc">{req.description}</div>
        {hasInput && (
          <details>
            <summary className="nfp-input-summary">{t('notifications.viewParams')}</summary>
            <pre className="nfp-input-json">{toolInputStr}</pre>
          </details>
        )}
      </div>

      <div className="nfp-divider" />

      {/* 附加信息输入区（可选展开） */}
      {showExtra && (
        <div className="nfp-extra-area">
          <span className="nfp-extra-label">{t('notifications.additionalInfo')}</span>
          <textarea
            className="nfp-extra-textarea"
            placeholder={t('notifications.additionalInfoPlaceholder')}
            value={extraMsg}
            onChange={(e) => setExtraMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleRespond(true, extraMsg)
              }
              if (e.key === 'Escape') setShowExtra(false)
            }}
            autoFocus
          />
        </div>
      )}

      {/* 操作按钮 */}
      <div className="nfp-actions">
        <button
          className="nfp-btn nfp-btn--approve"
          disabled={!!pending}
          onClick={() => {
            if (showExtra && extraMsg.trim()) {
              void handleRespond(true, extraMsg)
            } else if (showExtra) {
              void handleRespond(true, '')
            } else {
              void handleRespond(true, '')
            }
          }}
        >
          {pending === 'approve' ? '…' : t('notifications.approve')}
        </button>

        {!showExtra && (
          <button
            className="nfp-btn nfp-btn--approve-msg"
            disabled={!!pending}
            onClick={() => setShowExtra(true)}
          >
            {t('notifications.approveWithMsg')}
          </button>
        )}

        {showExtra && extraMsg.trim() && (
          <button
            className="nfp-btn nfp-btn--approve-msg"
            disabled={!!pending}
            onClick={() => void handleRespond(true, extraMsg)}
          >
            {t('notifications.approveWithMsg')}
          </button>
        )}

        <button
          className="nfp-btn nfp-btn--deny"
          disabled={!!pending}
          onClick={() => void handleRespond(false, '')}
        >
          {pending === 'deny' ? '…' : t('notifications.deny')}
        </button>
      </div>

      {error && <div className="nfp-error">{error}</div>}
    </div>
  )
}

// ════════════════════════════════════════════════
// Info 消息列表项（左侧）
// ════════════════════════════════════════════════

interface InfoItemProps {
  notif: Notification
  selected: boolean
  onClick: () => void
}

function InfoItem({ notif, selected, onClick }: InfoItemProps): React.JSX.Element {
  return (
    <div
      className={`nfp-item nfp-item-info${selected ? ' nfp-item--selected' : ''}`}
      onClick={onClick}
    >
      <span className="nfp-item-tool">{notif.title}</span>
      <span className="nfp-item-desc">{notif.message}</span>
    </div>
  )
}

// ════════════════════════════════════════════════
// Info 消息详情面板（右侧）
// ════════════════════════════════════════════════

interface InfoDetailProps {
  notif: Notification
  onDismiss: () => void
}

function InfoDetail({ notif, onDismiss }: InfoDetailProps): React.JSX.Element {
  const { t } = useT()
  const reportPath = notif.metadata?.['reportPath']

  const handleOpen = useCallback(async () => {
    if (!reportPath) return
    await window.api.invoke(IPC.OPEN_WEBVIEW, { filePath: reportPath, title: t('globalMonitor.soul.webviewTitle') })
  }, [reportPath])

  return (
    <div className="nfp-detail">
      <div className="nfp-detail-title">
        <span className="nfp-detail-agent nfp-detail-agent-info">{notif.title}</span>
      </div>

      <div className="nfp-detail-body">
        <div className="nfp-detail-desc">{notif.message}</div>
        {reportPath && (
          <div className="nfp-info-path">{reportPath}</div>
        )}
      </div>

      {reportPath && (
        <div className="nfp-actions">
          <button className="nfp-btn nfp-btn--open-report" onClick={handleOpen}>
            {t('notifications.openReport')}
          </button>
        </div>
      )}

      <div className="nfp-actions">
        <button className="nfp-btn nfp-btn--dismiss" onClick={onDismiss}>
          {t('notifications.read')}
        </button>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════
// 页面根组件
// ════════════════════════════════════════════════

function NotificationsPage(): React.JSX.Element {
  const { t } = useT()
  const store = useStore()
  const requests      = useAtomValue(permissionRequestsAtom)
  const notifQueue    = useAtomValue(notificationQueueAtom)
  const setNotifQueue = useSetAtom(notificationQueueAtom)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // info 类通知（未 resolved）
  const infoNotifs = useMemo(
    () => notifQueue.filter((n) => n.type === 'info' && !n.resolved),
    [notifQueue]
  )

  // 审批完成后：从 atom 移除 + 若当前选中项消失则清空选中
  const handleDone = useCallback((requestId: string) => {
    dequeueRequest(store, requestId)
    setSelectedId((prev) => (prev === requestId ? null : prev))
    console.log(`[Notif] dequeued: ${requestId}, remaining=${requests.length - 1}`)
  }, [store, requests.length])

  // 标记 info 通知已读（resolved=true，从左侧列表消失）
  const handleDismissInfo = useCallback((id: string) => {
    setNotifQueue((prev) => prev.map((n) => n.id === id ? { ...n, resolved: true } : n))
    setSelectedId((prev) => (prev === id ? null : prev))
  }, [setNotifQueue])

  // 自动选中第一条（列表有内容但无选中时）
  const allIds = useMemo(
    () => [...requests.map((r) => r.requestId), ...infoNotifs.map((n) => n.id)],
    [requests, infoNotifs]
  )
  React.useEffect(() => {
    if (!selectedId && requests.length > 0) {
      const first = [...requests].sort((a, b) => a.receivedAt - b.receivedAt)[0]
      setSelectedId(first.requestId)
    }
    // 选中项已被移除时清空
    if (selectedId && !allIds.includes(selectedId)) {
      setSelectedId(null)
    }
  }, [requests, infoNotifs, selectedId, allIds])

  const totalCount = requests.length + infoNotifs.length

  return (
    <div className="nfp-page">
      {/* 左侧列表 */}
      <div className="nfp-list">
        <div className="nfp-list-header">
          <span>{t('notifications.title')}</span>
          {totalCount > 0 && <span className="nfp-list-badge">{totalCount}</span>}
        </div>

        {totalCount === 0 && (
          <div className="nfp-empty">
            <span className="nfp-empty-icon">✓</span>
            <span>{t('notifications.empty')}</span>
          </div>
        )}

        {/* 权限请求分组 */}
        {requests.length > 0 && (
          <>
            <div className="nfp-group-header">
              <span className="nfp-group-dot" />
              <span>{t('notifications.pendingRequests')}</span>
            </div>
            <NotificationList
              requests={requests}
              selectedId={selectedId}
              onSelect={setSelectedId}
              bare
            />
          </>
        )}

        {/* info 消息分组 */}
        {infoNotifs.length > 0 && (
          <>
            <div className="nfp-group-header">
              <span className="nfp-group-dot nfp-group-dot-info" />
              <span>{t('notifications.systemMessages')}</span>
            </div>
            {infoNotifs.map((n) => (
              <InfoItem
                key={n.id}
                notif={n}
                selected={selectedId === n.id}
                onClick={() => setSelectedId(n.id)}
              />
            ))}
          </>
        )}
      </div>

      {/* 右侧详情 */}
      {(() => {
        const infoNotif = infoNotifs.find((n) => n.id === selectedId)
        if (infoNotif) {
          return <InfoDetail notif={infoNotif} onDismiss={() => handleDismissInfo(infoNotif.id)} />
        }
        return (
          <NotificationDetail
            requestId={selectedId}
            requests={requests}
            onDone={handleDone}
          />
        )
      })()}
    </div>
  )
}

export default NotificationsPage
