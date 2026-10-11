import type { createStore } from 'jotai'
import type { ManagedChange, ManagedSnapshot, ManagedSession } from '@shared/types/managedSession'
import { activeSessionsAtom } from '../atoms/session-core.atom'
import { managedSessionsAtom, managedVersionAtom, managedSnapshotFloorAtom, retiredManagedInstancesAtom } from '../atoms/managed-sessions.atom'
import { pendingPtyStartsAtom } from '../atoms/pending-starts.atom'
import { addToRealtime, removeFromRealtime } from './realtimeVisibility'
import { createSession, patchSession } from './sessionRegistry'
import { releaseSessionRuntime } from './runtimeResourceCapability'
import { bindPty } from './ptyBindings'
import { historyProjectsAtom } from '../atoms/history.atom'

type Store = ReturnType<typeof createStore>

function applySession(store: Store, session: ManagedSession): void {
  const previous = store.get(managedSessionsAtom).get(session.launchId)
  if (previous && previous.revision >= session.revision) return
  store.set(managedSessionsAtom, prev => new Map(prev).set(session.launchId, session))
  const live = ['starting', 'active', 'retry-pending'].includes(session.lifecycle)
  const key = session.confirmedClaudeId ?? session.frameId
  if (!live && session.confirmedClaudeId) {
    const currentOwner = store.get(activeSessionsAtom).get(session.confirmedClaudeId)
    if (currentOwner && currentOwner.id !== session.ptyId && ['Running', 'Paused'].includes(currentOwner.status)) return
  }
  const oldKey = previous?.confirmedClaudeId ?? previous?.frameId
  if (oldKey && oldKey !== key) removeFromRealtime(store, oldKey)
  if (live) addToRealtime(store, key)
  else removeFromRealtime(store, key)
  store.set(pendingPtyStartsAtom, previousPending => {
    const pending = new Map(previousPending)
    if (live && !session.confirmedClaudeId) pending.set(session.launchId, { ptyId: session.ptyId, projectId: session.projectId })
    else pending.delete(session.launchId)
    return pending
  })
  if (!live && session.confirmedClaudeId && session.transcriptState === 'ready') {
    const id = session.confirmedClaudeId
    const existing = store.get(activeSessionsAtom).get(id)
    if (!existing) createSession(store, id, {
      id: session.ptyId, claudeId: id, frameId: session.frameId, projectId: session.projectId, cwd: session.cwd,
      status: 'Completed', startedAt: session.startedAt, endedAt: Date.now(), transcriptPath: session.transcriptPath ?? null,
      currentModel: null, tokenUsage: { current: null, max: null, usedPercentage: null }, worktreePath: null
    })
    else if (existing.id === session.ptyId) patchSession(store, id, { status: 'Completed', endedAt: Date.now() })
    releaseSessionRuntime(store, id, { mode: 'handoff', reason: 'managed-final-transcript' })
  }
  if (session.confirmedClaudeId && live && session.lifecycle !== 'retry-pending') {
    const id = session.confirmedClaudeId
    bindPty(store, session.ptyId, id)
    const existing = store.get(activeSessionsAtom).get(id)
    if (existing) patchSession(store, id, {
      id: session.ptyId, frameId: session.frameId, projectId: session.projectId, cwd: session.cwd,
      isPtyPlaceholder: false,
      ...(['Completed', 'Interrupted'].includes(existing.status) ? { status: 'Running', endedAt: null } : {}),
      ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {})
    })
    else {
      const historyEntry = store.get(historyProjectsAtom).get(session.projectId)?.clusters
        .flatMap(cluster => cluster.sessions).find(entry => entry.sessionId === id)
      createSession(store, id, {
        id: session.ptyId, claudeId: id, frameId: session.frameId, projectId: session.projectId, cwd: session.cwd,
        status: 'Running', startedAt: historyEntry?.startedAt ?? session.startedAt, endedAt: null,
        transcriptPath: session.transcriptPath ?? null, currentModel: null,
        tokenUsage: { current: null, max: null, usedPercentage: null }, worktreePath: null
      })
    }
  }
}

function acceptInstance(store: Store, instanceId: string): boolean {
  if (store.get(retiredManagedInstancesAtom).has(instanceId)) return false
  const previous = store.get(managedVersionAtom)
  if (previous && previous.instanceId !== instanceId) {
    store.set(retiredManagedInstancesAtom, retired => new Set(retired).add(previous.instanceId))
    for (const session of store.get(managedSessionsAtom).values()) {
      removeFromRealtime(store, session.confirmedClaudeId ?? session.frameId)
      if (session.confirmedClaudeId) patchSession(store, session.confirmedClaudeId, { status: 'Completed', endedAt: Date.now() })
    }
    store.set(managedSessionsAtom, new Map())
    store.set(managedVersionAtom, null)
    store.set(managedSnapshotFloorAtom, 0)
    store.set(pendingPtyStartsAtom, new Map())
  }
  return true
}

export function applyManagedChange(store: Store, change: ManagedChange): void {
  if (!acceptInstance(store, change.instanceId)) return
  const version = store.get(managedVersionAtom)
  if (version?.instanceId === change.instanceId && version.revision >= change.revision) return
  applySession(store, change.session)
  store.set(managedVersionAtom, { instanceId: change.instanceId, revision: change.revision })
}

export function applyManagedSnapshot(store: Store, snapshot: ManagedSnapshot): void {
  if (!acceptInstance(store, snapshot.instanceId)) return
  const version = store.get(managedVersionAtom)
  // A snapshot can be older than a received event but still contain other launches not yet seen.
  if (snapshot.revision < store.get(managedSnapshotFloorAtom)) return
  const present = new Set(snapshot.sessions.map(session => session.launchId))
  store.set(managedSessionsAtom, previous => new Map([...previous].filter(([id, session]) => present.has(id) || session.revision > snapshot.revision)))
  for (const session of snapshot.sessions) applySession(store, session)
  store.set(managedSnapshotFloorAtom, snapshot.revision)
  store.set(managedVersionAtom, { instanceId: snapshot.instanceId, revision: Math.max(version?.revision ?? 0, snapshot.revision) })
}

export function resolveContentSessionId(store: Store, frameId: string): string | null {
  for (const session of store.get(managedSessionsAtom).values()) {
    if (session.frameId === frameId) return session.confirmedClaudeId ?? null
  }
  for (const session of store.get(activeSessionsAtom).values()) {
    if (session.frameId === frameId) return session.isPtyPlaceholder ? null : session.claudeId ?? null
  }
  return frameId
}

export function resolveFrameId(store: Store, contentId: string): string {
  const active = store.get(activeSessionsAtom).get(contentId)
  if (active?.frameId) return active.frameId
  for (const session of store.get(managedSessionsAtom).values()) {
    if (session.confirmedClaudeId === contentId) return session.frameId
  }
  return contentId
}
