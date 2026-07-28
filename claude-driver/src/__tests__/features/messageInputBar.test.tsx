// @vitest-environment jsdom
// 使用方法：npm test -- src/__tests__/features/messageInputBar.test.tsx
// 编译说明：Vitest + Testing Library
// 代码说明：验证实时区域输入框发送正文时不附加额外换行。

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/events/ipc-channels'
import MessageInputBar from '@renderer/features/project-monitor/MessageInputBar'

// 该测试环境使用经典 JSX 运行时，React 导入在运行期由 JSX 隐式使用。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react'

const invoke = vi.fn()

function renderInput(): ReturnType<typeof render> {
  return render(
    <MessageInputBar
      sessionId="session-1"
      isRunning
      agentLabel="Agent1"
    />,
  )
}

describe('MessageInputBar', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { invoke },
    })
  })

  it('sends trimmed text without appending a trailing newline', async () => {
    const { container } = renderInput()
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, {
      target: { value: '  第一行\n第二行  ' },
    })
    fireEvent.click(container.querySelector('.msgbar-btn-send') as HTMLButtonElement)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC.SESSION_INPUT, {
        sessionId: 'session-1',
        text: '第一行\n第二行',
      })
    })
  })

  it('uses the same payload when sent with Ctrl+Enter', async () => {
    renderInput()
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, {
      target: { value: '目标内容\n' },
    })
    fireEvent.keyDown(textarea, {
      key: 'Enter',
      ctrlKey: true,
    })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(IPC.SESSION_INPUT, {
        sessionId: 'session-1',
        text: '目标内容',
      })
    })
  })
})
