// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedSession } from '@shared/types/managedSession'
import { managedSessionsAtom } from '@renderer/atoms/managed-sessions.atom'
import type { Session } from '@shared/types/index'
import SessionFrameNode, { type SessionFrameData } from '@renderer/features/project-monitor/canvas/SessionFrameNode'
import { createHistoryLayoutMeasurementGate } from '@renderer/hooks/historyLayoutMeasurementGate'

vi.mock('@xyflow/react', () => ({ Handle: () => null, Position: {}, useReactFlow: () => ({ updateNodeData: vi.fn() }), useUpdateNodeInternals: () => vi.fn() }))
vi.mock('@renderer/i18n', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/features/project-monitor/ProcessTimeline', () => ({ default: () => <div>timeline</div> }))

const session: Session = { id: 'pty', claudeId: 'frame', projectId: 'project', cwd: '/project', startedAt: 1, endedAt: 2, status: 'Completed', isPtyPlaceholder: true, transcriptPath: null, currentModel: null, tokenUsage: { current: null, max: null, usedPercentage: null }, worktreePath: null }
function show(overrides: Partial<SessionFrameData>, managed?: Partial<ManagedSession>): void {
  const data: SessionFrameData = { projectId: 'project', sessionId: 'frame', session, source: 'realtime', detailsState: 'resident', clusterId: 'frame', deleteDisabled: false, isDeleting: false, layoutMeasurementGate: createHistoryLayoutMeasurementGate(), agentLabel: 'Agent', agentColor: '#fff', isExpanded: true, estimatedHeight: 400, ...overrides }
  const store = createStore()
  if (managed) store.set(managedSessionsAtom, new Map([['launch', {
    launchId: 'launch', frameId: 'frame', attemptId: 'attempt', ptyId: 'pty', projectId: 'project', cwd: '/project',
    mode: 'primary', identityState: 'expected', transcriptState: 'waiting', terminalState: 'starting', lifecycle: 'starting',
    inputWriteStarted: false, compatibilityTried: false, bindingGeneration: 0, revision: 1, startedAt: 1, ...managed
  }]]))
  render(<Provider store={store}><SessionFrameNode id="frame" data={data} selected={false} /></Provider>)
}
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('session frame empty history', () => {
  it('shows a closed conversation rather than a history message for an ended startup shell', () => {
    show({})
    expect(screen.getByText('projectMonitor.canvas.startupClosed')).toBeTruthy()
    expect(screen.queryByText('projectMonitor.canvas.historyLoadFailed')).toBeNull()
  })
  it('keeps a new live conversation in the starting state', () => {
    show({ session: { ...session, status: 'Running', endedAt: null } })
    expect(screen.getByText('projectMonitor.leftPanel.starting')).toBeTruthy()
  })
  it('shows a ready new conversation and allows opening its terminal without a transcript', () => {
    show({ session: { ...session, status: 'Running', endedAt: null } }, { terminalState: 'ready' })
    expect(screen.getByText('projectMonitor.canvas.newSessionReady')).toBeTruthy()
    expect((screen.getByRole('button', { name: /projectMonitor.canvas.openTerminal$/ }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('projectMonitor.canvas.historyLoadFailed')).toBeNull()
  })
  it('shows the directory startup error instead of a history message', () => {
    show({}, { terminalState: 'exited', lifecycle: 'failed', transcriptState: 'unavailable', startupError: 'project-directory-missing', exitCode: 1 })
    expect(screen.getByRole('alert').textContent).toBe('projectMonitor.canvas.startupError.project-directory-missing')
    expect(screen.queryByText('projectMonitor.canvas.historyLoadFailed')).toBeNull()
  })
  it('shows an unconfirmed process failure separately from history loading', () => {
    show({}, { terminalState: 'exited', lifecycle: 'failed', transcriptState: 'unavailable', exitCode: 1 })
    expect(screen.getByRole('alert').textContent).toBe('projectMonitor.canvas.startupFailed')
  })
  it('preserves the error message for an actual history read failure', () => {
    show({ source: 'history', detailsState: 'error', session: { ...session, isPtyPlaceholder: false } })
    expect(screen.getByText('projectMonitor.canvas.historyLoadFailed')).toBeTruthy()
  })
  it('distinguishes a deleted history from a temporary read failure', () => {
    show({ source: 'history', detailsState: 'unavailable', session: { ...session, isPtyPlaceholder: false } })
    expect(screen.getByText('projectMonitor.canvas.historyUnavailable')).toBeTruthy()
    expect(screen.queryByText('projectMonitor.canvas.historyLoadFailed')).toBeNull()
  })
})
