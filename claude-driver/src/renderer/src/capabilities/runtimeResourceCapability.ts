// 使用方法：项目/Session 生命周期边界调用 release*Runtime，诊断时调用 snapshotRuntimeResources
// 编译说明：renderer 进程 browser bundle；纯 Jotai 状态事务，不触发 IPC
// 代码说明：集中管理运行态资源所有权，避免 atomFamily/Map 在组件卸载后继续持有大对象

import type { TestStore } from '../../../__tests__/helpers/createTestStore'
import { activeSessionsAtom, ptySessionIdsAtom, sessionByIdAtom } from '@renderer/atoms/session-core.atom'
import { ptyBindingsAtom } from '@renderer/atoms/pty-binding.atom'
import {
  activeSubagentSlotsAtom,
  agentBlocksAtom,
  agentCallCountAtom,
  allFrameHeightsAtom,
  nodeYOffsetsAtom,
  pendingBtwAtom,
  sessionFrameHeightsAtom,
  subagentIdsAtom,
} from '@renderer/atoms/agent-block.atom'
import { contextPanelAtom, selectedContextAgentAtom } from '@renderer/atoms/context-panel.atom'
import { permissionRequestsAtom } from '@renderer/atoms/permission.atom'
import {
  cursorNodeIndexAtom,
  lineInsertionsBySessionAtom,
  scrubberIndexAtom,
  subagentTimelineAtom,
  timelineBySessionAtom,
} from '@renderer/atoms/timeline.atom'
import { sessionTokensAtom } from '@renderer/atoms/stats.atom'
import {
  historyDeleteStatesAtom,
  historyHandoffPendingAtom,
  historyLayoutAnchorsAtom,
  historyProjectsAtom,
  historyResidentManifestAtom,
} from '@renderer/atoms/history.atom'
import { branchCountAtom, sessionRelationsAtom } from '@renderer/atoms/branch.atom'
import { milestonesByProjectAtom, projectByIdAtom } from '@renderer/atoms/projects.atom'
import { pathMatches } from '@renderer/utils/pathUtils'
import { clearHistoryProject } from './historyCapability'

type Store = Pick<TestStore, 'get' | 'set'>

export interface RuntimeResourceSnapshot {
  projectId: string | null
  activeSessions: number
  realtimeSessions: number
  agentBlocks: number
  historyProjects: number
  residentClusters: number
  residentSessions: number
  frameHeights: number
  permissionRequests: number
  ptyBindings: number
}

export interface RuntimeReleaseSummary {
  sessionId: string
  mode: 'handoff' | 'destroy'
  historyOwned: boolean
  removedSessionRegistry: boolean
  clearedSubagents: number
}

export interface ProjectReleaseSummary {
  projectId: string
  sessionCount: number
  runningSessionsPreserved: number
  before: RuntimeResourceSnapshot
  after: RuntimeResourceSnapshot
}

function isTerminal(status: string): boolean {
  return status === 'Completed' || status === 'Interrupted'
}

function isHistoryOwned(store: Store, sessionId: string): boolean {
  for (const manifest of store.get(historyResidentManifestAtom).values()) {
    if (manifest.sessionIds.includes(sessionId)) return true
  }
  return false
}

export function releaseSessionRuntime(
  store: Store,
  sessionId: string,
  options: { mode: 'handoff' | 'destroy'; reason: string; preserveRunningSession?: boolean },
): RuntimeReleaseSummary {
  const historyOwned = isHistoryOwned(store, sessionId)
  const session = store.get(activeSessionsAtom).get(sessionId)
  const shouldDestroyShared = options.mode === 'destroy'
  const subagentIds = store.get(subagentIdsAtom(sessionId))
  const preserveLiveSession = Boolean(
    options.preserveRunningSession
    && session
    && (session.status === 'Running' || session.status === 'Paused'),
  )

  if (options.mode === 'handoff' && session && isTerminal(session.status) && !historyOwned) {
    let ownerProjectId = session.projectId
    if (!ownerProjectId) {
      for (const projectState of store.get(historyProjectsAtom).values()) {
        if (pathMatches(session.cwd, projectState.projectPath)) {
          ownerProjectId = projectState.projectId
          break
        }
      }
    }
    if (ownerProjectId) {
      store.set(historyHandoffPendingAtom, (prev) => {
        const current = prev.get(ownerProjectId) ?? new Set<string>()
        if (current.has(sessionId)) return prev
        const nextSessions = new Set(current).add(sessionId)
        return new Map(prev).set(ownerProjectId, nextSessions)
      })
      console.info(
        `[RuntimeResources] history handoff requested project=${ownerProjectId} session=${sessionId.slice(0, 8)}`,
      )
    }
  }

  // 运行中的后台 Session 仍可能收到 tool/context 完成事件；这些不可从 JSONL 完整重建，保留到终止。
  if (!preserveLiveSession) {
    store.set(agentBlocksAtom, (prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
    store.set(pendingBtwAtom, (prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
    store.set(permissionRequestsAtom, (prev) => prev.filter((request) => request.sessionId !== sessionId))
    store.set(contextPanelAtom(sessionId), [])
    contextPanelAtom.remove(sessionId)
    store.set(activeSubagentSlotsAtom(sessionId), new Map())
    activeSubagentSlotsAtom.remove(sessionId)
    store.set(agentCallCountAtom(sessionId), 0)
    agentCallCountAtom.remove(sessionId)
    store.set(sessionTokensAtom(sessionId), {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      model: null,
    })
    sessionTokensAtom.remove(sessionId)
    if (store.get(selectedContextAgentAtom) === sessionId) store.set(selectedContextAgentAtom, null)
  }

  if (shouldDestroyShared) {
    store.set(timelineBySessionAtom(sessionId), [])
    store.set(lineInsertionsBySessionAtom(sessionId), [])
    store.set(subagentIdsAtom(sessionId), [])
    store.set(nodeYOffsetsAtom(sessionId), [])
    store.set(cursorNodeIndexAtom(sessionId), -1)
    store.set(scrubberIndexAtom(sessionId), -1)
    store.set(sessionFrameHeightsAtom(sessionId), 400)
    for (const agentId of subagentIds) {
      const key = `${sessionId}::${agentId}`
      store.set(subagentTimelineAtom(key), [])
      subagentTimelineAtom.remove(key)
    }
    timelineBySessionAtom.remove(sessionId)
    lineInsertionsBySessionAtom.remove(sessionId)
    subagentIdsAtom.remove(sessionId)
    nodeYOffsetsAtom.remove(sessionId)
    cursorNodeIndexAtom.remove(sessionId)
    scrubberIndexAtom.remove(sessionId)
    sessionFrameHeightsAtom.remove(sessionId)
    store.set(allFrameHeightsAtom, (prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
    store.set(historyLayoutAnchorsAtom, (prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
    store.set(historyDeleteStatesAtom, (prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
  }

  if (!preserveLiveSession) {
    store.set(ptySessionIdsAtom, (prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }

  let removedSessionRegistry = false
  const canRemoveRegistry = options.mode === 'destroy' || historyOwned
  if (session && isTerminal(session.status) && canRemoveRegistry) {
    store.set(activeSessionsAtom, (prev) => {
      if (prev.get(sessionId) !== session) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      removedSessionRegistry = true
      return next
    })
    sessionByIdAtom.remove(sessionId)
  }

  console.info(
    `[RuntimeResources] session release id=${sessionId.slice(0, 8)} mode=${options.mode} reason=${options.reason} historyOwned=${historyOwned} subagents=${subagentIds.length} removedRegistry=${removedSessionRegistry}`,
  )
  return { sessionId, mode: options.mode, historyOwned, removedSessionRegistry, clearedSubagents: shouldDestroyShared ? subagentIds.length : 0 }
}

export function snapshotRuntimeResources(store: Store, projectId: string | null = null): RuntimeResourceSnapshot {
  const project = projectId ? store.get(projectByIdAtom(projectId)) : undefined
  const activeSessions = Array.from(store.get(activeSessionsAtom).values()).filter((session) => (
    !projectId || session.projectId === projectId || (!!project && pathMatches(session.cwd, project.path))
  ))
  const residentManifests = Array.from(store.get(historyResidentManifestAtom).values()).filter((manifest) => {
    if (!projectId) return true
    const state = store.get(historyProjectsAtom).get(projectId)
    return state?.clusters.some((cluster) => cluster.clusterId === manifest.clusterId) ?? false
  })
  return {
    projectId,
    activeSessions: activeSessions.length,
    realtimeSessions: activeSessions.filter((session) => session.status === 'Running' || session.status === 'Paused').length,
    agentBlocks: Array.from(store.get(agentBlocksAtom).keys()).filter((id) => activeSessions.some((session) => (session.claudeId ?? session.id) === id)).length,
    historyProjects: projectId ? Number(store.get(historyProjectsAtom).has(projectId)) : store.get(historyProjectsAtom).size,
    residentClusters: residentManifests.length,
    residentSessions: residentManifests.reduce((total, manifest) => total + manifest.sessionIds.length, 0),
    frameHeights: store.get(allFrameHeightsAtom).size,
    permissionRequests: store.get(permissionRequestsAtom).length,
    ptyBindings: store.get(ptyBindingsAtom).claudeToPtyMap.size,
  }
}

export function releaseProjectRuntime(
  store: Store,
  projectId: string,
  options: { reason: string },
): ProjectReleaseSummary {
  const before = snapshotRuntimeResources(store, projectId)
  const project = store.get(projectByIdAtom(projectId))
  const sessionIds = new Set<string>()
  for (const cluster of store.get(historyProjectsAtom).get(projectId)?.clusters ?? []) {
    cluster.sessions.forEach((session) => sessionIds.add(session.sessionId))
  }
  for (const [mapId, session] of store.get(activeSessionsAtom)) {
    if (session.projectId === projectId || (!!project && pathMatches(session.cwd, project.path))) {
      sessionIds.add(session.claudeId ?? mapId)
    }
  }

  let runningSessionsPreserved = 0
  for (const sessionId of sessionIds) {
    const session = store.get(activeSessionsAtom).get(sessionId)
    if (session?.status === 'Running' || session?.status === 'Paused') runningSessionsPreserved += 1
    releaseSessionRuntime(store, sessionId, {
      mode: 'destroy',
      reason: options.reason,
      preserveRunningSession: true,
    })
  }

  clearHistoryProject(store, projectId)
  store.set(historyHandoffPendingAtom, (prev) => {
    if (!prev.has(projectId)) return prev
    const next = new Map(prev)
    next.delete(projectId)
    return next
  })
  store.set(milestonesByProjectAtom(projectId), [])
  milestonesByProjectAtom.remove(projectId)

  const runningIds = new Set(
    Array.from(store.get(activeSessionsAtom), ([mapId, session]) => ({
      id: session.claudeId ?? mapId,
      running: session.status === 'Running' || session.status === 'Paused',
    })).filter((entry) => entry.running).map((entry) => entry.id),
  )
  store.set(sessionRelationsAtom, (prev) => new Map(
    Array.from(prev).filter(([childId, relation]) => (
      !sessionIds.has(childId)
      || runningIds.has(childId)
      || (!!relation.parentSessionId && runningIds.has(relation.parentSessionId))
    )),
  ))
  store.set(branchCountAtom, (prev) => new Map(
    Array.from(prev).filter(([parentId]) => !sessionIds.has(parentId) || runningIds.has(parentId)),
  ))

  const after = snapshotRuntimeResources(store, projectId)
  console.info(
    `[RuntimeResources] project release id=${projectId} reason=${options.reason} sessions=${sessionIds.size} runningPreserved=${runningSessionsPreserved} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  )
  return { projectId, sessionCount: sessionIds.size, runningSessionsPreserved, before, after }
}
