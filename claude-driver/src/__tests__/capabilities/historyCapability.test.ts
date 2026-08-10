// 使用方法：npm test -- src/__tests__/capabilities/historyCapability.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：历史壳独立状态、Branch 删除重排与 Token 库存回归测试

import { describe, expect, it } from 'vitest'
import type {
  HistoryCatalogEntry,
  HistoryClusterSummary,
  HistoryDeleteResult,
  HistoryOpenResult,
  HistoryClusterProjection,
} from '@shared/types/history'
import type { Session } from '@shared/types/index'
import { createTestStore } from '../helpers/createTestStore'
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import { sessionRelationsAtom } from '@renderer/atoms/branch.atom'
import { historyProjectsAtom, historyResidentManifestAtom } from '@renderer/atoms/history.atom'
import { timelineBySessionAtom } from '@renderer/atoms/timeline.atom'
import { tokenInventoryAtom } from '@renderer/atoms/token-inventory.atom'
import { todayTokensAtom, tokenStatsAtom } from '@renderer/atoms/stats.atom'
import {
  commitHistoryDelete,
  commitClusterProjection,
  appendCatalogBatch,
  openHistoryProject,
} from '@renderer/capabilities/historyCapability'

const PROJECT_ID = 'project-1'
const PROJECT_PATH = 'F:\\work\\project-1'

function entry(
  sessionId: string,
  startedAt: number,
  parentSessionId: string | null = null,
): HistoryCatalogEntry {
  return {
    sessionId,
    projectId: PROJECT_ID,
    cwd: PROJECT_PATH,
    startedAt,
    endedAt: startedAt + 100,
    parentSessionId,
    forkMessageUuid: parentSessionId ? `fork-${sessionId}` : null,
    clusterId: 'root',
    sidecarFlags: {
      meta: false,
      insertions: false,
      milestones: false,
      gitMarks: false,
      sessionDirectory: false,
    },
    subagentCount: 0,
  }
}

function cluster(entries: HistoryCatalogEntry[]): HistoryClusterSummary {
  return {
    clusterId: 'root',
    rootSessionId: 'root',
    sessions: entries,
    startedAt: entries[0].startedAt,
    endedAt: Math.max(...entries.map((item) => item.endedAt)),
    isOrphaned: false,
  }
}

function openResult(latestCluster: HistoryClusterSummary): HistoryOpenResult {
  return {
    ok: true,
    requestId: 'request-1',
    generation: 'generation-1',
    latestCluster,
    latestProjection: null,
    continuation: null,
    totalClusters: 1,
  }
}

describe('history capability', () => {
  it('历史目录写入独立壳状态，不把历史 Session 塞入 activeSessionsAtom', () => {
    const store = createTestStore()
    openHistoryProject(store, PROJECT_ID, PROJECT_PATH, openResult(cluster([entry('root', 100)])))

    expect(store.get(activeSessionsAtom).size).toBe(0)
    expect(store.get(historyProjectsAtom).get(PROJECT_ID)?.clusters).toHaveLength(1)
  })

  it('单删中间 Branch 子树后移除全部后代关系并紧凑重排同父兄弟', () => {
    const store = createTestStore()
    const entries = [
      entry('root', 100),
      entry('branch', 200, 'root'),
      entry('sibling', 250, 'root'),
      entry('child', 300, 'branch'),
      entry('grandchild', 400, 'child'),
    ]
    openHistoryProject(store, PROJECT_ID, PROJECT_PATH, openResult(cluster(entries)))
    const result: Extract<HistoryDeleteResult, { ok: true }> = {
      ok: true,
      operationId: 'operation-1',
      deletedSessionIds: ['branch', 'child', 'grandchild'],
      orphanedSessionIds: [],
      generation: 'generation-2',
      continuation: null,
      cleanupPending: false,
    }

    const outcome = commitHistoryDelete(store, PROJECT_ID, result, 'grandchild')

    const state = store.get(historyProjectsAtom).get(PROJECT_ID)!
    expect(state.generation).toBe('generation-2')
    expect(state.clusters.map((item) => item.clusterId)).toEqual(['root'])
    expect(state.clusters[0].sessions.map((item) => item.sessionId)).toEqual(['root', 'sibling'])
    const relations = store.get(sessionRelationsAtom)
    expect(relations.has('branch')).toBe(false)
    expect(relations.has('child')).toBe(false)
    expect(relations.has('grandchild')).toBe(false)
    expect(relations.get('sibling')).toMatchObject({ parentSessionId: 'root', branchIndex: 1, side: 'right' })
    expect(outcome).toMatchObject({
      focusWasDeleted: true,
      focusFallbackSessionId: 'root',
      invalidatedClusterIds: ['root'],
    })
  })

  it('紧凑投影直接转移到 timeline atom，manifest 不保留正文副本', () => {
    const store = createTestStore()
    openHistoryProject(store, PROJECT_ID, PROJECT_PATH, openResult(cluster([entry('root', 100)])))
    const timeline: HistoryClusterProjection['sessions'][number]['timeline'] = [{
      id: 'node-1',
      sessionId: 'root',
      type: 'user_input',
      text: 'hello',
      parsedAt: 100,
    }]
    const projection: HistoryClusterProjection = {
      clusterId: 'root',
      projectedAt: 200,
      sessions: [{
        sessionId: 'root',
        timeline,
        insertions: [],
        milestones: [],
        gitMarks: [],
        subagents: [],
        triggerNodeIndex: null,
        partialErrors: [],
      }],
    }

    expect(commitClusterProjection(store, PROJECT_ID, 'request-1', 'generation-1', projection)).toBe(true)
    expect(store.get(timelineBySessionAtom('root'))).toBe(timeline)
    const manifest = store.get(historyResidentManifestAtom).get('root')!
    expect(manifest.sessionIds).toEqual(['root'])
    expect(Object.keys(manifest)).not.toContain('timeline')
    expect(JSON.stringify(manifest)).not.toContain('hello')
  })

  it('删除后拒绝旧 generation 投影，已删除节点不会复活', () => {
    const store = createTestStore()
    openHistoryProject(store, PROJECT_ID, PROJECT_PATH, openResult(cluster([
      entry('root', 100),
      entry('branch', 200, 'root'),
    ])))
    const result: Extract<HistoryDeleteResult, { ok: true }> = {
      ok: true,
      operationId: 'operation-race',
      deletedSessionIds: ['branch'],
      orphanedSessionIds: [],
      generation: 'generation-2',
      continuation: null,
      cleanupPending: false,
    }
    commitHistoryDelete(store, PROJECT_ID, result, 'root')
    const staleProjection: HistoryClusterProjection = {
      clusterId: 'root',
      projectedAt: 300,
      sessions: [
        { sessionId: 'root', timeline: [], insertions: [], milestones: [], gitMarks: [], subagents: [], triggerNodeIndex: null, partialErrors: [] },
        { sessionId: 'branch', timeline: [], insertions: [], milestones: [], gitMarks: [], subagents: [], triggerNodeIndex: 0, partialErrors: [] },
      ],
    }

    expect(commitClusterProjection(store, PROJECT_ID, 'request-1', 'generation-1', staleProjection)).toBe(false)
    expect(store.get(historyProjectsAtom).get(PROJECT_ID)?.clusters[0].sessions.map((item) => item.sessionId))
      .toEqual(['root'])
    expect(store.get(historyResidentManifestAtom).has('root')).toBe(false)
  })

  it('删除主线焦点时优先回退到时间上较新的相邻主线', () => {
    const store = createTestStore()
    const newerEntry = { ...entry('newer', 200), clusterId: 'newer' }
    const newerCluster: HistoryClusterSummary = {
      clusterId: 'newer', rootSessionId: 'newer', sessions: [newerEntry],
      startedAt: 200, endedAt: 300, isOrphaned: false,
    }
    openHistoryProject(store, PROJECT_ID, PROJECT_PATH, openResult(newerCluster))
    const olderEntry = { ...entry('older', 100), clusterId: 'older' }
    appendCatalogBatch(store, PROJECT_ID, {
      ok: true,
      requestId: 'request-1',
      generation: 'generation-1',
      clusters: [{
        clusterId: 'older', rootSessionId: 'older', sessions: [olderEntry],
        startedAt: 100, endedAt: 200, isOrphaned: false,
      }],
      continuation: null,
    })
    const result: Extract<HistoryDeleteResult, { ok: true }> = {
      ok: true,
      operationId: 'delete-older',
      deletedSessionIds: ['older'],
      orphanedSessionIds: [],
      generation: 'generation-2',
      continuation: null,
      cleanupPending: false,
    }

    const outcome = commitHistoryDelete(store, PROJECT_ID, result, 'older')

    expect(outcome.focusFallbackSessionId).toBe('newer')
  })

  it('目录重建不会覆盖 Running/Paused Session 的实时 Branch 关系', () => {
    const store = createTestStore()
    const liveSession: Session = {
      id: 'pty-live',
      claudeId: 'live',
      projectId: PROJECT_ID,
      status: 'Running',
      currentModel: null,
      tokenUsage: { current: null, max: null, usedPercentage: null },
      transcriptPath: null,
      cwd: PROJECT_PATH,
      startedAt: 200,
      endedAt: null,
      worktreePath: null,
    }
    store.set(activeSessionsAtom, new Map([['live', liveSession]]))
    store.set(sessionRelationsAtom, new Map([['live', {
      type: 'branch',
      parentSessionId: 'root',
      branchIndex: 7,
      side: 'right',
      lineLength: 999,
      triggerNodeIndex: 42,
    }]]))

    openHistoryProject(
      store,
      PROJECT_ID,
      PROJECT_PATH,
      openResult(cluster([entry('root', 100), entry('live', 200, 'root')])),
    )

    expect(store.get(sessionRelationsAtom).get('live')).toMatchObject({
      branchIndex: 7,
      lineLength: 999,
      triggerNodeIndex: 42,
    })
  })

  it('Token 聚合仅依赖轻量库存，历史详情未驻留且 activeSessions 为空仍可统计', () => {
    const store = createTestStore()
    const now = Date.now()
    store.set(tokenInventoryAtom, new Map([
      ['history-a', {
        sessionId: 'history-a',
        projectId: PROJECT_ID,
        startedAt: now,
        model: 'claude-test',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationTokens: 30,
          cacheReadTokens: 40,
        },
      }],
    ]))

    expect(store.get(activeSessionsAtom).size).toBe(0)
    expect(store.get(todayTokensAtom)).toBe(100)
    expect(store.get(tokenStatsAtom)).toMatchObject({
      monthlyTokens: 100,
      mostUsedModel: 'claude-test',
    })
  })
})
