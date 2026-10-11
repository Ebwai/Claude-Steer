import { atom } from 'jotai'
import type { ManagedSession } from '@shared/types/managedSession'
import type { Session } from '@shared/types/index'
import { activeSessionsAtom } from './session-core.atom'

export const managedSessionsAtom = atom<Map<string, ManagedSession>>(new Map())
export const retiredManagedInstancesAtom = atom<Set<string>>(new Set<string>())
export const managedSnapshotFloorAtom = atom(0)
export const managedVersionAtom = atom<{ instanceId: string; revision: number } | null>(null)

/** Both panels use this projection; unconfirmed shells never enter persisted Session storage. */
export const displaySessionsAtom = atom((get) => {
  const sessions = new Map(get(activeSessionsAtom))
  for (const managed of get(managedSessionsAtom).values()) {
    const key = managed.confirmedClaudeId ?? managed.frameId
    const existing = sessions.get(key)
    const ended = ['ended', 'failed', 'cancelled'].includes(managed.lifecycle)
    const session: Session = existing ? { ...existing, frameId: managed.frameId } : {
      id: managed.ptyId, claudeId: key, frameId: managed.frameId, projectId: managed.projectId,
      cwd: managed.cwd, startedAt: managed.startedAt, endedAt: ended ? managed.startedAt : null,
      status: ended ? 'Completed' : 'Running', transcriptPath: managed.transcriptPath ?? null,
      currentModel: null, tokenUsage: { current: null, max: null, usedPercentage: null },
      worktreePath: null, isPtyPlaceholder: !managed.confirmedClaudeId
    }
    sessions.set(key, { ...session, id: managed.ptyId, ...(ended ? { status: 'Completed' as const } : {}) })
  }
  return sessions
})
