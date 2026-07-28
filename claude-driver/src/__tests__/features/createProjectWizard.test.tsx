// @vitest-environment jsdom
// 使用方法：npm test -- src/__tests__/features/createProjectWizard.test.tsx
// 编译说明：Vitest + Testing Library
// 代码说明：创建项目向导目录准备、已有目录确认和 Step 3 双路径回归测试

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/events/ipc-channels'
import type { Project } from '@shared/types/index'
import CreateProjectWizard from '@renderer/features/global-monitor/CreateProjectWizard'

// 该测试环境使用经典 JSX 运行时，React 导入在运行期由 JSX 隐式使用。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react'

const PROJECT: Project = {
  id: 'C:/projects/demo',
  name: 'demo',
  path: 'C:/projects/demo',
  claimStatus: 1,
  isGitRepo: false,
  activeSessionId: null,
  sessionIds: [],
  lastActiveAt: 1,
}

const invoke = vi.fn()

function installApiMock(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { invoke },
  })
}

function fillStep1(): void {
  fireEvent.change(screen.getByPlaceholderText('如：my-project'), {
    target: { value: 'demo' },
  })
  fireEvent.change(screen.getByPlaceholderText('选择父目录，如 /home/user/projects'), {
    target: { value: 'C:/projects' },
  })
}

async function enterStep3(): Promise<void> {
  fillStep1()
  fireEvent.click(screen.getByRole('button', { name: '下一步 →' }))
  await screen.findByRole('button', { name: '打开文件夹' })
  fireEvent.click(screen.getByRole('button', { name: '下一步 →' }))
  await screen.findByText('制定计划')
}

describe('CreateProjectWizard', () => {
  beforeEach(() => {
    invoke.mockReset()
    installApiMock()
  })

  it('creates the directory before entering Step 2', async () => {
    invoke.mockResolvedValueOnce({ ok: true, status: 'created' })
    render(<CreateProjectWizard onClose={vi.fn()} onComplete={vi.fn()} />)

    fillStep1()
    fireEvent.click(screen.getByRole('button', { name: '下一步 →' }))

    await screen.findByRole('button', { name: '打开文件夹' })
    expect(invoke).toHaveBeenCalledWith(IPC.PROJECT_PREPARE_DIR, {
      path: 'C:/projects/demo',
    })
  })

  it('asks before using an existing directory and supports cancel/continue', async () => {
    invoke.mockResolvedValueOnce({ ok: true, status: 'exists' })
    render(<CreateProjectWizard onClose={vi.fn()} onComplete={vi.fn()} />)

    fillStep1()
    fireEvent.click(screen.getByRole('button', { name: '下一步 →' }))

    await screen.findByText('项目文件夹已存在')
    expect(screen.getByText('继续的话会覆盖现有文件夹里的内容。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByText('项目文件夹已存在')).not.toBeInTheDocument()
    expect(screen.getByText('项目设置')).toBeInTheDocument()

    invoke.mockResolvedValueOnce({ ok: true, status: 'exists' })
    fireEvent.click(screen.getByRole('button', { name: '下一步 →' }))
    await screen.findByText('项目文件夹已存在')
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(await screen.findByRole('button', { name: '打开文件夹' })).toBeInTheDocument()
  })

  it('skip initializes the project without starting a Session and navigates', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.PROJECT_PREPARE_DIR) return { ok: true, status: 'created' }
      if (channel === IPC.PROJECT_CREATE) return { ok: true, project: PROJECT }
      if (channel === IPC.PROJECT_LIST) return [PROJECT]
      throw new Error(`Unexpected channel: ${channel}`)
    })
    const onComplete = vi.fn()
    render(<CreateProjectWizard onClose={vi.fn()} onComplete={onComplete} />)

    await enterStep3()
    const skip = screen.getByRole('button', { name: '跳过' })
    expect(skip).toHaveAttribute('title', '仅完成项目创建，稍后可在项目监控页启动 Session')
    fireEvent.click(skip)

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(PROJECT.id))
    expect(invoke).not.toHaveBeenCalledWith(IPC.SESSION_START, expect.anything())
    expect(invoke).not.toHaveBeenCalledWith(IPC.SESSION_INPUT, expect.anything())
  })

  it('start-now Session failure still navigates without sending a goal', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.PROJECT_PREPARE_DIR) return { ok: true, status: 'created' }
      if (channel === IPC.PROJECT_CREATE) return { ok: true, project: PROJECT }
      if (channel === IPC.PROJECT_LIST) return [PROJECT]
      if (channel === IPC.SESSION_START) return { ok: false, error: 'spawn failed' }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    const onComplete = vi.fn()
    render(<CreateProjectWizard onClose={vi.fn()} onComplete={onComplete} />)

    await enterStep3()
    fireEvent.change(screen.getByPlaceholderText(/帮我为这个项目制定详细的开发计划/), {
      target: { value: '完成首个里程碑' },
    })
    const startNow = screen.getByRole('button', { name: '现在制定目标 ▶' })
    expect(startNow).toHaveAttribute('title', '立即打开首个 Session，并自动发送目标框内容')
    fireEvent.click(startNow)

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(PROJECT.id))
    expect(invoke).toHaveBeenCalledWith(IPC.SESSION_START, {
      projectId: PROJECT.id,
      projectPath: PROJECT.path,
      permissionMode: 'acceptEdits',
    })
    expect(invoke).not.toHaveBeenCalledWith(IPC.SESSION_INPUT, expect.anything())
  })

  it('start-now opens the first Session and sends the goal', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.PROJECT_PREPARE_DIR) return { ok: true, status: 'created' }
      if (channel === IPC.PROJECT_CREATE) return { ok: true, project: PROJECT }
      if (channel === IPC.PROJECT_LIST) return [PROJECT]
      if (channel === IPC.SESSION_START) return { ok: true, sessionId: 'session-1' }
      if (channel === IPC.SESSION_INPUT) return { ok: true }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    const onComplete = vi.fn()
    render(<CreateProjectWizard onClose={vi.fn()} onComplete={onComplete} />)

    await enterStep3()
    fireEvent.change(screen.getByPlaceholderText(/帮我为这个项目制定详细的开发计划/), {
      target: { value: '完成首个里程碑' },
    })
    fireEvent.click(screen.getByRole('button', { name: '现在制定目标 ▶' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(PROJECT.id))
    expect(invoke).toHaveBeenCalledWith(IPC.SESSION_INPUT, {
      sessionId: 'session-1',
      text: expect.stringContaining('完成首个里程碑'),
    })
  })
})
