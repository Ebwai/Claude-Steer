// 使用方法：npm test -- src/__tests__/main/historyCatalogDeletion.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：历史关系重建、可信 bundle 与事务删除的回归测试

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HistoryCatalogEntry, HistoryDeleteInput } from '../../shared/types/history'
import {
  buildHistoryClusters,
  scanHistoryCatalog,
  type HistoryCatalogSnapshot,
} from '../../main/lib/history/HistoryCatalog'
import { deleteHistoryTarget } from '../../main/lib/history/HistoryDeletion'
import { loadHistoryClusterProjection } from '../../main/lib/history/HistoryDetailLoader'
import { parseJsonlLine, parseJsonlObject } from '../../main/lib/jsonl/JsonlParser'
import { resolveProjectDirectory, resolveSessionBundle } from '../../main/lib/history/HistoryPaths'

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
    clusterId: sessionId,
    sidecarFlags: {
      meta: true,
      insertions: true,
      milestones: false,
      gitMarks: false,
      sessionDirectory: true,
    },
    subagentCount: 1,
  }
}

function snapshot(claudeDir: string, entries: HistoryCatalogEntry[]): HistoryCatalogSnapshot {
  const clusters = buildHistoryClusters(entries)
  const childrenByParentId = new Map<string, string[]>()
  for (const item of entries) {
    if (!item.parentSessionId) continue
    const children = childrenByParentId.get(item.parentSessionId) ?? []
    children.push(item.sessionId)
    childrenByParentId.set(item.parentSessionId, children)
  }
  return {
    projectId: PROJECT_ID,
    projectPath: PROJECT_PATH,
    claudeDir,
    generation: 'generation-1',
    entries,
    entriesById: new Map(entries.map((item) => [item.sessionId, item])),
    childrenByParentId,
    clusters,
  }
}

function writeBundle(claudeDir: string, sessionId: string): void {
  fs.writeFileSync(path.join(claudeDir, `${sessionId}.jsonl`), '{"type":"user"}\n', 'utf8')
  fs.writeFileSync(path.join(claudeDir, `${sessionId}.meta.json`), '{}', 'utf8')
  fs.writeFileSync(
    path.join(claudeDir, `${sessionId}.insertions.jsonl`),
    JSON.stringify({ id: `${sessionId}-trace` }) + '\n',
    'utf8',
  )
  const subagentsDir = path.join(claudeDir, sessionId, 'subagents')
  fs.mkdirSync(subagentsDir, { recursive: true })
  fs.writeFileSync(path.join(subagentsDir, 'agent-a.jsonl'), '{}\n', 'utf8')
}

function deletionInput(targetSessionId: string, scope: 'cluster' | 'branch'): HistoryDeleteInput {
  return {
    projectId: PROJECT_ID,
    projectPath: PROJECT_PATH,
    targetSessionId,
    scope,
    expectedGeneration: 'generation-1',
    operationId: `operation-${targetSessionId}`,
  }
}

describe('history catalog and deletion', () => {
  let claudeDir: string

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-steer-history-'))
  })

  afterEach(() => {
    if (claudeDir.startsWith(os.tmpdir()) && fs.existsSync(claudeDir)) {
      fs.rmSync(claudeDir, { recursive: true, force: true })
    }
  })

  it('按时间升序建立完整 cluster，缺失父节点时保留剩余子树', () => {
    const entries = [
      entry('later-root', 500),
      entry('child', 200, 'deleted-parent'),
      entry('grandchild', 300, 'child'),
      entry('early-root', 100),
    ]

    const clusters = buildHistoryClusters(entries)

    expect(clusters.map((cluster) => cluster.clusterId)).toEqual(['early-root', 'child', 'later-root'])
    expect(clusters[1].isOrphaned).toBe(true)
    expect(clusters[1].sessions.map((item) => item.sessionId)).toEqual(['child', 'grandchild'])
  })

  it('拒绝把会话 id 解释为项目目录外路径', () => {
    expect(() => resolveSessionBundle(claudeDir, '../outside')).toThrow('Unsafe history session id')
  })

  it('字符串与已解析对象入口产生等价 JsonlRecord，实时 raw 契约保持不变', () => {
    const raw = {
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp: '2026-08-09T00:00:00.000Z',
      message: { content: 'answer', model: 'claude-test', usage: { input_tokens: 1, output_tokens: 2 } },
    }
    expect(parseJsonlLine(JSON.stringify(raw))).toEqual(parseJsonlObject(raw))
    expect(parseJsonlObject(raw)?.raw).toBe(raw)
  })

  it('轻量目录扫描超过旧 20 条边界仍返回全部会话且按时间升序', async () => {
    const homeDir = path.join(claudeDir, 'fake-home')
    const projectHistoryDir = resolveProjectDirectory(PROJECT_PATH, homeDir)
    fs.mkdirSync(projectHistoryDir, { recursive: true })
    for (let index = 0; index < 30; index += 1) {
      const timestamp = new Date(1_700_000_000_000 + index * 1000).toISOString()
      fs.writeFileSync(
        path.join(projectHistoryDir, `session-${String(index).padStart(2, '0')}.jsonl`),
        JSON.stringify({ type: 'user', cwd: PROJECT_PATH, timestamp }) + '\n',
        'utf8',
      )
    }

    const result = await scanHistoryCatalog(PROJECT_ID, PROJECT_PATH, undefined, homeDir)

    expect(result.entries).toHaveLength(30)
    expect(result.clusters).toHaveLength(30)
    expect(result.clusters[0].clusterId).toBe('session-00')
    expect(result.clusters.at(-1)?.clusterId).toBe('session-29')
  })

  it('历史详情跳过 forkedFrom 继承前缀并标记第一条 Branch 本地用户消息', async () => {
    const entries = [entry('root', 100), entry('branch', 200, 'root')]
    const forkedFrom = { sessionId: 'root', messageUuid: 'root-user' }
    fs.writeFileSync(
      path.join(claudeDir, 'root.jsonl'),
      `${JSON.stringify({ type: 'user', uuid: 'root-user', message: { content: 'root prompt' } })}\n`,
    )
    fs.writeFileSync(
      path.join(claudeDir, 'branch.jsonl'),
      [
        { type: 'attachment', uuid: 'attachment', forkedFrom },
        { type: 'user', uuid: 'inherited-user', message: { content: 'inherited prompt' }, forkedFrom },
        { type: 'assistant', uuid: 'inherited-answer', message: { content: 'inherited answer' }, forkedFrom },
        { type: 'user', uuid: 'branch-user', message: { content: 'branch prompt' } },
        { type: 'assistant', uuid: 'branch-answer', message: { content: 'branch answer' } },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n',
    )

    const projection = await loadHistoryClusterProjection(snapshot(claudeDir, entries), 'root')
    const branch = projection.sessions.find((item) => item.sessionId === 'branch')

    expect(branch?.timeline.filter((node) => node.isBranchStart).map((node) => node.id))
      .toEqual(['branch-user'])
    const forbiddenKeys: string[] = []
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        value.forEach(walk)
        return
      }
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'raw' || key === 'records') forbiddenKeys.push(key)
        walk(nested)
      }
    }
    walk(projection)
    expect(forbiddenKeys).toEqual([])
  })

  it('删除主线时连带删除全部 Branch、sidecar 与 subagent 目录', async () => {
    const entries = [entry('root', 100), entry('branch', 200, 'root')]
    entries.forEach((item) => writeBundle(claudeDir, item.sessionId))
    writeBundle(claudeDir, 'unrelated')
    const unwatched: string[] = []

    const result = await deleteHistoryTarget(snapshot(claudeDir, entries), deletionInput('root', 'cluster'), {
      isSessionRunning: () => false,
      unwatchSession: (sessionId) => unwatched.push(sessionId),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deletedSessionIds).toEqual(['root', 'branch'])
    expect(unwatched).toEqual(['root', 'branch'])
    expect(fs.existsSync(path.join(claudeDir, 'root.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(claudeDir, 'root'))).toBe(false)
    expect(fs.existsSync(path.join(claudeDir, 'branch.insertions.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(claudeDir, 'unrelated.jsonl'))).toBe(true)
  })

  it('单删 Branch 删除其完整后代子树，并保留父 sidecar 痕迹及同级 Branch', async () => {
    const entries = [
      entry('root', 100),
      entry('branch', 200, 'root'),
      entry('sibling', 250, 'root'),
      entry('child', 300, 'branch'),
      entry('grandchild', 400, 'child'),
    ]
    entries.forEach((item) => writeBundle(claudeDir, item.sessionId))
    const parentTrace = path.join(claudeDir, 'root.insertions.jsonl')
    const traceBefore = fs.readFileSync(parentTrace, 'utf8')

    const result = await deleteHistoryTarget(snapshot(claudeDir, entries), deletionInput('branch', 'branch'), {
      isSessionRunning: () => false,
      unwatchSession: () => undefined,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deletedSessionIds).toEqual(['branch', 'child', 'grandchild'])
    expect(result.orphanedSessionIds).toEqual([])
    expect(fs.existsSync(path.join(claudeDir, 'branch.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(claudeDir, 'child.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(claudeDir, 'grandchild.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(claudeDir, 'sibling.jsonl'))).toBe(true)
    expect(fs.readFileSync(parentTrace, 'utf8')).toBe(traceBefore)
  })

  it('任一选中会话仍在运行时拒绝整个删除且不移动文件', async () => {
    const entries = [entry('root', 100), entry('branch', 200, 'root')]
    entries.forEach((item) => writeBundle(claudeDir, item.sessionId))

    const result = await deleteHistoryTarget(snapshot(claudeDir, entries), deletionInput('root', 'cluster'), {
      isSessionRunning: (sessionId) => sessionId === 'branch',
      unwatchSession: () => undefined,
    })

    expect(result).toMatchObject({ ok: false, errorCode: 'HISTORY_SESSION_RUNNING' })
    expect(fs.existsSync(path.join(claudeDir, 'root.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(claudeDir, 'branch.jsonl'))).toBe(true)
  })
})
