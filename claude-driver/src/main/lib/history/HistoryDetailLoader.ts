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

interface TimelineProjectionResult {
  timeline: HistoryTimelineNode[]
  visibleIndexByUuid: Map<string, number>
  errors: string[]
  /** nodeId → JSONL 文件内 byte 范围（供 HistoryService 注册 EntityLocator） */
  byteRangeByNodeId: Map<string, { byteStart: number; byteEndExclusive: number }>
}

async function readHistoryTimeline(
  filePath: string,
  sessionId: string,
  signal?: AbortSignal,
  agentId?: string
): Promise<TimelineProjectionResult> {
  const timeline: HistoryTimelineNode[] = []
  const visibleIndexByUuid = new Map<string, number>()
  const byteRangeByNodeId = new Map<string, { byteStart: number; byteEndExclusive: number }>()
  const errors: string[] = []
  const stream = fs.createReadStream(filePath)
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let pendingSnapshotStart = false
  let sawHistorySnapshot = false
  let sawForkedFrom = false
  let fallbackCandidateIndex: number | null = null
  let visibleNodeCount = 0
  let lineNumber = 0

  // 字节追踪：基于 readline 行内容计算，不用 stream.on('data')（readline 和 data 事件时序不同步）
  // 初始偏移：检测 UTF-8 BOM（readline 会剥离 BOM，但字节仍占据位置）
  let currentByteOffset = 0
  let bomChecked = false

  try {
    for await (const line of reader) {
      lineNumber++
      throwIfAborted(signal)

      // 首行检测 BOM：如果文件以 UTF-8 BOM 开头，readline 剥离后 line 不含 BOM，
      // 但 BOM 的 3 字节占据文件位置
      if (!bomChecked) {
        bomChecked = true
        try {
          const head = Buffer.alloc(3)
          const fd = fs.openSync(filePath, 'r')
          fs.readSync(fd, head, 0, 3, 0)
          fs.closeSync(fd)
          if (head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) {
            currentByteOffset = 3
          }
        } catch { /* 忽略 BOM 检测失败 */ }
      }

      if (!line.trim()) {
        // 空行：推进字节偏移（1 for LF, 2 for CRLF — crlfDelay 合并为 LF）
        currentByteOffset += 1
        continue
      }

      // 基于行内容计算字节范围（readline 剥离行尾，JSONL 用 LF）
      const lineBytes = Buffer.byteLength(line, 'utf-8')
      const byteStart = currentByteOffset
      const byteEndExclusive = byteStart + lineBytes + 1 // +1 for LF

      let raw: Record<string, unknown>
      try {
        const parsed = JSON.parse(line) as unknown
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
          // 记录有文本的节点字节范围（user_input/assistant/tool_result）
          if (node.text !== undefined) {
            byteRangeByNodeId.set(node.id, { byteStart, byteEndExclusive })
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
  } finally {
    reader.close()
    stream.destroy()
  }
  return { timeline, visibleIndexByUuid, errors, byteRangeByNodeId }
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

async function loadSubagentProjections(
  claudeDir: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<HistorySubagentProjection[]> {
  const subagentsDir = path.join(claudeDir, sessionId, 'subagents')
  let names: string[]
  try {
    names = await fs.promises.readdir(subagentsDir)
  } catch {
    return []
  }
  const transcriptNames = names.filter(
    (name) =>
      name.startsWith('agent-') && name.endsWith('.jsonl') && !name.endsWith('.insertions.jsonl')
  )
  const results: HistorySubagentProjection[] = []
  for (const name of transcriptNames) {
    throwIfAborted(signal)
    const agentId = name.slice('agent-'.length, -'.jsonl'.length)
    const transcript = await readHistoryTimeline(
      path.join(subagentsDir, name),
      sessionId,
      signal,
      agentId
    )
    const insertions = await replayInsertions(
      path.join(subagentsDir, `agent-${agentId}.insertions.jsonl`),
      signal
    )
    results.push({
      agentId,
      timeline: transcript.timeline,
      insertions: insertions.values,
      partialErrors: [...transcript.errors, ...insertions.errors]
    })
  }
  return results
}

export async function loadHistoryClusterProjection(
  snapshot: HistoryCatalogSnapshot,
  clusterId: string,
  signal?: AbortSignal
): Promise<{ projection: HistoryClusterProjection; byteRangeByNodeId: Map<string, { byteStart: number; byteEndExclusive: number }> }> {
  const cluster = snapshot.clusters.find((item) => item.clusterId === clusterId)
  if (!cluster) {
    throw Object.assign(new Error(`History cluster not found: ${clusterId}`), {
      code: 'HISTORY_NOT_FOUND'
    })
  }

  const projections: HistorySessionProjection[] = []
  const visibleIndexesBySession = new Map<string, Map<string, number>>()
  const allByteRanges = new Map<string, { byteStart: number; byteEndExclusive: number }>()
  for (const entry of cluster.sessions) {
    throwIfAborted(signal)
    const transcriptPath = path.join(snapshot.claudeDir, `${entry.sessionId}.jsonl`)
    const [transcript, insertions, milestones, gitMarks, resources, subagents] = await Promise.all([
      readHistoryTimeline(transcriptPath, entry.sessionId, signal),
      replayInsertions(
        path.join(snapshot.claudeDir, `${entry.sessionId}.insertions.jsonl`),
        signal
      ),
      readJsonLines<Milestone>(
        path.join(snapshot.claudeDir, `${entry.sessionId}.milestones.jsonl`),
        signal
      ),
      readJsonLines<GitMark>(
        path.join(snapshot.claudeDir, `${entry.sessionId}.git-marks.jsonl`),
        signal
      ),
      readJsonLines<ResourceMessageSnapshot>(
        path.join(snapshot.claudeDir, `${entry.sessionId}.resources.jsonl`),
        signal
      ),
      loadSubagentProjections(snapshot.claudeDir, entry.sessionId, signal)
    ])
    const resourcesByUuid = new Map(
      resources.values.map((item) => [item.userMessageUuid, item.resources])
    )
    for (const node of transcript.timeline) {
      const attached = resourcesByUuid.get(node.id)
      if (attached?.length) node.resources = attached
    }
    // 合并主时间线字节范围
    for (const [nodeId, range] of transcript.byteRangeByNodeId) {
      allByteRanges.set(nodeId, range)
    }
    visibleIndexesBySession.set(entry.sessionId, transcript.visibleIndexByUuid)
    projections.push({
      sessionId: entry.sessionId,
      timeline: transcript.timeline,
      insertions: insertions.values,
      milestones: milestones.values,
      gitMarks: gitMarks.values,
      subagents,
      triggerNodeIndex: null,
      partialErrors: [
        ...transcript.errors,
        ...insertions.errors,
        ...milestones.errors,
        ...gitMarks.errors,
        ...resources.errors
      ]
    })
  }

  const projectionsById = new Map(projections.map((item) => [item.sessionId, item]))
  for (const entry of cluster.sessions) {
    if (!entry.parentSessionId || !entry.forkMessageUuid) continue
    const child = projectionsById.get(entry.sessionId)
    if (child) {
      child.triggerNodeIndex =
        visibleIndexesBySession.get(entry.parentSessionId)?.get(entry.forkMessageUuid) ?? null
    }
  }

  const nodeCount = projections.reduce(
    (total, item) =>
      total +
      item.timeline.length +
      item.subagents.reduce((n, subagent) => n + subagent.timeline.length, 0),
    0
  )
  const partialCount = projections.reduce((total, item) => total + item.partialErrors.length, 0)
  const projection: HistoryClusterProjection = {
    clusterId,
    sessions: projections,
    projectedAt: Date.now()
  }
  const estimatedBytes = projections.reduce((total, session) => {
    const timelines = [session.timeline, ...session.subagents.map((subagent) => subagent.timeline)]
    const timelineBytes = timelines
      .flat()
      .reduce(
        (bytes, node) =>
          bytes +
          96 +
          Buffer.byteLength(node.text ?? '') +
          Buffer.byteLength(node.toolDisplayText ?? ''),
        0
      )
    return (
      total +
      timelineBytes +
      session.insertions.length * 128 +
      session.milestones.length * 96 +
      session.gitMarks.length * 96
    )
  }, 0)
  console.info(
    `[HistoryProjection] cluster=${clusterId.slice(0, 8)} sessions=${projections.length} nodes=${nodeCount} partialErrors=${partialCount} estimatedBytes=${estimatedBytes}`
  )
  return { projection, byteRangeByNodeId: allByteRanges }
}
