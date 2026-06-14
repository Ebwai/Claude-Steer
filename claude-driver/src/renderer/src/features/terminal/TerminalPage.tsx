// 使用方法：由 App.tsx 在 hash 路由 #/terminal?sessionId=<id> 时渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：独立终端窗口——使用 xterm.js 渲染 PTY 原始输出，接收 TERM_DATA 推送
//           用户输入通过 SESSION_INPUT IPC 转发给主进程 ptyManager

import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { IPC } from '@shared/events/ipc-channels'
import { useT } from '../../i18n'
import '@xterm/xterm/css/xterm.css'
import './TerminalPage.css'

interface TerminalPageProps {
  /** 对应的 PTY session UUID */
  sessionId: string
}

function TerminalPage({ sessionId }: TerminalPageProps): React.JSX.Element {
  const { t } = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current || !sessionId) return

    // ── 初始化 xterm.js ────────────────────────────────────────────────────
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: '#0f0f11',
        foreground: '#e0e0e0',
        cursor: '#DA7756',
        selectionBackground: 'rgba(218, 119, 86, 0.3)',
        black: '#1a1a1a',
        brightBlack: '#555555',
        white: '#cccccc',
        brightWhite: '#ffffff',
      },
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    // ── 用户键盘输入 → SESSION_INPUT（raw=true：原样发给 PTY，不追加 \r）────
    term.onData((data) => {
      void window.api.invoke(IPC.SESSION_INPUT, { sessionId, text: data, raw: true })
    })

    // ── 接收主进程推送的 PTY 输出 ────────────────────────────────────────────
    const unsub = window.api.on(IPC.TERM_DATA, (data: unknown) => {
      term.write(data as string)
    })

    // ── 窗口 resize → 通知主进程调整 PTY 尺寸 ─────────────────────────────
    const handleResize = (): void => {
      fitAddon.fit()
      void window.api.invoke(IPC.TERM_RESIZE, {
        sessionId,
        cols: term.cols,
        rows: term.rows,
      })
    }

    window.addEventListener('resize', handleResize)

    // 初始 resize 同步（等待 DOM 完成渲染后执行）
    const initialResizeId = requestAnimationFrame(() => {
      fitAddon.fit()
      void window.api.invoke(IPC.TERM_RESIZE, {
        sessionId,
        cols: term.cols,
        rows: term.rows,
      })
    })

    return () => {
      cancelAnimationFrame(initialResizeId)
      window.removeEventListener('resize', handleResize)
      unsub()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  return (
    <div className="term-page">
      <div className="term-titlebar">
        <span className="term-icon">⬛</span>
        <span className="term-label">{t('terminal.title')}</span>
        <span className="term-session-id">{sessionId.slice(0, 8)}</span>
      </div>
      <div ref={containerRef} className="term-container" />
    </div>
  )
}

export default TerminalPage
