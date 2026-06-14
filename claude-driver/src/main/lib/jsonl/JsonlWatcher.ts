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
  /** 上一行是否为 file-history-snapshot（用于标记下一条 user 记录为 isBranchStart） */
  prevWasHistorySnapshot?: boolean
}

export class JsonlWatcher {
  private watcher: FSWatcher | null = null
  private watchedFiles = new Map<string, WatchedFile>()
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
  watchFile(filePath: string, sessionId: string, readFromStart = false, agentId?: string): void {
    const alreadyWatched = this.watchedFiles.has(filePath)

    if (!alreadyWatched) {
      const initialOffset = readFromStart ? 0 : this.getFileSize(filePath)
      this.watchedFiles.set(filePath, { filePath, sessionId, agentId, readOffset: initialOffset })

      if (readFromStart) {
        // 历史模式：立即全量读取
        this.readNewContent(filePath)
      }

      this.ensureWatcher()
      this.watcher?.add(filePath)
      console.log(`[JsonlWatcher] Watching ${filePath} (offset: ${initialOffset})`)
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
      this.watcher?.add(projectDir)     // 可靠地监听整个项目目录（必然存在）
      this.watcher?.add(sessionUuidDir) // 也尝试监听（若已存在则立即生效）

      // 扫描已有 subagent 文件（历史 session 或当前 session 已运行过 subagent）
      const subagentsDir = path.join(sessionUuidDir, 'subagents')
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
    this.watchedFiles.delete(filePath)
    this.watcher?.unwatch(filePath)
  }

  /** 停止所有监听 */
  close(): void {
    this.watcher?.close()
    this.watcher = null
    this.watchedFiles.clear()
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
          this.watchedFiles.set(filePath, {
            filePath,
            sessionId,
            agentId: subagentInfo.agentId,
            readOffset: 0,
          })
          console.log(`[JsonlWatcher] Subagent JSONL detected: ${filePath} (agentId: ${subagentInfo.agentId}, parentSession: ${sessionId})`)
        } else {
          // 普通主 session 文件
          const sessionId = extractSessionIdFromPath(filePath)
          if (sessionId) {
            this.watchedFiles.set(filePath, { filePath, sessionId, readOffset: 0 })
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
        this.watchedFiles.set(filePath, {
          filePath,
          sessionId,
          agentId: subagentInfo.agentId,
          readOffset: 0,
        })
      } else {
        const sessionId = extractSessionIdFromPath(filePath)
        if (sessionId) {
          this.watchedFiles.set(filePath, { filePath, sessionId, readOffset: 0 })
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
    // 无论目录是否存在，都用 chokidar 监听（目录出现时自动生效）
    this.watcher?.add(subagentsDir)

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

      let buffer = ''

      stream.on('data', (chunk) => {
        buffer += chunk as string
      })

      stream.on('end', () => {
        watched.readOffset = stat.size

        // 按行分割，逐行解析
        const lines = buffer.split('\n')
        for (const line of lines) {
          if (!line.trim()) continue

          // 追踪 file-history-snapshot：下一条 user 记录标记为 isBranchStart
          const prevSnapshot = watched.prevWasHistorySnapshot ?? false
          watched.prevWasHistorySnapshot = false
          try {
            const raw = JSON.parse(line) as Record<string, unknown>
            if (raw['type'] === 'file-history-snapshot') {
              watched.prevWasHistorySnapshot = true
            }
          } catch { /* ignore */ }

          const record = parseJsonlLine(line)
          if (record) {
            record.sessionId = watched.sessionId
            // 若为 subagent 文件，确保 agentId 字段已填充
            if (watched.agentId && !record.agentId) {
              record.agentId = watched.agentId
              record.isSidechain = true
            }
            // 上一行是 file-history-snapshot 且当前是 user → 这是 /branch 后第一条消息
            if (prevSnapshot && record.type === 'user') {
              record.isBranchStart = true
            }
            this.callbacks.onRecord(record, watched.sessionId, filePath, watched.agentId)
          }
        }
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
}
