// 使用方法：HistoryService 调用 scanHistoryCatalog(projectId, projectPath, signal)
// 编译说明：Electron main / Node.js，使用流式头部读取避免整文件扫描
// 代码说明：建立项目全部历史 Session 的轻量关系图并按 Cluster 稳定排序

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { randomUUID } from 'crypto'
import type { HistoryCatalogEntry, HistoryClusterSummary } from '../../../shared/types/history'
import { pathMatchesProject, resolveProjectDirectory } from './HistoryPaths'

export interface HistoryCatalogSnapshot {
  projectId: string
  projectPath: string
  claudeDir: string
  generation: string
  entries: HistoryCatalogEntry[]
  entriesById: Map<string, HistoryCatalogEntry>
  childrenByParentId: Map<string, string[]>
  clusters: HistoryClusterSummary[]
}

interface SessionHead {
  cwd: string | null
  startedAt: number | null
  parentSessionId: string | null
  forkMessageUuid: string | null
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('History request cancelled'), { code: 'HISTORY_CANCELLED' })
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readStartedAtFromMeta(metaPath: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')) as { startedAt?: unknown }
    return typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)
      ? parsed.startedAt
      : null
  } catch {
    return null
  }
}

async function readSessionHead(filePath: string, signal?: AbortSignal): Promise<SessionHead> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let cwd: string | null = null
  let startedAt: number | null = null
  let parentSessionId: string | null = null
  let forkMessageUuid: string | null = null

  try {
    for await (const line of reader) {
      throwIfAborted(signal)
      if (!line.trim()) continue
      try {
        const raw = JSON.parse(line) as Record<string, unknown>
        if (startedAt === null && typeof raw.timestamp === 'string') {
          const parsed = Date.parse(raw.timestamp)
          if (Number.isFinite(parsed)) startedAt = parsed
        }
        if (cwd === null && typeof raw.cwd === 'string') {
          cwd = raw.cwd
          const forked = raw.forkedFrom as { sessionId?: unknown; messageUuid?: unknown } | undefined
          parentSessionId = typeof forked?.sessionId === 'string' ? forked.sessionId : null
          forkMessageUuid = typeof forked?.messageUuid === 'string' ? forked.messageUuid : null
        }
        if (cwd !== null && startedAt !== null) break
      } catch {
        // 单行损坏不阻塞其他历史记录发现。
      }
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  return { cwd, startedAt, parentSessionId, forkMessageUuid }
}

async function countSubagents(claudeDir: string, sessionId: string): Promise<number> {
  try {
    const entries = await fs.promises.readdir(path.join(claudeDir, sessionId, 'subagents'), {
      withFileTypes: true,
    })
    return entries.filter((entry) => entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')).length
  } catch {
    return 0
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await mapper(values[index])
    }
  })
  await Promise.all(workers)
  return results
}

function resolveClusterRoot(
  entry: HistoryCatalogEntry,
  entriesById: Map<string, HistoryCatalogEntry>,
): { rootId: string; orphaned: boolean } {
  let cursor = entry
  const visited = new Set<string>([entry.sessionId])
  while (cursor.parentSessionId) {
    const parent = entriesById.get(cursor.parentSessionId)
    if (!parent) {
      // 父记录已被单删：当前最高仍存在祖先成为新根，其后代关系继续保留。
      return { rootId: cursor.sessionId, orphaned: true }
    }
    if (visited.has(parent.sessionId)) {
      return { rootId: entry.sessionId, orphaned: true }
    }
    visited.add(parent.sessionId)
    cursor = parent
  }
  return { rootId: cursor.sessionId, orphaned: false }
}

export function historyClusterSortKey(cluster: HistoryClusterSummary): string {
  return `${String(Math.trunc(cluster.startedAt)).padStart(16, '0')}:${cluster.clusterId}`
}

export function buildHistoryClusters(entries: HistoryCatalogEntry[]): HistoryClusterSummary[] {
  const entriesById = new Map(entries.map((entry) => [entry.sessionId, entry]))
  const grouped = new Map<string, { orphaned: boolean; sessions: HistoryCatalogEntry[] }>()

  for (const entry of entries) {
    const { rootId, orphaned } = resolveClusterRoot(entry, entriesById)
    entry.clusterId = rootId
    const group = grouped.get(rootId) ?? { orphaned, sessions: [] }
    group.orphaned ||= orphaned
    group.sessions.push(entry)
    grouped.set(rootId, group)
  }

  const clusters = Array.from(grouped, ([clusterId, group]) => {
    group.sessions.sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))
    const root = entriesById.get(clusterId) ?? group.sessions[0]
    return {
      clusterId,
      rootSessionId: root.sessionId,
      sessions: group.sessions,
      startedAt: root.startedAt,
      endedAt: Math.max(...group.sessions.map((entry) => entry.endedAt)),
      isOrphaned: group.orphaned,
    }
  })
  clusters.sort((a, b) => a.startedAt - b.startedAt || a.clusterId.localeCompare(b.clusterId))
  return clusters
}

export async function scanHistoryCatalog(
  projectId: string,
  projectPath: string,
  signal?: AbortSignal,
  homeDir?: string,
): Promise<HistoryCatalogSnapshot> {
  const started = Date.now()
  const claudeDir = resolveProjectDirectory(projectPath, homeDir)
  if (!(await fileExists(claudeDir))) {
    console.info(`[HistoryCatalog] project=${projectId} directory missing: ${claudeDir}`)
    return {
      projectId,
      projectPath,
      claudeDir,
      generation: randomUUID(),
      entries: [],
      entriesById: new Map(),
      childrenByParentId: new Map(),
      clusters: [],
    }
  }

  const directoryEntries = await fs.promises.readdir(claudeDir, { withFileTypes: true })
  const transcriptNames = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.includes('.insertions.') && !entry.name.includes('.milestones.') && !entry.name.includes('.git-marks.'))
    .map((entry) => entry.name)

  const scanned = await mapWithConcurrency(transcriptNames, 12, async (name) => {
    throwIfAborted(signal)
    const sessionId = name.slice(0, -'.jsonl'.length)
    const transcriptPath = path.join(claudeDir, name)
    try {
      const [stat, head, metaStartedAt, subagentCount, meta, insertions, milestones, gitMarks, sessionDirectory] = await Promise.all([
        fs.promises.stat(transcriptPath),
        readSessionHead(transcriptPath, signal),
        readStartedAtFromMeta(path.join(claudeDir, `${sessionId}.meta.json`)),
        countSubagents(claudeDir, sessionId),
        fileExists(path.join(claudeDir, `${sessionId}.meta.json`)),
        fileExists(path.join(claudeDir, `${sessionId}.insertions.jsonl`)),
        fileExists(path.join(claudeDir, `${sessionId}.milestones.jsonl`)),
        fileExists(path.join(claudeDir, `${sessionId}.git-marks.jsonl`)),
        fileExists(path.join(claudeDir, sessionId)),
      ])
      if (!head.cwd || !pathMatchesProject(head.cwd, projectPath)) return null
      return {
        sessionId,
        projectId,
        cwd: head.cwd,
        startedAt: metaStartedAt ?? head.startedAt ?? stat.mtimeMs,
        endedAt: stat.mtimeMs,
        parentSessionId: head.parentSessionId,
        forkMessageUuid: head.forkMessageUuid,
        clusterId: sessionId,
        sidecarFlags: { meta, insertions, milestones, gitMarks, sessionDirectory },
        subagentCount,
      } satisfies HistoryCatalogEntry
    } catch (error) {
      console.warn(`[HistoryCatalog] skipped session=${sessionId.slice(0, 8)} reason=${String(error)}`)
      return null
    }
  })

  throwIfAborted(signal)
  const entries = scanned.filter((entry): entry is HistoryCatalogEntry => entry !== null)
  const clusters = buildHistoryClusters(entries)
  const entriesById = new Map(entries.map((entry) => [entry.sessionId, entry]))
  const childrenByParentId = new Map<string, string[]>()
  for (const entry of entries) {
    if (!entry.parentSessionId) continue
    const children = childrenByParentId.get(entry.parentSessionId) ?? []
    children.push(entry.sessionId)
    childrenByParentId.set(entry.parentSessionId, children)
  }
  console.info(`[HistoryCatalog] project=${projectId} files=${transcriptNames.length} sessions=${entries.length} clusters=${clusters.length} elapsedMs=${Date.now() - started}`)
  return {
    projectId,
    projectPath,
    claudeDir,
    generation: randomUUID(),
    entries,
    entriesById,
    childrenByParentId,
    clusters,
  }
}
