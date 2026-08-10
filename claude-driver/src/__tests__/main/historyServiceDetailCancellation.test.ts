// 使用方法：npm test -- src/__tests__/main/historyServiceDetailCancellation.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：删除与在途历史投影的 generation/cancel 竞态回归

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HistoryCatalogEntry,
  HistoryClusterProjection,
  HistoryClusterSummary,
} from '../../shared/types/history'
import type { HistoryCatalogSnapshot } from '../../main/lib/history/HistoryCatalog'

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  loadProjection: vi.fn(),
  deleteTarget: vi.fn(),
  recover: vi.fn(),
}))

vi.mock('../../main/lib/history/HistoryCatalog', () => ({
  scanHistoryCatalog: mocks.scan,
  historyClusterSortKey: (cluster: HistoryClusterSummary) => `${cluster.startedAt}:${cluster.clusterId}`,
}))
vi.mock('../../main/lib/history/HistoryDetailLoader', () => ({
  loadHistoryClusterProjection: mocks.loadProjection,
}))
vi.mock('../../main/lib/history/HistoryDeletion', () => ({
  deleteHistoryTarget: mocks.deleteTarget,
  recoverHistoryDeleteTransactions: mocks.recover,
}))
vi.mock('../../main/lib/history/HistoryTokenInventory', () => ({
  scanHistoryTokenInventory: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../main/lib/history/HistoryPaths', () => ({
  resolveProjectDirectory: () => 'F:\\fake-claude-dir',
}))

import { HistoryService } from '../../main/lib/history/HistoryService'

function entry(sessionId: string, parentSessionId: string | null = null): HistoryCatalogEntry {
  return {
    sessionId,
    projectId: 'project',
    cwd: 'F:\\project',
    startedAt: parentSessionId ? 200 : 100,
    endedAt: parentSessionId ? 300 : 200,
    parentSessionId,
    forkMessageUuid: parentSessionId ? 'fork' : null,
    clusterId: 'root',
    sidecarFlags: { meta: false, insertions: false, milestones: false, gitMarks: false, sessionDirectory: false },
    subagentCount: 0,
  }
}

function snapshot(generation: string, entries: HistoryCatalogEntry[]): HistoryCatalogSnapshot {
  const cluster: HistoryClusterSummary = {
    clusterId: 'root',
    rootSessionId: 'root',
    sessions: entries,
    startedAt: 100,
    endedAt: Math.max(...entries.map((item) => item.endedAt)),
    isOrphaned: false,
  }
  const childrenByParentId = new Map<string, string[]>()
  for (const item of entries) {
    if (item.parentSessionId) childrenByParentId.set(item.parentSessionId, [item.sessionId])
  }
  return {
    projectId: 'project',
    projectPath: 'F:\\project',
    claudeDir: 'F:\\fake-claude-dir',
    generation,
    entries,
    entriesById: new Map(entries.map((item) => [item.sessionId, item])),
    childrenByParentId,
    clusters: [cluster],
  }
}

function projection(sessionIds: string[]): HistoryClusterProjection {
  return {
    clusterId: 'root',
    projectedAt: Date.now(),
    sessions: sessionIds.map((sessionId) => ({
      sessionId,
      timeline: [],
      insertions: [],
      milestones: [],
      gitMarks: [],
      subagents: [],
      triggerNodeIndex: null,
      partialErrors: [],
    })),
  }
}

describe('HistoryService detail cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('删除重扫后在途旧投影只能返回旧 generation 的取消结果', async () => {
    const before = snapshot('generation-1', [entry('root'), entry('branch', 'root')])
    const after = snapshot('generation-2', [entry('root')])
    mocks.scan.mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    mocks.loadProjection.mockResolvedValueOnce(projection(['root', 'branch']))
    let resolveLate: ((value: HistoryClusterProjection) => void) | null = null
    mocks.loadProjection.mockImplementationOnce(() => new Promise<HistoryClusterProjection>((resolve) => {
      resolveLate = resolve
    }))
    mocks.deleteTarget.mockResolvedValue({
      ok: true,
      deletedSessionIds: ['branch'],
      orphanedSessionIds: [],
      cleanupPending: false,
    })
    const service = new HistoryService({ isSessionRunning: () => false, unwatchSession: () => undefined })
    const opened = await service.openProject({ projectId: 'project', projectPath: 'F:\\project', requestId: 'request' })
    expect(opened.ok).toBe(true)

    const detailPromise = service.loadDetails({
      projectId: 'project',
      projectPath: 'F:\\project',
      requestId: 'request',
      detailRequestId: 'detail-late',
      generation: 'generation-1',
      clusterId: 'root',
    })
    await vi.waitFor(() => expect(mocks.loadProjection).toHaveBeenCalledTimes(2))
    const deletion = await service.deleteTarget({
      projectId: 'project',
      projectPath: 'F:\\project',
      targetSessionId: 'branch',
      scope: 'branch',
      expectedGeneration: 'generation-1',
      operationId: 'delete-1',
    })
    resolveLate?.(projection(['root', 'branch']))
    const lateResult = await detailPromise

    expect(deletion).toMatchObject({ ok: true, generation: 'generation-2' })
    expect(lateResult).toMatchObject({
      ok: false,
      errorCode: 'HISTORY_CANCELLED',
      requestId: 'request',
      detailRequestId: 'detail-late',
      generation: 'generation-1',
    })
  })

  it('Session seal 生成紧凑投影后原子替换 request，并允许既有目录壳继续水合', async () => {
    const before = snapshot('generation-1', [entry('root')])
    const after = snapshot('generation-2', [entry('root'), entry('branch', 'root')])
    mocks.scan.mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    mocks.loadProjection
      .mockResolvedValueOnce(projection(['root']))
      .mockResolvedValueOnce(projection(['root', 'branch']))
      .mockResolvedValueOnce(projection(['root', 'branch']))
    const service = new HistoryService({ isSessionRunning: () => false, unwatchSession: () => undefined })
    const opened = await service.openProject({
      projectId: 'project',
      projectPath: 'F:\\project',
      requestId: 'request-old',
    })
    expect(opened.ok).toBe(true)

    const sealed = await service.sealSession({
      projectId: 'project',
      projectPath: 'F:\\project',
      sessionId: 'branch',
      requestId: 'request-seal',
      knownClusterIds: ['root'],
      continuation: null,
    })
    expect(sealed).toMatchObject({
      ok: true,
      requestId: 'request-seal',
      generation: 'generation-2',
      cluster: { clusterId: 'root' },
    })

    const detail = await service.loadDetails({
      projectId: 'project',
      projectPath: 'F:\\project',
      requestId: 'request-seal',
      detailRequestId: 'detail-after-seal',
      generation: 'generation-2',
      clusterId: 'root',
    })
    expect(detail).toMatchObject({ ok: true, generation: 'generation-2' })
  })
})
