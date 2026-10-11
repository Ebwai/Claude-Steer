import { describe, expect, it } from 'vitest'
import { createStore } from 'jotai'
import type { ManagedSession } from '@shared/types/managedSession'
import { applyManagedChange, applyManagedSnapshot, resolveContentSessionId } from '@renderer/capabilities/managedSessionCapability'
import { displaySessionsAtom, managedSessionsAtom } from '@renderer/atoms/managed-sessions.atom'
import { activeSessionsAtom, ptySessionIdsAtom } from '@renderer/atoms/session-core.atom'
import { pendingPtyStartsAtom } from '@renderer/atoms/pending-starts.atom'
import { createPtyBindHandler } from '@renderer/business/ptyBindHandler'

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return { launchId: 'launch', frameId: 'frame', attemptId: 'attempt', ptyId: 'pty', projectId: 'project', cwd: '/project',
    expectedClaudeId: 'expected', mode: 'primary', identityState: 'expected', transcriptState: 'waiting', terminalState: 'starting',
    lifecycle: 'starting', inputWriteStarted: false, compatibilityTried: false, bindingGeneration: 0, revision: 1, startedAt: 123, ...overrides }
}

describe('managed session projection', () => {
  it('does not resurrect released shells from a delayed older snapshot', () => {
    const store = createStore()
    applyManagedSnapshot(store, { instanceId: 'main', revision: 1, sessions: [session({ terminalState: 'exited', lifecycle: 'ended' })] })
    applyManagedSnapshot(store, { instanceId: 'main', revision: 2, sessions: [] })
    applyManagedSnapshot(store, { instanceId: 'main', revision: 1, sessions: [session()] })
    expect(store.get(managedSessionsAtom).size).toBe(0)
  })

  it('does not let old final-exit evidence remove a resumed session from realtime', () => {
    const store = createStore()
    applyManagedChange(store, { instanceId: 'main', revision: 1, session: session({ confirmedClaudeId: 'actual', identityState: 'confirmed', lifecycle: 'active' }) })
    applyManagedChange(store, { instanceId: 'main', revision: 2, session: session({ launchId: 'resumed', attemptId: 'new', ptyId: 'new-pty', confirmedClaudeId: 'actual', identityState: 'confirmed', lifecycle: 'active', revision: 2 }) })
    applyManagedChange(store, { instanceId: 'main', revision: 3, session: session({ confirmedClaudeId: 'actual', terminalState: 'exited', lifecycle: 'ended', transcriptState: 'ready', revision: 3 }) })
    expect(store.get(ptySessionIdsAtom).has('actual')).toBe(true)
    expect(store.get(activeSessionsAtom).get('actual')?.id).toBe('new-pty')
    expect(store.get(activeSessionsAtom).get('actual')?.status).toBe('Running')
  })

  it('shows startup shells without inserting a fake persisted Session and keeps concurrent pending launches', () => {
    const store = createStore()
    applyManagedChange(store, { instanceId: 'main', revision: 1, session: session() })
    applyManagedChange(store, { instanceId: 'main', revision: 2, session: session({ launchId: 'second', frameId: 'frame2', ptyId: 'pty2', revision: 2 }) })
    expect(store.get(activeSessionsAtom).size).toBe(0)
    expect(store.get(displaySessionsAtom).size).toBe(2)
    expect(store.get(pendingPtyStartsAtom).size).toBe(2)
    expect(store.get(ptySessionIdsAtom)).toEqual(new Set(['frame', 'frame2']))
    expect(resolveContentSessionId(store, 'frame')).toBeNull()
  })

  it('retains the frame across compatibility and replaces the shell with exactly one confirmed Session', () => {
    const store = createStore()
    applyManagedChange(store, { instanceId: 'main', revision: 1, session: session() })
    const confirmed = session({ mode: 'compatibility', attemptId: 'retry', ptyId: 'retry-pty', confirmedClaudeId: 'actual', identityState: 'confirmed', lifecycle: 'active', revision: 2 })
    applyManagedChange(store, { instanceId: 'main', revision: 2, session: confirmed })
    expect(store.get(displaySessionsAtom).size).toBe(1)
    expect(store.get(displaySessionsAtom).get('actual')?.frameId).toBe('frame')
    expect(store.get(displaySessionsAtom).get('actual')?.id).toBe('retry-pty')
    expect(store.get(ptySessionIdsAtom)).toEqual(new Set(['actual']))
    expect(store.get(pendingPtyStartsAtom).size).toBe(0)
    expect(resolveContentSessionId(store, 'frame')).toBe('actual')
  })

  it('merges older snapshots for unseen launches without rolling back newer known sessions', () => {
    const store = createStore()
    const confirmed = session({ confirmedClaudeId: 'actual', identityState: 'confirmed', lifecycle: 'active', revision: 3 })
    applyManagedChange(store, { instanceId: 'main', revision: 3, session: confirmed })
    applyManagedSnapshot(store, { instanceId: 'main', revision: 2, sessions: [session(), session({ launchId: 'second', frameId: 'second', revision: 2 })] })
    expect(store.get(managedSessionsAtom).size).toBe(2)
    expect(store.get(managedSessionsAtom).get('launch')?.confirmedClaudeId).toBe('actual')
    expect(store.get(pendingPtyStartsAtom).has('launch')).toBe(false)
  })

  it('rejects delayed binds after exit and keeps a no-transcript shell out of disk handoff', () => {
    const store = createStore()
    applyManagedChange(store, { instanceId: 'main', revision: 1, session: session() })
    applyManagedChange(store, { instanceId: 'main', revision: 2, session: session({ lifecycle: 'ended', terminalState: 'exited', revision: 2 }) })
    createPtyBindHandler(store).handleBind({ ptyId: 'pty', claudeId: 'unexpected', projectId: 'project' })
    expect(store.get(activeSessionsAtom).size).toBe(0)
    expect(store.get(displaySessionsAtom).get('frame')?.status).toBe('Completed')
    expect(store.get(ptySessionIdsAtom).size).toBe(0)
  })
})
