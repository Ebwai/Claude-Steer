// 使用方法：由 LeftPanel.tsx 在四层布局的层③位置渲染（仅有权限请求时可见）
// 编译说明：renderer 进程 browser bundle
// 代码说明：权限请求审批面板——显示 PermissionRequest Hook 产生的审批条目
//           用户点击同意/拒绝后，通过 PERMISSION_RESPOND IPC 向 PTY stdin 写入 y/n
//           多条请求按 FIFO 顺序堆叠显示，处理后自动移除

import React, { useState, useCallback } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { permissionRequestsAtom, type PermissionRequest } from '../../atoms/sessions.atom'
import { IPC } from '@shared/events/ipc-channels'
import { useT } from '../../i18n'
import './RequestApprovalPanel.css'

// ── 单条审批卡片 ──────────────────────────────────────────────────────────────

interface ApprovalCardProps {
  req: PermissionRequest
  onDone: (requestId: string) => void
}

function ApprovalCard({ req, onDone }: ApprovalCardProps): React.JSX.Element {
  const { t } = useT()
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
      onDone(req.requestId)
    } catch (err) {
      console.error('[ApprovalCard] PERMISSION_RESPOND failed:', err)
      setPending(null)
    }
  }, [req, message, onDone])

  // 单击同意/拒绝：若有 message 输入则展开输入框等待确认；否则直接发送
  const handleApprove = useCallback(() => {
    if (showInput && message.trim()) {
      void handleDecide(true)
    } else if (showInput) {
      // 输入框已展开但为空，直接同意
      void handleDecide(true)
    } else {
      // 先展开输入框，让用户可以附加信息后确认，也可再次点击直接发送
      setShowInput(true)
    }
  }, [showInput, message, handleDecide])

  const handleDeny = useCallback(() => {
    if (showInput) {
      void handleDecide(false)
    } else {
      setShowInput(true)
    }
  }, [showInput, handleDecide])

  // 展开后直接发送（不附加信息）
  const handleSendWithoutMessage = useCallback((approved: boolean) => {
    void handleDecide(approved)
  }, [handleDecide])

  return (
    <div className="rap-card">
      {/* 来源 + 操作描述 */}
      <div className="rap-header">
        <span className="rap-agent">{req.agentName}</span>
        <span className="rap-separator">{t('projectMonitor.approval.requestExecute')}</span>
        <span className="rap-tool">{req.toolName}</span>
      </div>
      <div className="rap-desc">{req.description}</div>

      {/* 附加信息输入框（点击按钮后展开） */}
      {showInput && (
        <div className="rap-input-area">
          <input
            className="rap-input"
            placeholder={t('projectMonitor.approval.additionalInfo')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleDecide(true)
              if (e.key === 'Escape') setShowInput(false)
            }}
            autoFocus
          />
        </div>
      )}

      {/* 操作按钮 */}
      <div className="rap-actions">
        {!showInput ? (
          <>
            <button
              className="rap-btn rap-btn--approve"
              onClick={handleApprove}
              disabled={!!pending}
            >
              {t('projectMonitor.approval.approve')}
            </button>
            <button
              className="rap-btn rap-btn--deny"
              onClick={handleDeny}
              disabled={!!pending}
            >
              {t('projectMonitor.approval.deny')}
            </button>
          </>
        ) : (
          <>
            <button
              className="rap-btn rap-btn--approve"
              onClick={() => void handleSendWithoutMessage(true)}
              disabled={!!pending}
            >
              {pending === 'approve' ? '…' : t('projectMonitor.approval.approve')}
            </button>
            {message.trim() && (
              <button
                className="rap-btn rap-btn--approve-msg"
                onClick={() => void handleDecide(true)}
                disabled={!!pending}
              >
                {t('projectMonitor.approval.approveWithMessage')}
              </button>
            )}
            <button
              className="rap-btn rap-btn--deny"
              onClick={() => void handleSendWithoutMessage(false)}
              disabled={!!pending}
            >
              {pending === 'deny' ? '…' : t('projectMonitor.approval.deny')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ── 审批面板主体 ──────────────────────────────────────────────────────────────

function RequestApprovalPanel(): React.JSX.Element {
  const { t } = useT()
  const requests = useAtomValue(permissionRequestsAtom)
  const setRequests = useSetAtom(permissionRequestsAtom)

  const handleDone = useCallback((requestId: string) => {
    setRequests((prev) => prev.filter((r) => r.requestId !== requestId))
  }, [setRequests])

  if (requests.length === 0) return <></>

  return (
    <div className="rap-panel">
      <div className="rap-title">
        <span className="rap-title-icon">⚠</span>
        <span>{t('projectMonitor.approval.permissionRequest')}</span>
        {requests.length > 1 && (
          <span className="rap-count">{requests.length}</span>
        )}
      </div>
      <div className="rap-list">
        {requests.map((req) => (
          <ApprovalCard key={req.requestId} req={req} onDone={handleDone} />
        ))}
      </div>
    </div>
  )
}

export default RequestApprovalPanel
