// 使用方法：由 App.tsx 在 hash 路由 #/chat?sessionId=<id> 时渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：闲聊气泡窗口——接收 CHAT_MESSAGE（stream-json 解析结果），渲染用户/Claude 气泡
//           底部输入框发送 SESSION_INPUT，Enter 发送，Shift+Enter 换行

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { IPC } from '@shared/events/ipc-channels'
import { useT } from '../../i18n'
import './ChatPage.css'

interface ChatPageProps {
  sessionId: string
}

type Role = 'user' | 'assistant'

interface ChatBubble {
  id: string
  role: Role
  text: string
  /** assistant 消息是否还在流式追加中 */
  streaming?: boolean
}

// stream-json assistant 消息内容块
interface ContentBlock {
  type: string
  text?: string
}

function ChatPage({ sessionId }: ChatPageProps): React.JSX.Element {
  const { t } = useT()
  const [bubbles, setBubbles] = useState<ChatBubble[]>([])
  const [input, setInput] = useState('')
  const [ended, setEnded] = useState(false)
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 当前正在流式追加的 assistant bubble id
  const streamingIdRef = useRef<string | null>(null)

  // 新消息自动滚到底
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [bubbles])

  // 监听 CHAT_MESSAGE 推送
  useEffect(() => {
    if (!sessionId) return

    const off = window.api.on(IPC.CHAT_MESSAGE, (raw: unknown) => {
      const msg = raw as Record<string, unknown>
      console.log('[ChatPage] CHAT_MESSAGE:', msg)

      if (msg['type'] === 'system' && msg['subtype'] === 'exit') {
        setEnded(true)
        streamingIdRef.current = null
        return
      }

      // assistant 消息：提取 content[].text 拼接
      if (msg['type'] === 'assistant') {
        const message = msg['message'] as Record<string, unknown> | undefined
        const content = (message?.['content'] ?? msg['content']) as ContentBlock[] | undefined
        if (!content) return

        const text = content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
          .join('')

        if (!text) return

        setBubbles((prev) => {
          // 若当前有 streaming bubble，追加文本
          if (streamingIdRef.current) {
            return prev.map((b) =>
              b.id === streamingIdRef.current
                ? { ...b, text: b.text + text }
                : b
            )
          }
          // 否则新建一个 streaming bubble
          const id = `assistant-${Date.now()}`
          streamingIdRef.current = id
          setSending(false)
          return [...prev, { id, role: 'assistant', text, streaming: true }]
        })
        return
      }

      // result：流式结束标志，关闭 streaming 状态
      if (msg['type'] === 'result') {
        if (streamingIdRef.current) {
          setBubbles((prev) =>
            prev.map((b) =>
              b.id === streamingIdRef.current ? { ...b, streaming: false } : b
            )
          )
          streamingIdRef.current = null
        }
      }
    })

    return off
  }, [sessionId])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || ended || sending) return

    setInput('')
    setSending(true)
    streamingIdRef.current = null  // 清除上一轮 streaming 引用

    // 关闭上一条 assistant 气泡的 streaming 状态（防止追加到旧气泡）
    setBubbles((prev) => {
      const updated = prev.map((b) => b.streaming ? { ...b, streaming: false } : b)
      const id = `user-${Date.now()}`
      return [...updated, { id, role: 'user', text }]
    })

    try {
      await window.api.invoke(IPC.SESSION_INPUT, { sessionId, text })
    } catch (err) {
      console.error('[ChatPage] SESSION_INPUT failed:', err)
      setSending(false)
    }
  }, [input, sessionId, ended, sending])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }, [handleSend])

  // 自动调整 textarea 高度
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [])

  return (
    <div className="chat-page">
      {/* 顶部标题栏 */}
      <div className="chat-header">
        <span className="chat-header-icon">💬</span>
        <span className="chat-header-title">{t('chat.title')}</span>
        {ended && <span className="chat-header-ended">{t('chat.ended')}</span>}
      </div>

      {/* 消息列表 */}
      <div className="chat-messages">
        {bubbles.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">✦</div>
            <div className="chat-empty-tip">{t('chat.emptyTip')}</div>
          </div>
        )}
        {bubbles.map((bubble) => (
          <div key={bubble.id} className={`chat-bubble-wrap chat-bubble-wrap--${bubble.role}`}>
            {bubble.role === 'assistant' && (
              <div className="chat-avatar chat-avatar--assistant">C</div>
            )}
            <div className={`chat-bubble chat-bubble--${bubble.role}`}>
              <pre className="chat-bubble-text">{bubble.text}</pre>
              {bubble.streaming && <span className="chat-cursor">▍</span>}
            </div>
            {bubble.role === 'user' && (
              <div className="chat-avatar chat-avatar--user">{t('chat.userAvatar')}</div>
            )}
          </div>
        ))}
        {sending && streamingIdRef.current === null && (
          <div className="chat-bubble-wrap chat-bubble-wrap--assistant">
            <div className="chat-avatar chat-avatar--assistant">C</div>
            <div className="chat-bubble chat-bubble--assistant chat-bubble--thinking">
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-dot" />
              <span className="chat-thinking-dot" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 底部输入区 */}
      <div className="chat-input-area">
        <textarea
          ref={textareaRef}
          className="chat-input"
          placeholder={ended ? t('chat.sessionEnded') : t('chat.inputPlaceholder')}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          disabled={ended}
          rows={1}
        />
        <button
          className="chat-send-btn"
          onClick={() => { void handleSend() }}
          disabled={!input.trim() || ended || sending}
        >
          ↑
        </button>
      </div>
    </div>
  )
}

export default ChatPage
