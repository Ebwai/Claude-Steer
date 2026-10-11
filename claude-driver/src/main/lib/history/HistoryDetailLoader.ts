// 使用方法：HistoryService.loadDetails 调用 loadHistoryClusterProjection
// 编译说明：Electron main / Node.js，JSONL 与 sidecar 均使用 createReadStream + readline
// 代码说明：逐行把原始 JSONL 投影为单 Cluster 紧凑时间线；raw 不进入 IPC 或常驻缓存

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import type { GitMark, Milestone } from '../../../shared/types/index'
import type {
  HistoryClusterProjection,
  HistorySessionProjection,
  HistorySubagentProjection,
  HistoryTimelineNode
} from '../../../shared/types/history'
import type { LineInsertion } from '../../../shared/types/lineInsertion'
import type { ResourceMessageSnapshot } from '../../../shared/types/resources'
import { extractToolDisplay, type JsonlRecord } from '../../../shared/types/jsonl'
import { parseJsonlObject } from '../jsonl/JsonlParser'
import type { HistoryCatalogSnapshot } from './HistoryCatalog'

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('History request cancelled'), { code: 'HISTORY_CANCELLED' })
  }
}

function projectRecord(
  record: JsonlRecord,
  sessionId: string,
  fallbackId: string
): HistoryTimelineNode | null {
  const id = record.uuid ?? fallbackId
  switch (record.type) {
    case 'user':
      if (!record.text?.trim()) return null
      return {
        id,
        sessionId,
        type: 'user_input',
        text: record.text,
        isBranchStart: record.isBranchStart,
        parsedAt: record.parsedAt
      }
    case 'assistant':
      if (!record.text?.trim()) return null
      return { id, sessionId, type: 'assistant', text: record.text, parsedAt: record.parsedAt }
    case 'tool_use': {
      if (!record.toolUse) return null
      const display = extractToolDisplay(record.toolUse)
      return {
        id,
        sessionId,
        type: 'tool_use',
        toolName: display.toolName,
        toolDisplayText: display.displayText,
        toolUseId: record.toolUse.id,
        parsedAt: record.parsedAt
      }
    }
    case 'tool_result':
      if (!record.toolResult) return null
      return {
        id,
        sessionId,
        type: 'tool_result',
        toolUseId: record.toolResult.tool_use_id,
        isError: record.toolResult.is_error ?? false,
        text: typeof record.toolResult.content === 'string' ? record.toolResult.content : undefined,
        parsedAt: record.parsedAt
      }
    default:
      return null
  }
}

export type HistoryByteRange = {
  byteStart: number
  byteEndExclusive: number
  lineEnding: 'lf' | 'crlf'
}

export interface McpLocatorInfo {
  toolUseId: string
  toolName: string
  direction: 'request' | 'response'
  isError?: boolean
}

export interface TimelineProjectionResult {
  transcriptMissing?: boolean
  timeline: HistoryTimelineNode[]
  visibleIndexByUuid: Map<string, number>
  errors: string[]
  /** scope/nodeId → JSONL 文件内 byte 范围（供 HistoryService 注册 EntityLocator） */
  byteRangeByNodeId: Map<string, HistoryByteRange>
  /** scope/nodeId → MCP 方向信息；完整内容仍只由 DetailService 按 locator 读取 */
  mcpLocatorByNodeId: Map<string, McpLocatorInfo>
}

function scopedNodeKey(sessionId: string, nodeId: string, agentId?: string): string {
  return `${sessionId}:${agentId ?? 'main'}:${nodeId}`
}

async function detectLineEnding(filePath: string): Promise<'lf' | 'crlf'> {
  const prefixSize = 0xffff
  let fileHandle: fs.promises.FileHandle | undefined
  try {
    fileHandle = await fs.promises.open(filePath, 'r')
    const sample = Buffer.alloc(prefixSize)
    const { bytesRead } = await fileHandle.read(sample, 0, sample.length, 0)
    for (let index = 0; index < bytesRead; index++) {
      if (sample[index] === 0x0a) {
        return index > 0 && sample[index - 1] === 0x0d ? 'crlf' : 'lf'
      }
    }
  } catch (error) {
    console.warn(`[HistoryProjection] line ending detection failed file=${path.basename(filePath)} error=${String(error)}`)
  } finally {
    try {
      await fileHandle?.close()
    } catch (error) {
      console.warn(`[HistoryProjection] line ending handle close failed file=${path.basename(filePath)} error=${String(error)}`)
    }
  }
  return 'lf'
}


async function readHistoryTimeline(
  filePath: string,
  sessionId: string,
  signal?: AbortSignal,
  agentId?: string
): Promise<TimelineProjectionResult> {
  const timeline: HistoryTimelineNode[] = []
  const visibleIndexByUuid = new Map<string, number>()
  const byteRangeByNodeId = new Map<string, HistoryByteRange>()
  const mcpLocatorByNodeId = new Map<string, McpLocatorInfo>()
  const errors: string[] = []
  let fileSize = 0
  try {
    fileSize = (await fs.promises.stat(filePath)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.info(`[HistoryProjection] transcript unavailable session=${sessionId.slice(0, 8)} agent=${agentId ?? 'main'}`)
      return { timeline, visibleIndexByUuid, errors, byteRangeByNodeId, mcpLocatorByNodeId, transcriptMissing: true }
    }
    console.warn(`[HistoryProjection] file size detection failed file=${path.basename(filePath)} error=${String(error)}`)
    throw error
  }
  const detectedLineEnding = await detectLineEnding(filePath)
  const stream = fs.createReadStream(filePath)
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let pendingSnapshotStart = false
  let sawHistorySnapshot = false
  let sawForkedFrom = false
  let fallbackCandidateIndex: number | null = null
  let visibleNodeCount = 0
  let lineNumber = 0
  let currentByteOffset = 0
  let bomChecked = false

  try {
    for await (const line of reader) {
      lineNumber++
      throwIfAborted(signal)

      if (!bomChecked) {
        bomChecked = true
        try {
          const head = Buffer.alloc(3)
          const fd = fs.openSync(filePath, 'r')
          fs.readSync(fd, head, 0, 3, 0)
          fs.closeSync(fd)
          if (head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) currentByteOffset = 3
        } catch (error) {
          console.warn(`[HistoryProjection] BOM detection failed file=${path.basename(filePath)} error=${String(error)}`)
        }
      }

      const normalizedLine = lineNumber === 1 ? line.replace(/^﻿/, '') : line
      const lineBytes = Buffer.byteLength(normalizedLine, 'utf-8')
      const byteStart = currentByteOffset
      const expectedLineEnd = currentByteOffset + lineBytes
      const hasLineEnding = expectedLineEnd < fileSize
      const lineEndingBytes = hasLineEnding ? (detectedLineEnding === 'crlf' ? 2 : 1) : 0
      const byteEndExclusive = byteStart + lineBytes + lineEndingBytes

      if (!line.trim()) {
        currentByteOffset = byteEndExclusive
        continue
      }

      let raw: Record<string, unknown>
      try {
        const parsed = JSON.parse(normalizedLine) as unknown
        if (typeof parsed !== 'object' || parsed === null) {
          currentByteOffset = byteEndExclusive
          continue
        }
        raw = parsed as Record<string, unknown>
      } catch {
        errors.push(`line ${lineNumber}: malformed JSON`)
        currentByteOffset = byteEndExclusive
        continue
      }

      const isSnapshot = raw.type === 'file-history-snapshot'
      const forkedFrom = raw.forkedFrom
      const hasForkedFrom =
        typeof forkedFrom === 'object' &&
        forkedFrom !== null &&
        typeof (forkedFrom as Record<string, unknown>).sessionId === 'string'
      sawHistorySnapshot ||= isSnapshot
      sawForkedFrom ||= hasForkedFrom

      const record = parseJsonlObject(raw)
      if (record) {
        record.sessionId = sessionId
        if (agentId) {
          record.agentId = agentId
          record.isSidechain = true
        }
        if (!agentId && pendingSnapshotStart && record.type === 'user') {
          record.isBranchStart = true
          pendingSnapshotStart = false
        }

        const node = projectRecord(
          record,
          sessionId,
          `history-${sessionId}-${agentId ?? 'main'}-${lineNumber}`
        )
        if (record.uuid) visibleIndexByUuid.set(record.uuid, Math.max(0, visibleNodeCount - 1))
        if (node) {
          if (
            !agentId &&
            fallbackCandidateIndex === null &&
            sawForkedFrom &&
            !hasForkedFrom &&
            record.type === 'user'
          ) {
            fallbackCandidateIndex = timeline.length
          }

          byteRangeByNodeId.set(scopedNodeKey(sessionId, node.id, agentId), {
            byteStart,
            byteEndExclusive,
            lineEnding: detectedLineEnding,
          })

          if (record.type === 'tool_use' && record.toolUse && isMcpToolName(record.toolUse.name)) {
            mcpLocatorByNodeId.set(scopedNodeKey(sessionId, node.id, agentId), {
              toolUseId: record.toolUse.id,
              toolName: record.toolUse.name,
              direction: 'request',
            })
          } else if (record.type === 'tool_result' && record.toolResult) {
            // tool_result 没有工具名；先保留行定位，待扫描结束后按 tool_use_id 判定 MCP。
            const toolUseId = record.toolResult.tool_use_id
            if (typeof toolUseId === 'string' && toolUseId.length > 0) {
              mcpLocatorByNodeId.set(scopedNodeKey(sessionId, node.id, agentId), {
                toolUseId,
                toolName: '',
                direction: 'response',
                isError: record.toolResult.is_error ?? false,
              })
            }
          }

          timeline.push(node)
          if (node.type === 'user_input' || node.type === 'assistant') visibleNodeCount++
        }
      }
      currentByteOffset = byteEndExclusive
      pendingSnapshotStart ||= isSnapshot
    }

    if (!agentId && !sawHistorySnapshot && sawForkedFrom && fallbackCandidateIndex !== null) {
      const firstBranchUser = timeline[fallbackCandidateIndex]
      if (firstBranchUser) {
        firstBranchUser.isBranchStart = true
        console.info(
          `[HistoryProjection] Branch start fallback session=${sessionId.slice(0, 8)} strategy=forkedFrom-boundary-user node=${firstBranchUser.id.slice(0, 12)}`
        )
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    console.info(`[HistoryProjection] transcript removed during load session=${sessionId.slice(0, 8)} agent=${agentId ?? 'main'}`)
    return { timeline: [], visibleIndexByUuid: new Map(), errors: [], byteRangeByNodeId: new Map(), mcpLocatorByNodeId: new Map(), transcriptMissing: true }
  } finally {
    reader.close()
    stream.destroy()
  }
  const mcpToolNamesByUseId = new Map<string, string>()
  for (const locator of mcpLocatorByNodeId.values()) {
    if (locator.direction === 'request' && isMcpToolName(locator.toolName)) {
      mcpToolNamesByUseId.set(locator.toolUseId, locator.toolName)
    }
  }
  for (const [nodeId, locator] of mcpLocatorByNodeId) {
    if (locator.direction === 'response' && !mcpToolNamesByUseId.has(locator.toolUseId)) {
      mcpLocatorByNodeId.delete(nodeId)
      continue
    }
    if (locator.direction === 'response') locator.toolName = mcpToolNamesByUseId.get(locator.toolUseId) ?? ''
  }
  console.info(
    `[HistoryProjection] timeline scanned session=${sessionId.slice(0, 8)} agent=${agentId ?? 'main'} nodes=${timeline.length} mcpLocators=${mcpLocatorByNodeId.size} lineEnding=${detectedLineEnding}`
  )
  return { timeline, visibleIndexByUuid, errors, byteRangeByNodeId, mcpLocatorByNodeId }
}

function isMcpToolName(toolName: unknown): toolName is string {
  return typeof toolName === 'string' && toolName.startsWith('mcp__')
}

async function readJsonLines<T>(
  filePath: string,
  signal?: AbortSignal
): Promise<{ values: T[]; errors: string[] }> {
  const values: T[] = []
  const errors: string[] = []
  let stream: fs.ReadStream | null = null
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
    let lineNumber = 0
    try {
      for await (const line of reader) {
        lineNumber++
        throwIfAborted(signal)
        if (!line.trim()) continue
        try {
          values.push(JSON.parse(line) as T)
        } catch {
          errors.push(`line ${lineNumber}: malformed JSON`)
        }
      }
    } finally {
      reader.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: string }).code
    if (code === 'HISTORY_CANCELLED') throw error
    if (code !== 'ENOENT') errors.push(String(error))
  } finally {
    stream?.destroy()
  }
  return { values, errors }
}

async function replayInsertions(
  filePath: string,
  signal?: AbortSignal
): Promise<{ values: LineInsertion[]; errors: string[] }> {
  const parsed = await readJsonLines<Record<string, unknown>>(filePath, signal)
  const byId = new Map<string, LineInsertion>()
  const order: string[] = []
  for (const item of parsed.values) {
    const id = typeof item.id === 'string' ? item.id : null
    if (!id) continue
    if (item._patch === true) {
      const existing = byId.get(id)
      if (existing) {
        const patch = { ...item }
        delete patch._patch
        byId.set(id, { ...existing, ...patch } as LineInsertion)
      }
      continue
    }
    if (!byId.has(id)) order.push(id)
    byId.set(id, item as unknown as LineInsertion)
  }
  return {
    values: order.map((id) => byId.get(id)).filter((item): item is LineInsertion => !!item),
    errors: parsed.errors
  }
}

interface SubagentProjectionResult {
  projection: HistorySubagentProjection
  byteRangeByNodeId: Map<string, HistoryByteRange>
  mcpLocatorByNodeId: Map<string, McpLocatorInfo>
}

async function loadSubagentProjections(
  claudeDir: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<SubagentProjectionResult[]> {
  const subagentsDir = path.join(claudeDir, sessionId, 'subagents')
  let names: string[]
  try {
    names = await fs.promises.readdir(subagentsDir)
  } catch {
    return []
  }
  const transcriptNames = names.filter(
    (name) => name.startsWith('agent-') && name.endsWith('.jsonl') && !name.endsWith('.insertions.jsonl')
  )
  const results: SubagentProjectionResult[] = []
  for (const name of transcriptNames) {
    throwIfAborted(signal)
    const agentId = name.slice('agent-'.length, -'.jsonl'.length)
    const transcript = await readHistoryTimeline(path.join(subagentsDir, name), sessionId, signal, agentId)
    const insertions = await replayInsertions(path.join(subagentsDir, `agent-${agentId}.insertions.jsonl`), signal)
    results.push({
      projection: {
        agentId,
        timeline: transcript.timeline,
        insertions: insertions.values,
        partialErrors: [...transcript.errors, ...insertions.errors]
      },
      byteRangeByNodeId: transcript.byteRangeByNodeId,
      mcpLocatorByNodeId: transcript.mcpLocatorByNodeId,
    })
  }
  return results
}

export async function loadHistoryClusterProjection(
  snapshot: HistoryCatalogSnapshot,
  clusterId: string,
  signal?: AbortSignal
): Promise<{
  projection: HistoryClusterProjection
  byteRangeByNodeId: Map<string, HistoryByteRange>
  mcpLocatorByNodeId: Map<string, McpLocatorInfo>
}> {
  const cluster = snapshot.clusters.find((item) => item.clusterId === clusterId)
  if (!cluster) {
    throw Object.assign(new Error(`History cluster not found: ${clusterId}`), {
      code: 'HISTORY_NOT_FOUND'
    })
  }

  const projections: HistorySessionProjection[] = []
  const visibleIndexesBySession = new Map<string, Map<string, number>>()
  const allByteRanges = new Map<string, HistoryByteRange>()
  const allMcpLocators = new Map<string, McpLocatorInfo>()
  for (const entry of cluster.sessions) {
    throwIfAborted(signal)
    const transcriptPath = path.join(snapshot.claudeDir, `${entry.sessionId}.jsonl`)
    const [transcript, insertions, milestones, gitMarks, resources, subagentResults] = await Promise.all([
      readHistoryTimeline(transcriptPath, entry.sessionId, signal),
      replayInsertions(path.join(snapshot.claudeDir, `${entry.sessionId}.insertions.jsonl`), signal),
      readJsonLines<Milestone>(path.join(snapshot.claudeDir, `${entry.sessionId}.milestones.jsonl`), signal),
      readJsonLines<GitMark>(path.join(snapshot.claudeDir, `${entry.sessionId}.git-marks.jsonl`), signal),
      readJsonLines<ResourceMessageSnapshot>(path.join(snapshot.claudeDir, `${entry.sessionId}.resources.jsonl`), signal),
      loadSubagentProjections(snapshot.claudeDir, entry.sessionId, signal)
    ])
    const resourcesByUuid = new Map(resources.values.map((item) => [item.userMessageUuid, item.resources]))
    for (const node of transcript.timeline) {
      const attached = resourcesByUuid.get(node.id)
      if (attached?.length) node.resources = attached
    }
    for (const [nodeId, range] of transcript.byteRangeByNodeId) allByteRanges.set(nodeId, range)
    for (const [nodeId, locator] of transcript.mcpLocatorByNodeId) allMcpLocators.set(nodeId, locator)
    const subagents = subagentResults.map((item) => item.projection)
    for (const result of subagentResults) {
      for (const [nodeId, range] of result.byteRangeByNodeId) allByteRanges.set(nodeId, range)
      for (const [nodeId, locator] of result.mcpLocatorByNodeId) allMcpLocators.set(nodeId, locator)
    }
    visibleIndexesBySession.set(entry.sessionId, transcript.visibleIndexByUuid)
    projections.push({
      sessionId: entry.sessionId,
      timeline: transcript.timeline,
      transcriptMissing: transcript.transcriptMissing,
      insertions: insertions.values,
      milestones: milestones.values,
      gitMarks: gitMarks.values,
      subagents,
      triggerNodeIndex: null,
      partialErrors: [...transcript.errors, ...insertions.errors, ...milestones.errors, ...gitMarks.errors, ...resources.errors]
    })
  }

  const projectionsById = new Map(projections.map((item) => [item.sessionId, item]))
  for (const entry of cluster.sessions) {
    if (!entry.parentSessionId || !entry.forkMessageUuid) continue
    const child = projectionsById.get(entry.sessionId)
    if (child) child.triggerNodeIndex = visibleIndexesBySession.get(entry.parentSessionId)?.get(entry.forkMessageUuid) ?? null
  }

  const nodeCount = projections.reduce(
    (total, item) => total + item.timeline.length + item.subagents.reduce((n, subagent) => n + subagent.timeline.length, 0),
    0
  )
  const partialCount = projections.reduce((total, item) => total + item.partialErrors.length, 0)
  const projection: HistoryClusterProjection = { clusterId, sessions: projections, projectedAt: Date.now() }
  const estimatedBytes = projections.reduce((total, session) => {
    const timelines = [session.timeline, ...session.subagents.map((subagent) => subagent.timeline)]
    const timelineBytes = timelines.flat().reduce(
      (bytes, node) => bytes + 96 + Buffer.byteLength(node.text ?? '') + Buffer.byteLength(node.toolDisplayText ?? ''),
      0
    )
    return total + timelineBytes + session.insertions.length * 128 + session.milestones.length * 96 + session.gitMarks.length * 96
  }, 0)
  console.info(`[HistoryProjection] cluster=${clusterId.slice(0, 8)} sessions=${projections.length} nodes=${nodeCount} mcpLocators=${allMcpLocators.size} partialErrors=${partialCount} estimatedBytes=${estimatedBytes}`)
  return { projection, byteRangeByNodeId: allByteRanges, mcpLocatorByNodeId: allMcpLocators }
}
