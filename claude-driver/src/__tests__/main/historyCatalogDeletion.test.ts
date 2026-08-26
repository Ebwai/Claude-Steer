// 使用方法：npm test -- src/__tests__/main/historyCatalogDeletion.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：历史关系重建、可信 bundle 与事务删除的回归测试

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryCatalogEntry, HistoryDeleteInput } from '../../shared/types/history'
import {
  buildHistoryClusters,
  scanHistoryCatalog,
  type HistoryCatalogSnapshot
} from '../../main/lib/history/HistoryCatalog'
import { deleteHistoryTarget } from '../../main/lib/history/HistoryDeletion'
import { loadHistoryClusterProjection } from '../../main/lib/history/HistoryDetailLoader'
import { parseJsonlLine, parseJsonlObject } from '../../main/lib/jsonl/JsonlParser'
import { resolveProjectDirectory, resolveSessionBundle } from '../../main/lib/history/HistoryPaths'
import { createDetailService } from '../../main/lib/history/DetailService'

const PROJECT_ID = 'project-1'
const PROJECT_PATH = 'F:\\work\\project-1'

function entry(
  sessionId: string,
  startedAt: number,
  parentSessionId: string | null = null
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
      sessionDirectory: true
    },
    subagentCount: 1
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
    clusters
  }
}

function writeBundle(claudeDir: string, sessionId: string): void {
  fs.writeFileSync(path.join(claudeDir, `${sessionId}.jsonl`), '{"type":"user"}\n', 'utf8')
  fs.writeFileSync(path.join(claudeDir, `${sessionId}.meta.json`), '{}', 'utf8')
  fs.writeFileSync(
    path.join(claudeDir, `${sessionId}.insertions.jsonl`),
    JSON.stringify({ id: `${sessionId}-trace` }) + '\n',
    'utf8'
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
    operationId: `operation-${targetSessionId}`
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

  it('DetailService 按历史 locator 返回规范化 MCP request/response 详情', async () => {
    const filePath = path.join(claudeDir, 'mcp.jsonl')
    const request = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'detail-tool-id', name: 'mcp__server__query', input: { query: 'full', limit: 2 } }]
      }
    }
    const response = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'detail-tool-id', content: { rows: [{ id: 1 }], next: null }, is_error: false }]
      }
    }
    const requestLine = JSON.stringify(request)
    const content = `${requestLine}\n${JSON.stringify(response)}\n`
    fs.writeFileSync(filePath, content, 'utf8')
    const service = createDetailService({
      readFile: async (file, offset, length) => fs.readFileSync(file).subarray(offset, offset + length),
      sendToRenderer: () => undefined,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    const requestRef = service.registerEntity(
      'mcp:request',
      { filePath, byteStart: 0, byteEndExclusive: Buffer.byteLength(requestLine, 'utf8') + 1, encoding: 'utf-8', lineEnding: 'lf' },
      'generation-1',
      100,
    )
    const responseRef = service.registerEntity(
      'mcp:response',
      { filePath, byteStart: Buffer.byteLength(requestLine, 'utf8') + 1, byteEndExclusive: Buffer.byteLength(content, 'utf8'), encoding: 'utf-8', lineEnding: 'lf' },
      'generation-1',
      100,
    )
    const requestResult = await service.handleDetailRequest({ detailKey: requestRef.detailKey, revision: requestRef.revision, sourceGeneration: requestRef.sourceGeneration })
    const responseResult = await service.handleDetailRequest({ detailKey: responseRef.detailKey, revision: responseRef.revision, sourceGeneration: responseRef.sourceGeneration })

    expect(requestResult).toMatchObject({ status: 'ready' })
    expect(JSON.parse(requestResult.data ?? '')).toMatchObject({ kind: 'mcp-request', toolUseId: 'detail-tool-id', input: { query: 'full', limit: 2 } })
    expect(responseResult).toMatchObject({ status: 'ready' })
    expect(JSON.parse(responseResult.data ?? '')).toMatchObject({ kind: 'mcp-response', toolUseId: 'detail-tool-id', content: { rows: [{ id: 1 }], next: null }, isError: false })
  })

  it('实时 MCP 详情跨过默认短 TTL 后仍可按引用读取', async () => {
    const service = createDetailService({
      readFile: async () => Buffer.alloc(0),
      sendToRenderer: () => undefined,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    const requestRef = service.registerMcpTransient(
      'mcp:live-session::main::tool-live:request',
      { kind: 'mcp-request', toolUseId: 'tool-live', toolName: 'mcp__server__query', input: { query: 'delayed' } },
      'live-session',
    )
    const responseRef = service.registerMcpTransient(
      'mcp:live-session::main::tool-live:response',
      { kind: 'mcp-response', toolUseId: 'tool-live', content: { ok: true }, isError: false },
      'live-session',
    )

    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + 31_000))
    try {
      const requestResult = await service.handleDetailRequest({ ...requestRef })
      const responseResult = await service.handleDetailRequest({ ...responseRef })
      expect(requestResult).toMatchObject({ status: 'ready' })
      expect(responseResult).toMatchObject({ status: 'ready' })
      expect(JSON.parse(requestResult.data ?? '').input).toEqual({ query: 'delayed' })
      expect(JSON.parse(responseResult.data ?? '').content).toEqual({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('按时间升序建立完整 cluster，缺失父节点时保留剩余子树', () => {
    const entries = [
      entry('later-root', 500),
      entry('child', 200, 'deleted-parent'),
      entry('grandchild', 300, 'child'),
      entry('early-root', 100)
    ]

    const clusters = buildHistoryClusters(entries)

    expect(clusters.map((cluster) => cluster.clusterId)).toEqual([
      'early-root',
      'child',
      'later-root'
    ])
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
      message: {
        content: 'answer',
        model: 'claude-test',
        usage: { input_tokens: 1, output_tokens: 2 }
      }
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
        'utf8'
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
      `${JSON.stringify({ type: 'user', uuid: 'root-user', message: { content: 'root prompt' } })}\n`
    )
    fs.writeFileSync(
      path.join(claudeDir, 'root.resources.jsonl'),
      `${JSON.stringify({
        version: 1,
        transactionId: 'resource-transaction',
        claudeId: 'root',
        userMessageUuid: 'root-user',
        messageHash: 'hash',
        resources: [
          {
            id: 'resource-1',
            kind: 'pdf',
            origin: 'original',
            path: 'F:\\docs\\spec.pdf',
            displayName: 'spec.pdf',
            order: 0,
            typeIndex: 1
          }
        ],
        boundAt: 1
      })}\n`
    )
    fs.writeFileSync(
      path.join(claudeDir, 'branch.jsonl'),
      [
        { type: 'attachment', uuid: 'attachment', forkedFrom },
        {
          type: 'user',
          uuid: 'inherited-user',
          message: { content: 'inherited prompt' },
          forkedFrom
        },
        {
          type: 'assistant',
          uuid: 'inherited-answer',
          message: { content: 'inherited answer' },
          forkedFrom
        },
        { type: 'user', uuid: 'branch-user', message: { content: 'branch prompt' } },
        { type: 'assistant', uuid: 'branch-answer', message: { content: 'branch answer' } }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    )

    const { projection } = await loadHistoryClusterProjection(snapshot(claudeDir, entries), 'root')
    const branch = projection.sessions.find((item) => item.sessionId === 'branch')

    expect(branch?.timeline.filter((node) => node.isBranchStart).map((node) => node.id)).toEqual([
      'branch-user'
    ])
    expect(
      projection.sessions.find((item) => item.sessionId === 'root')?.timeline[0].resources
    ).toMatchObject([{ id: 'resource-1', kind: 'pdf' }])
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

  it('历史 MCP locator 支持 BOM/CRLF、方向分离并保持主线与 Subagent 作用域隔离', async () => {
    const entries = [entry('root', 100)]
    const mainRequest = {
      type: 'assistant',
      uuid: 'main-request-node',
      message: {
        content: [{
          type: 'tool_use',
          id: 'shared-tool-use-id',
          name: 'mcp__main__query',
          input: { query: 'main' }
        }]
      }
    }
    const mainResponse = {
      type: 'user',
      uuid: 'main-response-node',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'shared-tool-use-id',
          content: [{ type: 'text', text: 'main result' }],
          is_error: false
        }]
      }
    }
    fs.writeFileSync(
      path.join(claudeDir, 'root.jsonl'),
      `﻿${JSON.stringify(mainRequest)}\r\n${JSON.stringify(mainResponse)}\r\n`,
      'utf8'
    )

    const subagentsDir = path.join(claudeDir, 'root', 'subagents')
    fs.mkdirSync(subagentsDir, { recursive: true })
    const subRequest = {
      type: 'assistant',
      uuid: 'sub-request-node',
      isSidechain: true,
      agentId: 'agent-a',
      message: {
        content: [{
          type: 'tool_use',
          id: 'shared-tool-use-id',
          name: 'mcp__sub__query',
          input: { query: 'subagent' }
        }]
      }
    }
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-agent-a.jsonl'),
      `${JSON.stringify(subRequest)}\r\n`,
      'utf8'
    )

    const result = await loadHistoryClusterProjection(snapshot(claudeDir, entries), 'root')
    const mainRequestKey = 'root:main:main-request-node'
    const mainResponseKey = 'root:main:main-response-node'
    const subRequestKey = 'root:agent-a:sub-request-node'

    expect(result.mcpLocatorByNodeId.get(mainRequestKey)).toMatchObject({
      toolUseId: 'shared-tool-use-id',
      toolName: 'mcp__main__query',
      direction: 'request'
    })
    expect(result.mcpLocatorByNodeId.get(mainResponseKey)).toMatchObject({
      toolUseId: 'shared-tool-use-id',
      toolName: 'mcp__main__query',
      direction: 'response'
    })
    expect(result.mcpLocatorByNodeId.get(subRequestKey)).toMatchObject({
      toolUseId: 'shared-tool-use-id',
      toolName: 'mcp__sub__query',
      direction: 'request'
    })

    const mainRequestRange = result.byteRangeByNodeId.get(mainRequestKey)
    const mainResponseRange = result.byteRangeByNodeId.get(mainResponseKey)
    expect(mainRequestRange?.lineEnding).toBe('crlf')
    expect(mainResponseRange?.lineEnding).toBe('crlf')
    expect(mainRequestRange?.byteStart).toBe(3)
    expect(mainRequestRange?.byteEndExclusive).toBe(mainResponseRange?.byteStart)
    expect(JSON.parse(fs.readFileSync(path.join(claudeDir, 'root.jsonl')).subarray(
      mainRequestRange!.byteStart,
      mainRequestRange!.byteEndExclusive
    ).toString('utf8'))).toMatchObject(mainRequest)
  })

  it('历史 MCP 只识别真实 MCP 请求对应的返回，普通工具返回保持未关联', async () => {
    const entries = [entry('root', 100)]
    fs.writeFileSync(
      path.join(claudeDir, 'root.jsonl'),
      [
        {
          type: 'assistant',
          uuid: 'mcp-request',
          message: { content: [{ type: 'tool_use', id: 'mcp-id', name: 'mcp__server__call', input: {} }] }
        },
        {
          type: 'user',
          uuid: 'mcp-response',
          message: { content: [{ type: 'tool_result', tool_use_id: 'mcp-id', content: null, is_error: true }] }
        },
        {
          type: 'user',
          uuid: 'ordinary-response',
          message: { content: [{ type: 'tool_result', tool_use_id: 'ordinary-id', content: 'ordinary' }] }
        }
      ].map((line) => JSON.stringify(line)).join('\n'),
      'utf8'
    )

    const result = await loadHistoryClusterProjection(snapshot(claudeDir, entries), 'root')

    expect(result.mcpLocatorByNodeId.has('root:main:mcp-request')).toBe(true)
    expect(result.mcpLocatorByNodeId.get('root:main:mcp-response')).toMatchObject({
      direction: 'response',
      toolUseId: 'mcp-id',
      isError: true
    })
    expect(result.mcpLocatorByNodeId.has('root:main:ordinary-response')).toBe(false)
  })

  it('删除主线时连带删除全部 Branch、sidecar 与 subagent 目录', async () => {
    const entries = [entry('root', 100), entry('branch', 200, 'root')]
    entries.forEach((item) => writeBundle(claudeDir, item.sessionId))
    writeBundle(claudeDir, 'unrelated')
    const unwatched: string[] = []

    const result = await deleteHistoryTarget(
      snapshot(claudeDir, entries),
      deletionInput('root', 'cluster'),
      {
        isSessionRunning: () => false,
        unwatchSession: (sessionId) => unwatched.push(sessionId)
      }
    )

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
      entry('grandchild', 400, 'child')
    ]
    entries.forEach((item) => writeBundle(claudeDir, item.sessionId))
    const parentTrace = path.join(claudeDir, 'root.insertions.jsonl')
    const traceBefore = fs.readFileSync(parentTrace, 'utf8')

    const result = await deleteHistoryTarget(
      snapshot(claudeDir, entries),
      deletionInput('branch', 'branch'),
      {
        isSessionRunning: () => false,
        unwatchSession: () => undefined
      }
    )

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

    const result = await deleteHistoryTarget(
      snapshot(claudeDir, entries),
      deletionInput('root', 'cluster'),
      {
        isSessionRunning: (sessionId) => sessionId === 'branch',
        unwatchSession: () => undefined
      }
    )

    expect(result).toMatchObject({ ok: false, errorCode: 'HISTORY_SESSION_RUNNING' })
    expect(fs.existsSync(path.join(claudeDir, 'root.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(claudeDir, 'branch.jsonl'))).toBe(true)
  })
})
