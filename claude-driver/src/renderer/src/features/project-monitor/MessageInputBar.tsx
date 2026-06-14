// 使用方法：由 ProjectMonitorPage.tsx 渲染在左半区域底部
// 编译说明：renderer 进程 browser bundle
// 代码说明：消息输入行——向当前 session 发送消息（Ctrl+Enter 发送）+ 打断按钮

import React, { useState, useCallback, useRef } from 'react'
import { useT } from '../../i18n'
import { IPC } from '@shared/events/ipc-channels'
import './MessageInputBar.css'

interface MessageInputBarProps {
  sessionId: string | null
  isRunning: boolean
  /** Agent 标识标签（如 "Agent1"），多 Agent 并行时显示 */
  agentLabel?: string
  /** Agent 标识色（CSS 颜色字符串） */
  agentColor?: string
  /** 消息发送成功后回调（用于父组件将 session 状态从 Paused 重置回 Running） */
  onSent?: () => void
}

function MessageInputBar({ sessionId, isRunning, agentLabel, agentColor, onSent }: MessageInputBarProps): React.JSX.Element {
  const { t } = useT()
  const [text, setText]         = useState('')
  const [sending, setSending]   = useState(false)
  const textareaRef             = useRef<HTMLTextAreaElement>(null)

  const canSend = !!sessionId && isRunning && text.trim().length > 0 && !sending

  const handleSend = useCallback(async () => {
    if (!canSend) return
    setSending(true)
    try {
      await window.api.invoke(IPC.SESSION_INPUT, {
        sessionId,
        text: text.trim() + '\n',
      })
      setText('')
      textareaRef.current?.focus()
      onSent?.()
    } catch (err) {
      console.error('[MessageInputBar] send failed:', err)
    } finally {
      setSending(false)
    }
  }, [canSend, sessionId, text])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void handleSend()
    }
  }, [handleSend])

  const handleInterrupt = useCallback(async () => {
    if (!sessionId) return
    try {
      await window.api.invoke(IPC.SESSION_STOP, { sessionId })
    } catch (err) {
      console.error('[MessageInputBar] interrupt failed:', err)
    }
  }, [sessionId])

  return (
    <div className="msgbar">
      {agentLabel && (
        <div className="msgbar-agent-row">
          <span className="msgbar-agent-dot" style={{ backgroundColor: agentColor }} />
          <span className="msgbar-agent-name" style={{ color: agentColor }}>{agentLabel}</span>
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="msgbar-textarea"
        rows={3}
        placeholder={
          !sessionId ? t('projectMonitor.inputBar.noActiveSession') :
          !isRunning ? t('projectMonitor.inputBar.sessionEnded') :
          t('projectMonitor.inputBar.placeholder')
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={!sessionId || !isRunning}
      />
      <div className="msgbar-footer">
        <span className="msgbar-hint">
          {canSend ? t('projectMonitor.inputBar.ctrlEnterToSend') : ''}
        </span>
        <div className="msgbar-btns">
          {sessionId && isRunning && (
            <button className="msgbar-btn-interrupt" onClick={handleInterrupt}>
              ⏹ {t('projectMonitor.inputBar.interrupt')}
            </button>
          )}
          <button
            className="msgbar-btn-send"
            onClick={() => void handleSend()}
            disabled={!canSend}
          >
            {sending ? t('projectMonitor.inputBar.sending') : t('projectMonitor.inputBar.send')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default MessageInputBar
