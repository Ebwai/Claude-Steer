// One serial compensation loop per project; no elapsed-time abandonment.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { TranscriptIdentityScanner } from './TranscriptIdentityScanner'

export type TranscriptProbeResult = 'ready' | 'waiting' | 'conflict'
export interface TranscriptTarget {
  projectKey: string
  claudeId: string
  filePath: string
}

interface TranscriptCursor {
  offset: number
  scanner?: TranscriptIdentityScanner
  fileIdentity?: string
  moreData?: boolean
}

/** Bounded reads advance through inherited Branch prefixes; partial lines stay bounded. */
export async function probeTranscriptIdentity(
  target: TranscriptTarget,
  cursor: TranscriptCursor = { offset: 0 }
): Promise<TranscriptProbeResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.claudeId) ||
      path.basename(target.filePath) !== `${target.claudeId}.jsonl`) return 'conflict'
  let file: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    file = await fs.open(target.filePath, 'r')
    const stat = await file.stat()
    const fileIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
    if ((cursor.fileIdentity && cursor.fileIdentity !== fileIdentity) || stat.size < cursor.offset) {
      cursor.offset = 0
      cursor.scanner?.reset()
    }
    cursor.fileIdentity = fileIdentity
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor.offset)
    cursor.offset += bytesRead
    cursor.moreData = bytesRead > 0 && cursor.offset < stat.size
    cursor.scanner ??= new TranscriptIdentityScanner()
    return cursor.scanner.push(buffer.subarray(0, bytesRead).toString('utf8'), target.claudeId)
  } catch (error) {
    cursor.moreData = false
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'waiting'
    throw error
  } finally {
    await file?.close()
  }
}

interface Consumer {
  ready: (target: TranscriptTarget) => void
  detach: () => void
}
interface TargetEntry {
  target: TranscriptTarget
  consumers: Set<Consumer>
  lastFailure?: string
  cursor: TranscriptCursor
}
interface ProjectLoop {
  entries: Map<string, TargetEntry>
  timer?: ReturnType<typeof setTimeout>
  running: boolean
}

export class TranscriptDiscovery {
  private readonly projects = new Map<string, ProjectLoop>()
  private disposed = false

  constructor(private readonly probe?: (target: TranscriptTarget) => Promise<TranscriptProbeResult>) {}

  watch(target: TranscriptTarget, signal: AbortSignal, ready: Consumer['ready']): () => void {
    if (this.disposed || signal.aborted) return () => {}
    let project = this.projects.get(target.projectKey)
    if (!project) {
      project = { entries: new Map(), running: false }
      this.projects.set(target.projectKey, project)
    }
    const key = target.claudeId
    let entry = project.entries.get(key)
    if (entry && entry.target.filePath !== target.filePath) throw new Error('TRANSCRIPT_TARGET_CONFLICT')
    if (!entry) {
      entry = { target: { ...target }, consumers: new Set(), cursor: { offset: 0 } }
      project.entries.set(key, entry)
    }
    const loop = project
    const item = entry
    const consumer: Consumer = { ready, detach: () => signal.removeEventListener('abort', release) }
    const release = (): void => {
      consumer.detach()
      item.consumers.delete(consumer)
      if (item.consumers.size === 0 && loop.entries.get(key) === item) loop.entries.delete(key)
      this.prune(target.projectKey, loop)
    }
    item.consumers.add(consumer)
    signal.addEventListener('abort', release, { once: true })
    if (!loop.running && !loop.timer) void this.tick(target.projectKey, loop)
    return release
  }

  dispose(): void {
    this.disposed = true
    for (const [key, project] of this.projects) {
      for (const entry of project.entries.values()) for (const consumer of entry.consumers) consumer.detach()
      project.entries.clear()
      this.prune(key, project)
    }
  }

  get activeTargets(): number {
    return [...this.projects.values()].reduce((sum, project) => sum + project.entries.size, 0)
  }

  private prune(key: string, project: ProjectLoop): void {
    if (project.entries.size !== 0) return
    if (project.timer) clearTimeout(project.timer)
    project.timer = undefined
    // Keep an in-flight loop registered until it settles, preventing overlapping replacement work.
    if (!project.running && this.projects.get(key) === project) this.projects.delete(key)
  }

  private async tick(key: string, project: ProjectLoop): Promise<void> {
    project.timer = undefined
    project.running = true
    try {
      for (const [id, entry] of [...project.entries]) {
        if (this.disposed || project.entries.get(id) !== entry) continue
        try {
          const result = await (this.probe ? this.probe(entry.target) : probeTranscriptIdentity(entry.target, entry.cursor))
          if (this.disposed || project.entries.get(id) !== entry) continue
          if (result === 'ready') {
            project.entries.delete(id)
            for (const consumer of entry.consumers) {
              consumer.detach()
              try { consumer.ready(entry.target) } catch (error) { console.error('[TranscriptDiscovery] handoff failed', { claudeId: id, error }) }
            }
            entry.consumers.clear()
            console.info('[TranscriptDiscovery] ready', { claudeId: id, activeTargets: this.activeTargets })
          } else if (result === 'conflict') {
            this.report(entry, 'identity-conflict')
          } else if (entry.lastFailure) {
            entry.lastFailure = undefined
            console.info('[TranscriptDiscovery] waiting recovered', { claudeId: id })
          }
        } catch (error) {
          if (project.entries.get(id) === entry) this.report(entry, (error as NodeJS.ErrnoException).code ?? String(error))
        }
      }
    } finally {
      project.running = false
      if (!this.disposed && project.entries.size > 0) {
        // Preserve existing 1000 ms directory retry cadence, without the old retry limit.
        const hasBufferedData = [...project.entries.values()].some(entry => entry.cursor.moreData)
        project.timer = setTimeout(() => void this.tick(key, project), hasBufferedData ? 0 : 1000)
        project.timer.unref?.()
      } else this.prune(key, project)
    }
  }

  private report(entry: TargetEntry, reason: string): void {
    if (entry.lastFailure === reason) return
    entry.lastFailure = reason
    console.warn('[TranscriptDiscovery] waiting', { claudeId: entry.target.claudeId, reason })
  }
}
