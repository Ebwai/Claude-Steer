// 使用方法：import { JsonlWatcher } from './lib/jsonl/JsonlWatcher'
//           const watcher = new JsonlWatcher(onNewRecord)
//           watcher.watch('/path/to/session.jsonl', sessionId)
// 编译说明：主进程 Node.js 模块，依赖 chokidar（无 native binding）
// 代码说明：JSONL tail 增量监听器——使用 chokidar 监听文件变化，只读新增 bytes（tail 模式）
//           depth:3 覆盖 subagents/<uuid>.jsonl 子目录层级

import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { parseJsonlLine, extractSessionIdFromPath, extractSubagentInfo, type JsonlRecord } from './JsonlParser'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

export interface JsonlWatcherCallbacks {
  /**
   * @param record    解析后的 JSONL 记录（record.agentId 已由 watcher 填充）
   * @param sessionId 父 session 的 PTY UUID（通过 watchFile 注册的 key）
   * @param filePath  来源文件路径
   * @param agentId   subagent ID（主 session 记录为 undefined）
   */
  onRecord: (record: JsonlRecord, sessionId: string, filePath: string, agentId?: string) => void
  onError: (err: Error, filePath: string) => void
}

interface WatchedFile {
  filePath: string
  sessionId: string
  /** subagent 文件的 agentId（主 session 文件为 undefined） */
  agentId?: string
  /** 上次读取的字节偏移（tail 追加模式的核心） */
  readOffset: number
  /** 是否正等待 file-history-snapshot 后的下一条普通 user 记录 */
  prevWasHistorySnapshot?: boolean
  /** JSONL 是否通过顶层 forkedFrom 声明为 Branch 会话 */
  isBranchTranscript?: boolean
  /** 是否已观察到旧版 file-history-snapshot 标记 */
  hasHistorySnapshot?: boolean
  /** 是否已经为当前 Branch 标记过首条可见 user 记录 */
  branchStartMarked?: boolean
  /** 持有该文件监听的 Session consumer lease key。 */
  consumers: Set<string>
}

interface WatchedDirectory {
  path: string
  owners: Set<string>
}

export interface JsonlWatcherResourceSnapshot {
  sessions: number
  files: number
  directories: number
  consumers: number
  inFlightStreams: number
}

export class JsonlWatcher {
  private watcher: FSWatcher | null = null
  private watchedFiles = new Map<string, WatchedFile>()
  private watchedDirectories = new Map<string, WatchedDirectory>()
  private activeStreamsByFile = new Map<string, Set<fs.ReadStream>>()
  private callbacks: JsonlWatcherCallbacks

  constructor(callbacks: JsonlWatcherCallbacks) {
    this.callbacks = callbacks
  }

  /**
   * 开始监听指定 JSONL 文件（tail 模式，只处理新增内容）
   * @param filePath JSONL 文件绝对路径
   * @param sessionId 对应的 session UUID（主 session PTY ID 或 subagent 父 session PTY ID）
   * @param readFromStart 是否从头全量读取（历史模式），默认 false（tail 模式）
   * @param agentId 若为 subagent 文件，传入 agentId；主 session 文件省略
   */
  watchFile(
    filePath: string,
    sessionId: string,
    readFromStart = false,
    agentId?: string,
    consumerId = 'legacy',
  ): void {
    const consumerKey = this.consumerKey(sessionId, consumerId)
    const watched = this.watchedFiles.get(filePath)
    const alreadyWatched = watched !== undefined

    if (!alreadyWatched) {
      const initialOffset = readFromStart ? 0 : this.getFileSize(filePath)
      this.watchedFiles.set(filePath, {
        filePath,
        sessionId,
        agentId,
        readOffset: initialOffset,
        consumers: new Set([consumerKey]),
      })

      if (readFromStart) {
        // 历史模式：立即全量读取
        this.readNewContent(filePath)
      }

      this.ensureWatcher()
      this.watcher?.add(filePath)
      console.log(`[JsonlWatcher] Watching ${filePath} (offset: ${initialOffset})`)
    } else {
      // 先登记、后建文件是新会话的正常时序：renderer 会在 SessionStart 后立即请求监听，
      // 此时 JSONL 可能尚不存在；autoWatchTranscript 找到真实文件后会再次以
      // readFromStart=true 调用。Windows/chokidar 不保证先前对不存在文件的 add 能收到
      // 后续创建事件，因此这里必须重新挂载真实文件，并补读尚未消费的首批内容。
      if (watched.sessionId !== sessionId) {
        this.migrateSessionConsumers(watched.sessionId, sessionId)
      }
      watched.sessionId = sessionId
      watched.agentId = agentId
      watched.consumers.add(consumerKey)
      this.ensureWatcher()
      this.watcher?.add(filePath)
      const currentSize = this.getFileSize(filePath)
      if (readFromStart && watched.readOffset === 0 && currentSize > 0) {
        console.info(
          `[JsonlWatcher] Reconciled pre-registered transcript: session=${sessionId.slice(0, 8)} bytes=${currentSize}`,
        )
        this.readNewContent(filePath)
      }
    }

    // 主 session 文件：始终尝试激活 subagents/ 目录监听与扫描
    // 这里不用 alreadyWatched 短路，因为 JSONL_WATCH（renderer调用）和 autoWatchTranscript（主进程）
    // 可能先后调用 watchFile，第二次调用时文件已注册，但 sessionUuidDir 监听和 scanSubagentsDir 可能
    // 尚未执行（第一次 readFromStart=false 时跳过了）
    if (!agentId) {
      // 关键修复：监听 JSONL 所在的项目目录（~/.claude/projects/<encoded>/），而非 sessionUuidDir
      // 原因：sessionUuidDir（<session-uuid>/）在 subagent 首次运行前不存在，watcher.add 会静默失败。
      //       项目目录一定存在（主 JSONL 文件本身就在其中），depth:3 可覆盖 subagents/agent-*.jsonl
      const projectDir = path.dirname(filePath)  // ~/.claude/projects/<encoded>/
      const sessionUuidDir = filePath.replace(/\.jsonl$/, '')  // 同名目录（可能不存在）
      this.ensureWatcher()

      // 扫描已有 subagent 文件（历史 session 或当前 session 已运行过 subagent）
      const subagentsDir = path.join(sessionUuidDir, 'subagents')
      this.addDirectoryLease(projectDir, consumerKey)
      this.addDirectoryLease(sessionUuidDir, consumerKey)
      this.addDirectoryLease(subagentsDir, consumerKey)
      this.scanSubagentsDir(subagentsDir, sessionId)

      if (!alreadyWatched) {
        console.log(`[JsonlWatcher] Also watching project dir: ${projectDir} + session dir: ${sessionUuidDir}`)
      }
    }
  }

  /**
   * 监听整个项目目录（覆盖主 session + subagents，depth:3）
   * @param encodedProjectPath 项目路径编码名（如 -home-tony-myproject）
   */
  watchProject(encodedProjectPath: string): void {
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodedProjectPath)

    this.ensureWatcher()
    this.watcher?.add(projectDir)
    console.log(`[JsonlWatcher] Watching project dir: ${projectDir}`)
  }

  /** 停止监听指定文件 */
  unwatchFile(filePath: string): void {
    this.disposeWatchedFile(filePath)
  }

  /** 仅释放一个 renderer/main consumer；其他 consumer 仍持有时继续监听。 */
  releaseSessionConsumer(sessionId: string, consumerId: string): JsonlWatcherResourceSnapshot {
    const consumerKey = this.consumerKey(sessionId, consumerId)
    for (const [filePath, watched] of this.watchedFiles) {
      if (watched.sessionId !== sessionId || !watched.consumers.delete(consumerKey)) continue
      if (watched.consumers.size === 0) this.disposeWatchedFile(filePath)
    }
    this.releaseDirectoryOwner(consumerKey)
    const snapshot = this.getResourceSnapshot()
    console.info(
      `[JsonlWatcher] Lease released session=${sessionId.slice(0, 8)} consumer=${consumerId} files=${snapshot.files} dirs=${snapshot.directories} consumers=${snapshot.consumers}`,
    )
    return snapshot
  }

  /**
   * 停止监听某个 Session 的主 JSONL 与全部 Subagent JSONL。
   * 删除事务在 rename 前调用，避免 Windows 文件占用和迟到记录回插。
   * 重复调用幂等；返回本次释放数量便于诊断。
   */
  unwatchSession(sessionId: string): number {
    const targets = Array.from(this.watchedFiles.entries())
      .filter(([, watched]) => watched.sessionId === sessionId)
      .map(([filePath]) => filePath)
    for (const filePath of targets) this.disposeWatchedFile(filePath)
    this.releaseDirectoryOwnersForSession(sessionId)
    console.info(`[JsonlWatcher] Unwatched session=${sessionId.slice(0, 8)} files=${targets.length}`)
    return targets.length
  }

  /** 停止所有监听 */
  close(): void {
    for (const streams of this.activeStreamsByFile.values()) {
      for (const stream of streams) stream.destroy()
    }
    this.activeStreamsByFile.clear()
    this.watcher?.close()
    this.watcher = null
    this.watchedFiles.clear()
    this.watchedDirectories.clear()
  }

  getResourceSnapshot(): JsonlWatcherResourceSnapshot {
    const sessions = new Set(Array.from(this.watchedFiles.values(), (item) => item.sessionId)).size
    const consumerKeys = new Set<string>()
    for (const watched of this.watchedFiles.values()) {
      watched.consumers.forEach((consumer) => consumerKeys.add(consumer))
    }
    for (const directory of this.watchedDirectories.values()) {
      directory.owners.forEach((consumer) => consumerKeys.add(consumer))
    }
    let inFlightStreams = 0
    for (const streams of this.activeStreamsByFile.values()) inFlightStreams += streams.size
    return {
      sessions,
      files: this.watchedFiles.size,
      directories: this.watchedDirectories.size,
      consumers: consumerKeys.size,
      inFlightStreams,
    }
  }

  hasSessionConsumer(sessionId: string, consumerId: string): boolean {
    const consumerKey = this.consumerKey(sessionId, consumerId)
    for (const watched of this.watchedFiles.values()) {
      if (watched.sessionId === sessionId && watched.consumers.has(consumerKey)) return true
    }
    return false
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  private ensureWatcher(): void {
    if (this.watcher) return

    this.watcher = chokidar.watch([], {
      persistent: true,
      ignoreInitial: true, // 不触发初始 add 事件（由 watchFile 手动处理）
      depth: 3,            // 覆盖 <session-uuid>/subagents/<subagent-uuid>.jsonl
      usePolling: false,   // 使用 inotify（Linux/macOS），性能更好
      awaitWriteFinish: {
        stabilityThreshold: 50, // 等待写入稳定 50ms 后触发
        pollInterval: 20
      }
    })

    this.watcher.on('change', (filePath) => {
      if (!filePath.endsWith('.jsonl')) return
      this.handleFileChange(filePath)
    })

    this.watcher.on('add', (filePath) => {
      if (!filePath.endsWith('.jsonl')) return

      if (!this.watchedFiles.has(filePath)) {
        // 未预先注册的新文件——先尝试识别为 subagent 文件
        const subagentInfo = extractSubagentInfo(filePath)
        if (subagentInfo) {
          // subagent 文件：需要找到对应父 session 的 PTY ID
          // 用 subagentInfo.sessionUuid 查找已注册文件中匹配的父 sessionId
          // （父 session 文件路径包含 sessionUuid，所以直接从已注册文件中查找）
          let parentPtyId: string | undefined
          for (const [fp, wf] of this.watchedFiles) {
            if (fp.includes(subagentInfo.sessionUuid)) {
              parentPtyId = wf.sessionId
              break
            }
          }
          // fallback：若找不到父 PTY ID，用 sessionUuid 本身（会导致渲染侧找不到 session）
          const sessionId = parentPtyId ?? subagentInfo.sessionUuid
          const consumers = this.findSessionConsumers(subagentInfo.sessionUuid)
          this.watchedFiles.set(filePath, {
            filePath,
            sessionId,
            agentId: subagentInfo.agentId,
            readOffset: 0,
            consumers,
          })
          console.log(`[JsonlWatcher] Subagent JSONL detected: ${filePath} (agentId: ${subagentInfo.agentId}, parentSession: ${sessionId})`)
        } else {
          // 普通主 session 文件
          const sessionId = extractSessionIdFromPath(filePath)
          if (sessionId) {
            this.watchedFiles.set(filePath, {
              filePath,
              sessionId,
              readOffset: 0,
              consumers: new Set([this.consumerKey(sessionId, 'project-discovery')]),
            })
            console.log(`[JsonlWatcher] New JSONL detected: ${filePath}`)
          }
        }
      } else {
        // 已预先注册但文件之前不存在，现在被创建——必须读取初始内容
        // 场景：watchFile() 在文件创建前被调用（session 尚未产生第一条记录）
        // 不处理此 add 事件会导致文件创建时的全部内容永久丢失（无后续 change 事件）
        console.log(`[JsonlWatcher] Pre-registered file now created: ${filePath}`)
      }
      // 无论新注册还是已预注册，统一调用读取（readNewContent 内部会检查 offset）
      this.readNewContent(filePath)
    })

    this.watcher.on('addDir', (dirPath: string) => {
      // 只处理 subagents/ 目录被创建的事件
      // dirPath 示例：/home/.../.claude/projects/-proj/<session-uuid>/subagents
      const normalizedDir = dirPath.replace(/\\/g, '/')
      if (!normalizedDir.endsWith('/subagents')) return

      console.log(`[JsonlWatcher] subagents/ dir created: ${dirPath}`)

      // 找到对应父 session 的 PTY ID：
      // 父 session JSONL 路径 = path.dirname(dirPath) + '.jsonl'
      // 即：<session-uuid-dir>.jsonl
      const sessionUuidDir = path.dirname(dirPath)
      const expectedJSONLPath = sessionUuidDir + '.jsonl'

      let parentPtyId: string | undefined
      for (const wf of this.watchedFiles.values()) {
        if (!wf.agentId && wf.filePath === expectedJSONLPath) {
          parentPtyId = wf.sessionId
          break
        }
      }

      // fallback：按 session UUID 名称模糊匹配（避免路径大小写差异）
      if (!parentPtyId) {
        const sessionUuid = path.basename(sessionUuidDir)
        for (const wf of this.watchedFiles.values()) {
          if (!wf.agentId && wf.filePath.includes(sessionUuid)) {
            parentPtyId = wf.sessionId
            break
          }
        }
      }

      if (parentPtyId) {
        this.scanSubagentsDir(dirPath, parentPtyId)
      } else {
        console.warn(`[JsonlWatcher] addDir: Cannot find parent PTY ID for ${dirPath}`)
      }
    })

    this.watcher.on('error', (err) => {
      console.error('[JsonlWatcher] Watcher error:', err)
    })
  }

  private handleFileChange(filePath: string): void {
    if (!this.watchedFiles.has(filePath)) {
      // 通过 watchProject 方式监听到的文件（未明确注册）
      // 先尝试 subagent 路径
      const subagentInfo = extractSubagentInfo(filePath)
      if (subagentInfo) {
        let parentPtyId: string | undefined
        for (const [fp, wf] of this.watchedFiles) {
          if (fp.includes(subagentInfo.sessionUuid)) {
            parentPtyId = wf.sessionId
            break
          }
        }
        const sessionId = parentPtyId ?? subagentInfo.sessionUuid
        const consumers = this.findSessionConsumers(subagentInfo.sessionUuid)
        this.watchedFiles.set(filePath, {
          filePath,
          sessionId,
          agentId: subagentInfo.agentId,
          readOffset: 0,
          consumers,
        })
      } else {
        const sessionId = extractSessionIdFromPath(filePath)
        if (sessionId) {
          this.watchedFiles.set(filePath, {
            filePath,
            sessionId,
            readOffset: 0,
            consumers: new Set([this.consumerKey(sessionId, 'project-discovery')]),
          })
        }
      }
    }
    this.readNewContent(filePath)
  }

  /**
   * 扫描已有的 subagents/ 目录，注册所有 agent-*.jsonl 文件并全量读取
   * 场景：重新打开历史 session 时，subagent 文件已存在但不会触发 add 事件
   */
  private scanSubagentsDir(subagentsDir: string, parentSessionId: string): void {
    try {
      if (!fs.existsSync(subagentsDir)) return
      const files = fs.readdirSync(subagentsDir)
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const filePath = path.join(subagentsDir, f)
        if (this.watchedFiles.has(filePath)) continue

        const subagentInfo = extractSubagentInfo(filePath)
        if (!subagentInfo) continue

        this.watchedFiles.set(filePath, {
          filePath,
          sessionId: parentSessionId,
          agentId: subagentInfo.agentId,
          readOffset: 0,
          consumers: this.findSessionConsumers(parentSessionId),
        })
        this.watcher?.add(filePath)
        console.log(`[JsonlWatcher] Existing subagent file found: ${filePath} (agentId: ${subagentInfo.agentId})`)
        // 全量读取历史记录
        this.readNewContent(filePath)
      }
    } catch (err) {
      console.warn(`[JsonlWatcher] scanSubagentsDir error for ${subagentsDir}:`, err)
    }
  }

  /** Tail 增量读取：只读 readOffset 之后的新内容 */
  private readNewContent(filePath: string): void {
    const watched = this.watchedFiles.get(filePath)
    if (!watched) return

    try {
      const stat = fs.statSync(filePath)
      if (stat.size <= watched.readOffset) return

      // 只读新增 bytes
      const stream = fs.createReadStream(filePath, {
        start: watched.readOffset,
        end: stat.size - 1,
        encoding: 'utf-8'
      })
      const activeStreams = this.activeStreamsByFile.get(filePath) ?? new Set<fs.ReadStream>()
      activeStreams.add(stream)
      this.activeStreamsByFile.set(filePath, activeStreams)

      let buffer = ''

      stream.on('data', (chunk) => {
        buffer += chunk as string
      })

      stream.on('end', () => {
        if (this.watchedFiles.get(filePath) !== watched) return
        watched.readOffset = stat.size

        // 按行分割。先扫描整个新增批次的 Branch 元信息，再逐行解析：
        // 旧版 Branch 可能包含父会话前缀并依赖 file-history-snapshot，必须优先沿用 snapshot；
        // Claude Code 2.1.197 的 Branch JSONL 不再写 snapshot：继承的父历史记录带 forkedFrom，
        // 随后的 Branch 本地记录不带 forkedFrom，此时第一条本地 user 才是 Branch 起点。
        const lines = buffer.split('\n')
        const rawLines = lines.map((line) => {
          if (!line.trim()) return { line, raw: null as Record<string, unknown> | null }
          try {
            return { line, raw: JSON.parse(line) as Record<string, unknown> }
          } catch {
            return { line, raw: null as Record<string, unknown> | null }
          }
        })
        if (rawLines.some(({ raw }) => raw?.['type'] === 'file-history-snapshot')) {
          watched.hasHistorySnapshot = true
        }
        if (rawLines.some(({ raw }) => {
          const forkedFrom = raw?.['forkedFrom']
          return typeof forkedFrom === 'object'
            && forkedFrom !== null
            && typeof (forkedFrom as Record<string, unknown>)['sessionId'] === 'string'
        })) {
          watched.isBranchTranscript = true
        }

        for (const { line, raw } of rawLines) {
          if (!line.trim()) continue

          // 追踪 file-history-snapshot：下一条可解析的普通 user 记录标记为 isBranchStart。
          // attachment/system 等不可见元数据行不能提前消费 pending 标记。
          if (raw?.['type'] === 'file-history-snapshot') {
            watched.prevWasHistorySnapshot = true
          }

          const record = parseJsonlLine(line)
          if (record) {
            record.sessionId = watched.sessionId
            // 若为 subagent 文件，确保 agentId 字段已填充
            if (watched.agentId && !record.agentId) {
              record.agentId = watched.agentId
              record.isSidechain = true
            }
            // 旧版：snapshot 后第一条 user；新版无 snapshot：跳过带 forkedFrom 的继承前缀，
            // 将第一条不带 forkedFrom 的 Branch 本地 user 标为起点。
            const isSnapshotStart = watched.prevWasHistorySnapshot === true && record.type === 'user'
            const forkedFrom = raw?.['forkedFrom']
            const rawIsInheritedForkRecord = typeof forkedFrom === 'object'
              && forkedFrom !== null
              && typeof (forkedFrom as Record<string, unknown>)['sessionId'] === 'string'
            const isForkedFromFallbackStart = !watched.hasHistorySnapshot
              && watched.isBranchTranscript
              && !watched.branchStartMarked
              && !rawIsInheritedForkRecord
              && record.type === 'user'
            if (isSnapshotStart || isForkedFromFallbackStart) {
              record.isBranchStart = true
              watched.branchStartMarked = true
              watched.prevWasHistorySnapshot = false
              console.log(
                `[JsonlWatcher] Branch start marked session=${watched.sessionId} strategy=${isSnapshotStart ? 'snapshot' : 'forkedFrom-boundary-user'} uuid=${record.uuid ?? 'none'}`,
              )
            }
            // raw 只服务于本次主进程分支边界判断；跨 IPC 前立即断开大对象引用。
            delete record.raw
            if (this.watchedFiles.get(filePath) !== watched) return
            this.callbacks.onRecord(record, watched.sessionId, filePath, watched.agentId)
          }
        }
      })

      stream.on('close', () => {
        const current = this.activeStreamsByFile.get(filePath)
        current?.delete(stream)
        if (current?.size === 0) this.activeStreamsByFile.delete(filePath)
      })

      stream.on('error', (err) => {
        console.error(`[JsonlWatcher] Read error for ${filePath}:`, err)
        this.callbacks.onError(err, filePath)
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[JsonlWatcher] stat error for ${filePath}:`, err)
      }
    }
  }

  private getFileSize(filePath: string): number {
    try {
      return fs.statSync(filePath).size
    } catch {
      return 0
    }
  }

  private consumerKey(sessionId: string, consumerId: string): string {
    return `${sessionId}::${consumerId}`
  }

  private normalizeDirectory(dirPath: string): string {
    const resolved = path.resolve(dirPath)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  private addDirectoryLease(dirPath: string, owner: string): void {
    const key = this.normalizeDirectory(dirPath)
    const existing = this.watchedDirectories.get(key)
    if (existing) {
      existing.owners.add(owner)
      return
    }
    this.watchedDirectories.set(key, { path: dirPath, owners: new Set([owner]) })
    this.watcher?.add(dirPath)
  }

  private releaseDirectoryOwner(owner: string): void {
    for (const [key, directory] of this.watchedDirectories) {
      if (!directory.owners.delete(owner) || directory.owners.size > 0) continue
      this.watchedDirectories.delete(key)
      void this.watcher?.unwatch(directory.path)
    }
  }

  private releaseDirectoryOwnersForSession(sessionId: string): void {
    const prefix = `${sessionId}::`
    for (const directory of this.watchedDirectories.values()) {
      for (const owner of [...directory.owners]) {
        if (owner.startsWith(prefix)) directory.owners.delete(owner)
      }
    }
    for (const [key, directory] of [...this.watchedDirectories]) {
      if (directory.owners.size > 0) continue
      this.watchedDirectories.delete(key)
      void this.watcher?.unwatch(directory.path)
    }
  }

  private findSessionConsumers(sessionIdOrUuid: string): Set<string> {
    const consumers = new Set<string>()
    for (const watched of this.watchedFiles.values()) {
      if (watched.sessionId === sessionIdOrUuid || watched.filePath.includes(sessionIdOrUuid)) {
        watched.consumers.forEach((consumer) => consumers.add(consumer))
      }
    }
    if (consumers.size === 0) consumers.add(this.consumerKey(sessionIdOrUuid, 'project-discovery'))
    return consumers
  }

  private disposeWatchedFile(filePath: string): void {
    this.watchedFiles.delete(filePath)
    for (const stream of this.activeStreamsByFile.get(filePath) ?? []) stream.destroy()
    this.activeStreamsByFile.delete(filePath)
    void this.watcher?.unwatch(filePath)
  }

  private migrateSessionConsumers(previousSessionId: string, nextSessionId: string): void {
    const previousPrefix = `${previousSessionId}::`
    const nextPrefix = `${nextSessionId}::`
    for (const watched of this.watchedFiles.values()) {
      if (watched.sessionId === previousSessionId) watched.sessionId = nextSessionId
      for (const owner of [...watched.consumers]) {
        if (!owner.startsWith(previousPrefix)) continue
        watched.consumers.delete(owner)
        watched.consumers.add(`${nextPrefix}${owner.slice(previousPrefix.length)}`)
      }
    }
    for (const directory of this.watchedDirectories.values()) {
      for (const owner of [...directory.owners]) {
        if (!owner.startsWith(previousPrefix)) continue
        directory.owners.delete(owner)
        directory.owners.add(`${nextPrefix}${owner.slice(previousPrefix.length)}`)
      }
    }
    console.info(
      `[JsonlWatcher] Lease session migrated ${previousSessionId.slice(0, 8)} -> ${nextSessionId.slice(0, 8)}`,
    )
  }
}
