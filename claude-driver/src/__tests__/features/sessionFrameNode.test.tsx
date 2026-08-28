// @vitest-environment jsdom
// 使用方法：npm test -- src/__tests__/features/sessionFrameNode.test.tsx
// 编译说明：Vitest + Testing Library；ReactFlow、Jotai 与重型时间线使用边界 mock
// 代码说明：验证 Agent 工作框顶部栏底部按钮的统一 intent、可访问性与事件传播隔离。

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- JSX transform compatibility
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SessionFrameNode from '@renderer/features/project-monitor/canvas/SessionFrameNode'
import type { SessionFrameData } from '@renderer/features/project-monitor/canvas/SessionFrameNode'

const mocks = vi.hoisted(() => ({
  updateNodeData: vi.fn(),
  updateNodeInternals: vi.fn(),
  setHeight: vi.fn(),
  setAllHeights: vi.fn(),
  useAtomValue: vi.fn(),
  useSetAtom: vi.fn(),
  useFocusBottom: vi.fn(),
  useRequestDelete: vi.fn()
}))

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  useReactFlow: () => ({ updateNodeData: mocks.updateNodeData }),
  useUpdateNodeInternals: () => mocks.updateNodeInternals
}))

vi.mock('jotai', () => ({
  useAtomValue: mocks.useAtomValue,
  useSetAtom: mocks.useSetAtom
}))

vi.mock('@renderer/atoms/sessions.atom', () => ({
  activeSessionsAtom: { kind: 'active-sessions' },
  sessionFrameHeightsAtom: (sessionId: string) => ({ kind: 'session-height', sessionId }),
  sessionRelationsAtom: { kind: 'relations' }
}))

vi.mock('@renderer/atoms/agent-block.atom', () => ({
  allFrameHeightsAtom: { kind: 'all-frame-heights' }
}))

vi.mock('@renderer/atoms/stats.atom', () => ({
  sessionTokensAtom: (sessionId: string) => ({ kind: 'session-tokens', sessionId })
}))

vi.mock('@renderer/atoms/token-inventory.atom', () => ({
  tokenInventoryAtom: { kind: 'token-inventory' }
}))

vi.mock('@renderer/atoms/projects.atom', () => ({
  projectByIdAtom: (projectId: string) => ({ kind: 'project', projectId }),
  milestonesByProjectAtom: (projectId: string) => ({ kind: 'milestones', projectId })
}))

vi.mock('@renderer/hooks/useSessionFrameLayout', () => ({
  FRAME_HEADER_HEIGHT: 40,
  computeFrozenOffset: () => 100
}))

vi.mock('@renderer/capabilities/sessionResumeCapability', () => ({
  buildSessionResumePayload: () => null,
  resolveSessionFrameProjectId: (projectId: string) => projectId
}))

vi.mock('@renderer/i18n', () => ({
  useT: () => ({
    t: (key: string) => key === 'projectMonitor.canvas.jumpToBottom' ? 'Jump to bottom' : key
  })
}))

vi.mock('@renderer/features/project-monitor/ProcessTimeline', () => ({
  default: () => null
}))

function makeData(source: 'realtime' | 'history'): SessionFrameData {
  return {
    projectId: 'project-1',
    sessionId: 'session-agent-1',
    ptyId: source === 'realtime' ? 'pty-1' : undefined,
    session: {
      projectId: 'project-1',
      status: 'Completed',
      startedAt: 0
    } as SessionFrameData['session'],
    source,
    detailsState: source === 'history' ? 'resident' : 'resident',
    clusterId: 'cluster-1',
    deleteDisabled: false,
    isDeleting: false,
    layoutMeasurementGate: {
      blocked: false,
      unblockedListeners: new Set()
    },
    agentLabel: 'Agent 1',
    agentColor: '#35C98A',
    isExpanded: true,
    estimatedHeight: 300,
    onFocusBottom: mocks.useFocusBottom,
    onRequestDelete: mocks.useRequestDelete
  }
}

describe('SessionFrameNode bottom navigation button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useAtomValue.mockImplementation((atom: { kind?: string }) => {
      switch (atom.kind) {
        case 'active-sessions': return new Map()
        case 'relations': return new Map()
        case 'project': return { id: 'project-1' }
        case 'session-tokens': return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
        case 'token-inventory': return new Map()
        case 'milestones': return []
        default: return undefined
      }
    })
    mocks.useSetAtom.mockImplementation((atom: { kind?: string }) => {
      if (atom.kind === 'session-height') return mocks.setHeight
      return mocks.setAllHeights
    })
    vi.stubGlobal('ResizeObserver', class {
      observe(): void { return undefined }
      disconnect(): void { return undefined }
    })
  })

  it.each(['realtime', 'history'] as const)('renders and dispatches one bottom intent for %s frames', (source) => {
    const onCanvasClick = vi.fn()
    const onCanvasMouseDown = vi.fn()

    render(
      <div onClick={onCanvasClick} onMouseDown={onCanvasMouseDown}>
        <SessionFrameNode id="node-1" data={makeData(source)} selected={false} />
      </div>
    )

    const button = screen.getByRole('button', { name: 'Jump to bottom' })
    expect(button).toHaveAttribute('title', 'Jump to bottom')

    fireEvent.mouseDown(button)
    fireEvent.click(button)

    expect(mocks.useFocusBottom).toHaveBeenCalledTimes(1)
    expect(mocks.useFocusBottom).toHaveBeenCalledWith('session-agent-1')
    expect(onCanvasMouseDown).not.toHaveBeenCalled()
    expect(onCanvasClick).not.toHaveBeenCalled()
  })
})
