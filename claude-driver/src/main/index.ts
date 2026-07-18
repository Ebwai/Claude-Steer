// 使用方法：由 electron-vite 构建后由 Electron 自动加载
// 编译说明：主进程 Node.js ESM，不可在渲染进程中引用
// 代码说明：Electron 主进程入口——窗口创建、Hook Server 启动、IPC Handler 注册

import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC } from '../shared/events/ipc-channels'
import { HOOK_PORT } from '../shared/constants/index'
import { startHookServer } from './lib/hook-server/HookServer'
import { createHookEventBus } from './lib/hook-server/HookEventBus'
import {
  injectHookConfig,
  setupHookBridge,
  readAllConfigGroups,
  readAgentsFromDir,
  readClaudeSettings,
  writeClaudeSettings,
  readProjectSkills,
  readClaudeEnvBlock,
  writeClaudeEnvBlock,
  removeClaudeEnvBlock,
} from './lib/config/SettingsManager'
import { setupStatusLineBridge } from './lib/statusline/StatusLineBridge'
import {
  readProjects,
  upsertProject,
  updateProjectClaims,
  setInitCompleted,
  getLastRootDir,
} from './lib/projects/ProjectStore'
import { scanForProjects } from './lib/projects/ProjectScanner'
import { PtyManager } from './lib/pty/PtyManager'
import { JsonlWatcher } from './lib/jsonl/JsonlWatcher'
import { GitManager } from './lib/git/GitManager'
import { checkAllDependencies, autoInstallClaude } from './lib/deps/DependencyChecker'
import { NotificationService } from './lib/notification/NotificationService'
import {
  readDriverConfig,
  writeDriverConfig,
  patchDriverConfig,
} from './lib/config/DriverConfigStore'
import {
  readGlobalMcpServers,
  readProjectMcpJsonServers,
  readProjectMcpState,
  patchProjectMcpState,
  ensureProjectTrusted,
  ensureOnboardingCompleted,
} from './lib/config/ClaudeJsonManager'
import {
  readSchedulerSessions,
  appendTaskToSession,
  deleteTask as deleteSchedulerTask,
  updateClaudeId as updateSchedulerClaudeId,
  type SchedulerSessionEntry,
} from './lib/scheduler/SchedulerStore'
import type { ClaimStatus, PermissionMode, Project, GitMark } from '../shared/types/index'
import { RemoteBridgeService } from './services/RemoteBridgeService'
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } from './lib/updater/index'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

// ── 文件日志系统（永久化到磁盘，便于诊断问题）──────────────────────────────
const LOG_DIR = path.join(os.homedir(), '.claude-steer', 'logs')
const LOG_SESSION_TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const LOG_SESSION_FILE = path.join(LOG_DIR, `session-${LOG_SESSION_TS}.log`)
const LOG_LATEST_FILE  = path.join(LOG_DIR, 'latest.log')

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

function appendToLogFile(level: string, message: string): void {
  try {
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level}] ${message}\n`
    fs.appendFileSync(LOG_SESSION_FILE, line, 'utf-8')
    fs.appendFileSync(LOG_LATEST_FILE,  line, 'utf-8')
  } catch { /* 静默失败 */ }
}

// 持有主窗口引用（EventBus 延迟获取，避免时序问题）
let mainWindow: BrowserWindow | null = null

// ── 独立终端窗口映射（sessionId → BrowserWindow）──────────────────────────
// 每个 PTY session 最多对应一个独立终端窗口
const termWindows = new Map<string, BrowserWindow>()

// ── PtyManager 全局实例（跨 session 共享）──────────────────────────────────
const ptyManager = new PtyManager()

// ── trust folder 对话框自动确认 ──────────────────────────────────────────────
// 裸启 claude 进入未信任目录时，Claude TUI 会弹 "Do you trust the files in this folder?"
// 选择框（默认光标聚焦 Yes）。insight/chat 等自动流程无人工干预会被卡住，故在 onData
// 中统一检测文本并发送回车确认 Yes。配合启动前的 ensureProjectTrusted() 双保险。
//
// 关键词尽量宽泛：Claude Code 不同版本/语言下对话框文案可能变化，只要命中任一关键词
// 即判定为 trust 对话框。trustHandledPtyIds 保证每个 session 只处理一次，
// 误命中代价仅为多发一个回车（trust 对话框总是启动时最先出现，时序上不会被后续输出抢占）。
const TRUST_DIALOG_RE = /trust the files|trust these files|trust this folder|trust this directory|trust this project|do you trust|i trust this|trust folder/i

const trustHandledPtyIds = new Set<string>()

/** 检测 trust folder 对话框并自动回车确认 Yes；返回是否处理了本次对话框 */
function handleTrustFolderPrompt(sessionId: string, data: string): boolean {
  if (trustHandledPtyIds.has(sessionId)) return false
  const plain = stripAnsi(data)
  if (TRUST_DIALOG_RE.test(plain)) {
    trustHandledPtyIds.add(sessionId)
    console.log(`[trust] dialog detected in session ${sessionId}, sending Enter to confirm Yes`)
    ptyManager.rawWrite(sessionId, '\r')
    return true
  }
  return false
}

// ── insight 临时 PTY 守卫集合 ─────────────────────────────────────────────────
// insight PTY 的 sessionId 均以 "insight-" 开头；onHookEvent 中用此 Set 快速跳过
const insightPtyIds = new Set<string>()

// ── chat 临时 PTY 守卫集合 ────────────────────────────────────────────────────
// chat PTY 的 sessionId 均以 "chat-" 开头；onHookEvent 中用此 Set 快速跳过
const chatPtyIds = new Set<string>()

// ── scheduler loop PTY 守卫集合 ───────────────────────────────────────────────
// schedulerPtyIds:    scheduler PTY 的内部 sessionId（"scheduler-<uuid>"），用于 PTY 生命周期管理
// schedulerClaudeIds: scheduler 会话绑定的 Claude session_id，onHookEvent 按此过滤
//   不能用 findSessionByCwd 过滤，因为 scheduler PTY 可能与正常项目 PTY 在同一目录
const schedulerPtyIds    = new Set<string>()
const schedulerClaudeIds = new Set<string>()
// projectPath → ptyId（运行时状态，重启后失效）
const schedulerPtyByProject = new Map<string, string>()

// ── /branch 检测辅助 ──────────────────────────────────────────────────────────
// 快速检测链路（Ctrl+C 强制退出策略）：
//   1. SESSION_INPUT 检测到 "/branch" → 3s 后连发 2×Ctrl+C 打断 branch session
//   2. branch session 被中断 → SessionEnd hook 携带 branch 的 Claude Code session_id
//   3. 收到 SessionEnd 后立即写入 "claude -r {id}" 恢复 branch 对话
//   4. 发送 SESSION_BRANCH_LINK 给渲染进程注册 branch 框
const pendingBranchByPtySession = new Map<string, number>()  // parentPtyId → timestamp
const confirmedBranchPtyIds = new Set<string>()  // 已确认 branch 的 ptyId，30s 内阻止 stdout 重复触发

// ── PTY ↔ Claude Code session 双向绑定表（主进程权威数据）───────────────────
// ptyToClaudeMap: ptyId → claudeId（用于解绑时反查）
// claudeToPtyMap: claudeId → ptyId（用于 SESSION_INPUT 路由）
const ptyToClaudeMap = new Map<string, string>()
const claudeToPtyMap = new Map<string, string>()

/** 绑定 PTY ↔ Claude Code session，并通知 renderer */
function bindPtyToClaudeSession(ptyId: string, claudeId: string, transcriptPath: string, cwd: string): void {
  // 若该 ptyId 已有旧绑定，先解绑旧的
  const oldClaudeId = ptyToClaudeMap.get(ptyId)
  if (oldClaudeId && oldClaudeId !== claudeId) {
    claudeToPtyMap.delete(oldClaudeId)
    console.log(`[PtyBind] Re-bind: PTY ${ptyId} was bound to ${oldClaudeId}, now rebinding to ${claudeId}`)
  }
  ptyToClaudeMap.set(ptyId, claudeId)
  claudeToPtyMap.set(claudeId, ptyId)
  mainWindow?.webContents.send(IPC.PTY_BIND, { ptyId, claudeId, transcriptPath, cwd })
  console.log(`[PtyBind] Bound PTY ${ptyId} ↔ Claude ${claudeId}`)
}

/** 解绑 PTY ↔ Claude Code session（若无绑定则忽略），并通知 renderer */
function unbindPtyFromClaudeSession(claudeId: string): void {
  const ptyId = claudeToPtyMap.get(claudeId)
  if (!ptyId) {
    console.debug(`[PtyBind] Unbind ignored: no binding for Claude ${claudeId}`)
    return
  }
  ptyToClaudeMap.delete(ptyId)
  claudeToPtyMap.delete(claudeId)
  mainWindow?.webContents.send(IPC.PTY_UNBIND, { ptyId, claudeId })
  console.log(`[PtyBind] Unbound PTY ${ptyId} ↔ Claude ${claudeId}`)
}

/** 过滤 ANSI 转义码，返回纯文本 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;?]*[mGKHFABCDJsulh]|\x1b[()][AB012]|\r/g, '')
}

// ── JsonlWatcher 全局实例（跨 session 共享，多文件监听复用单个 watcher）───
let jsonlWatcher: JsonlWatcher | null = null

function getJsonlWatcher(): JsonlWatcher {
  if (!jsonlWatcher) {
    jsonlWatcher = new JsonlWatcher({
      onRecord: (record, sessionId, _filePath, agentId) => {
        if (agentId) {
          // subagent 记录：推送到专用通道，渲染进程按 agentId 路由到子时间线
          console.log(`[JsonlWatcher→IPC] SUBAGENT sessionId=${sessionId} agentId=${agentId} type=${record.type}`)
          mainWindow?.webContents.send(IPC.JSONL_SUBAGENT_RECORD, { sessionId, agentId, record })
        } else {
          // 主 session 记录
          mainWindow?.webContents.send(IPC.JSONL_RECORD, { sessionId, record })
        }
      },
      onError: (err, filePath) => {
        console.error(`[JsonlWatcher] Error on ${filePath}:`, err)
      },
    })
  }
  return jsonlWatcher
}

/**
 * 仿 agent-flow 的主动 transcript 探测——不依赖 hooks 或 statusLine
 * 逻辑：监控 ~/.claude/projects/<hash>/ 目录，当发现 mtime >= startTime 的 .jsonl 文件时
 * 自动用 JsonlWatcher 关联到 sessionId，推送记录到渲染进程
 *
 * 路径编码规则（来自 Claude Code 源码）：/home/tony/Skills_Test → -home-tony-Skills-Test（所有非字母数字字符替换为 -，包括下划线）
 */
function autoWatchTranscript(sessionId: string, projectPath: string, startTime: number, isPtyId = true, parentPtyId?: string, expectedClaudeId?: string): void {
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-')
  const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', encoded)

  // ── 诊断日志：打印路径编码结果和目录存在性，定位 Windows 路径编码不匹配问题 ──
  console.log(`[autoWatch] sessionId=${sessionId} projectPath=${projectPath}`)
  console.log(`[autoWatch] encoded=${encoded}`)
  console.log(`[autoWatch] claudeProjectDir=${claudeProjectDir} exists=${fs.existsSync(claudeProjectDir)}`)
  // 列出 .claude/projects/ 下所有实际目录（帮助对比编码是否一致）
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  try {
    if (fs.existsSync(projectsRoot)) {
      const actualDirs = fs.readdirSync(projectsRoot).filter(f => {
        try { return fs.statSync(path.join(projectsRoot, f)).isDirectory() } catch { return false }
      })
      console.log(`[autoWatch] .claude/projects/ actual dirs (${actualDirs.length}): ${actualDirs.join(' | ')}`)
      // 检查是否有与 encoded 相近但不完全匹配的目录（可能的编码差异）
      const closeMatch = actualDirs.find(d => d !== encoded && d.includes(encoded.slice(0, 10)))
      if (closeMatch) {
        console.log(`[autoWatch] ⚠ CLOSE MATCH found: "${closeMatch}" vs expected "${encoded}"`)
      }

      // ── 关键诊断：按修改时间排序，找出最近 30 秒内修改的目录（可能是 Claude Code 刚创建的）──
      const now = Date.now()
      const recentDirs = actualDirs
        .map(d => {
          try {
            const stat = fs.statSync(path.join(projectsRoot, d))
            return { name: d, mtime: stat.mtimeMs, age: now - stat.mtimeMs }
          } catch { return null }
        })
        .filter(d => d && d.age < 30_000) // 30秒内修改
        .sort((a, b) => (b?.mtime ?? 0) - (a?.mtime ?? 0))
        .slice(0, 5)

      if (recentDirs.length > 0) {
        console.log(`[autoWatch] 🔍 Recently modified dirs (within 30s):`)
        recentDirs.forEach(d => {
          console.log(`  - ${d!.name} (mtime: ${new Date(d!.mtime).toISOString()}, age: ${Math.round(d!.age / 1000)}s)`)
        })
      }
    } else {
      console.log(`[autoWatch] .claude/projects/ does NOT exist at: ${projectsRoot}`)
    }
  } catch (err) {
    console.error(`[autoWatch] failed to list .claude/projects/:`, err)
  }

  let done = false
  let dirWatcher: fs.FSWatcher | null = null
  // 超时清理（10 分钟）
  const cleanup = setTimeout(() => {
    done = true
    try { dirWatcher?.close() } catch {}
  }, 10 * 60 * 1000)

  const tryRegister = (filePath: string): boolean => {
    try {
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs >= startTime - 1000) { // 1s 容差（session 启动与第一条写入的时间差）
        const claudeUuid = path.basename(filePath, '.jsonl')
        const isUuidLike = /^[0-9a-f-]{36}$/.test(claudeUuid)
        const existingClaudeId = ptyToClaudeMap.get(sessionId)

        // resume 时若传入 expectedClaudeId，跳过不匹配的 JSONL 文件（避免误绑 branch JSONL）
        if (expectedClaudeId && isUuidLike && claudeUuid !== expectedClaudeId) {
          console.log(`[autoWatch] Skipping ${claudeUuid} (expected ${expectedClaudeId})`)
          return false
        }

        // 若该 claudeId 已被另一个 PTY 绑定（不是本 sessionId），跳过继续扫描其他文件
        // 场景：并行 agent 启动时扫描到 branch 的旧 JSONL（mtime 满足但属于别的 session）
        if (isUuidLike && isPtyId) {
          const existingPtyForClaude = claudeToPtyMap.get(claudeUuid)
          if (existingPtyForClaude && existingPtyForClaude !== sessionId) {
            console.log(`[autoWatch] Skipping ${claudeUuid}: already bound to PTY ${existingPtyForClaude}, not ${sessionId}`)
            return false
          }
        }

        // 非 UUID 文件名（如 xxx.insertions.jsonl）不是真正的 transcript，跳过继续扫描
        if (!isUuidLike) {
          console.log(`[autoWatch] Skipping non-UUID file: ${path.basename(filePath)}`)
          return false
        }

        // 确认可以绑定，标记完成并清理 watcher
        done = true
        clearTimeout(cleanup)
        try { dirWatcher?.close() } catch {}

        const timeSinceStart = Date.now() - startTime
        console.log(`[autoWatch] Transcript found for PTY=${sessionId} at T+${timeSinceStart}ms: ${filePath}`)
        console.log(`[autoWatch] Extracted claudeId=${claudeUuid} isUuid=${isUuidLike} alreadyBound=${existingClaudeId ?? 'none'}`)

        // 确定实际用于 watchFile 和 JSONL_BRANCH_SNAPSHOT 的 claudeId
        // - 正常路径：sessionId 是 ptyId，新 claudeId = claudeUuid
        // - branch 路径：sessionId 是旧 branch claudeId，新 claudeId = claudeUuid（不是旧 sessionId！）
        //   若用 sessionId（旧 claudeId），JsonlWatcher 会把记录路由到父 session 的 ProcessTimeline
        let effectiveClaudeId: string = sessionId

        if (isUuidLike && isPtyId && !existingClaudeId) {
          // 正常路径：sessionId 本身是 ptyId，直接绑定
          bindPtyToClaudeSession(sessionId, claudeUuid, filePath, projectPath)
          effectiveClaudeId = claudeUuid
          console.log(`[autoWatch] Early PTY_BIND: PTY=${sessionId} ↔ Claude=${claudeUuid}`)
        } else if (isUuidLike && !isPtyId && parentPtyId) {
          // branch 路径：sessionId 是旧 branch claudeId（非 ptyId），用 parentPtyId 绑定新 claudeId
          // claude -r 不触发 SessionStart hook，此处是唯一能建立绑定的时机
          const existingForParent = ptyToClaudeMap.get(parentPtyId)
          console.log(`[autoWatch] Branch PTY_BIND: parentPTY=${parentPtyId} existingClaudeId=${existingForParent ?? 'none'} → new claudeId=${claudeUuid}`)
          bindPtyToClaudeSession(parentPtyId, claudeUuid, filePath, projectPath)
          effectiveClaudeId = claudeUuid  // 必须用新 claudeId，不能用旧 branch sessionId
        }

        // 扫描 JSONL 最后 30 行，找 file-history-snapshot（branch 起始点）
        // 找到后立即通知 renderer，在历史批量记录推送前设好过滤点
        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          const lines = content.split('\n').filter((l) => l.trim())
          const tailLines = lines.slice(-30)
          for (let i = tailLines.length - 1; i >= 0; i--) {
            const obj = JSON.parse(tailLines[i]) as Record<string, unknown>
            if (obj['type'] === 'file-history-snapshot') {
              const branchStartUuid = obj['messageId'] as string | undefined
              if (branchStartUuid) {
                // 用 effectiveClaudeId（新 claudeId），与 branchRegistry 的 key 对应
                mainWindow?.webContents.send(IPC.JSONL_BRANCH_SNAPSHOT, { sessionId: effectiveClaudeId, branchStartUuid })
                console.log(`[autoWatch] Branch snapshot for ${effectiveClaudeId}: ${branchStartUuid}`)
              }
              break
            }
          }
        } catch { /* ignore read/parse errors */ }

        // 关键：用 effectiveClaudeId 注册 watchFile，确保记录路由到正确 ProcessTimeline
        getJsonlWatcher().watchFile(filePath, effectiveClaudeId, true) // readFromStart=true 全量读取
        return true
      }
    } catch { /* file may not exist */ }
    return false
  }

  const startWatch = (attempts: number) => {
    if (done) return

    if (!fs.existsSync(claudeProjectDir)) {
      if (attempts < 30) {
        if (attempts === 0 || attempts % 5 === 4) {
          console.log(`[autoWatch] dir not found, retrying (${attempts + 1}/30): ${claudeProjectDir}`)
        }
        setTimeout(() => startWatch(attempts + 1), 1000)
      } else {
        console.log(`[autoWatch] ⚠ GAVE UP after 30 retries, dir never appeared: ${claudeProjectDir}`)
      }
      return
    }
    console.log(`[autoWatch] dir found at attempt ${attempts}: ${claudeProjectDir}`)

    // 先检查现有文件（session 恢复或 statusLine 已触发的情况）
    try {
      for (const f of fs.readdirSync(claudeProjectDir)) {
        if (!f.endsWith('.jsonl')) continue
        if (tryRegister(path.join(claudeProjectDir, f))) return
      }
    } catch { /* readdir failed */ }

    // 没有现有文件符合条件——监听目录等待新文件出现
    try {
      dirWatcher = fs.watch(claudeProjectDir, (_event, filename) => {
        if (done || !filename?.endsWith('.jsonl')) return
        tryRegister(path.join(claudeProjectDir, filename))
      })
    } catch (err) {
      console.error(`[autoWatch] Failed to watch ${claudeProjectDir}:`, err)
    }
  }

  startWatch(0)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
 const showTimeout = setTimeout(() => {
  // 如果窗口还在、没被销毁
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 打印警告：GPU初始化失败，强制显示窗口
    console.warn('[createWindow] ready-to-show timeout (5s), forcing show (GPU init likely failed)')
    mainWindow.show() // 强制显示
  }
}, 5000)

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
    clearTimeout(showTimeout)
    NotificationService.init(() => mainWindow)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // ── 窗口状态诊断日志 ──────────────────────────────────────────────────────
  const logWinState = (tag: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const bounds = mainWindow.getBounds()
    const size = mainWindow.getSize()
    const contentSize = mainWindow.getContentSize()
    console.log(`[WinState:${tag}] isFullScreen=${mainWindow.isFullScreen()} isMaximized=${mainWindow.isMaximized()} isMinimized=${mainWindow.isMinimized()} isNormal=${mainWindow.isNormal()} bounds=${JSON.stringify(bounds)} size=${JSON.stringify(size)} contentSize=${JSON.stringify(contentSize)}`)
  }
  mainWindow.on('enter-full-screen', () => { console.log('[WinState:EVENT] enter-full-screen'); logWinState('enterFS') })
  mainWindow.on('leave-full-screen', () => { console.log('[WinState:EVENT] ★ leave-full-screen (TRIGGERED)'); logWinState('leaveFS'); console.trace('[WinState:TRACE] leave-full-screen call stack:') })
  mainWindow.on('maximize', () => { console.log('[WinState:EVENT] maximize'); logWinState('maximize') })
  mainWindow.on('unmaximize', () => { console.log('[WinState:EVENT] ★ unmaximize (TRIGGERED)'); logWinState('unmaximize'); console.trace('[WinState:TRACE] unmaximize call stack:') })
  mainWindow.on('resize', () => { logWinState('resize') })
  // 全局注册 logWinState 到 module 作用域，供 IPC handler 调用
  ;(globalThis as Record<string, unknown>).__logMainWinState = logWinState

  // 临时：打印所有渲染进程日志以诊断黑屏问题
  /*
  const RENDERER_LOG_PREFIXES = [
    '[BL-1]', '[BL-2]', '[BL-3]', '[BL-4]', '[BL-5]', '[BL-6]',
    '[Canvas]', '[RT]', '[LP]', '[Layout]',
    '[HistoryLoader]', '[timelineStore]', '[ProcessTimeline]',
    '[toolActivityHandler]', '[subagentHandler]', '[jsonlHandler]',
    '[AssistantActionBar]', '[PlanIndicator]',
    '[Notif]', '[Viewport]', '[SFN]',
    '[TokenCapability]',
  ]
  */
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    const tag = level === 2 ? 'WARN' : level === 3 ? 'ERROR' : 'LOG'
    process.stdout.write(`[Renderer:${tag}] ${message}\n`)
    appendToLogFile(`R_${tag}`, message)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── CLAUDE.md 内置模板 ────────────────────────────────────────────────────────

function renderClaudeMdTemplate(name: string, description: string, createdAt: string): string {
  return `# ${name}

## 项目简介
${description || '（暂无描述）'}

## 创建日期
${createdAt}

## 重要规范

制定或修改 Plan 时，必须严格遵循 @.claude/rules/plan-management.md 中的所有要求。
`
}

// ── Plan 管理规则模板 ─────────────────────────────────────────────────────────

function renderPlanManagementRules(): string {
  return `# Plan 管理规则

## 如何制定计划

1. **优先站在巨人肩膀上**：计划自己编写代码之前，先本地 + 联网调研，确认需要实现的功能是否已有现成实现；如有可直接复用的已实现部分，优先基于此实现，不重复造轮子
2. **充分考虑项目特殊性**：阅读相关文档，关注与通识认知不同的特殊地方（流程、机制、参数配置等）
3. **宏观架构先选型**：制定计划时，在架构设计和功能模块实现框架图上列出多个方案，分析解耦性、复用性、拓展性，**等待用户确认后**才写入 plan
4. 架构和代码设计必须考虑：**解耦性、复用性、拓展性**
5. **每个目标本质是检查点**：计划必须包含具体的测试通过考核内容与标准
6. **充分确认约束**：禁止瞎编假设值，必须向用户询问
7. **说明技术原理**：overall_plan 里说明架构选型理由，每个 T 文件说明所采用技术的特性、原理和选择理由

---

## 文件结构

\`\`\`
plan/
├── overall_plan.md              # 母目标 + 子目标 + 任务（含架构选型分析）
├── M1_<母目标名>/
│   ├── 使用指南.md              # M 目标完成时创建，记录运行使用方法
│   └── S1_<子目标名>/
│       └── T1_<任务名>.md       # 细分执行计划，直到原子目标级别
└── M2_<母目标名>/
    └── ...
\`\`\`

---

## 目标层级

\`\`\`
M 母目标（关键节点交付目标）
└── S 子目标（功能模块级）
    └── T 任务（实现步骤级）[每个T文件说明技术原理和选择理由]
        └── 原子目标（最小执行单元，细化到具体命令行/代码行级别）
\`\`\`

\`overall_plan.md\` 包含 M、S、T 三层（含架构选型理由）。
T 级别的 \`.md\` 文件包含更细分的任务，直到原子目标，还有「待优化项」章节记录性能瓶颈等。

---

## overall_plan.md 严格格式规范（必须遵守）

**警告：overall_plan.md 的格式会被全局监控界面和项目监控界面的 Plan 面板自动解析。格式不正确将导致无法识别！**

### 格式规则

每一层有固定的 markdown 写法，**必须严格遵守**，多一个空格或少一个符号都会导致解析失败：

| 层级 | 必须写成 | 示例 |
|------|---------|------|
| M（母目标） | \`## M<数字> — <标题> [状态]\` | \`## M1 — 项目脚手架与基础架构层 [ ]\` |
| S（子目标） | \`### S<数字> — <标题> [状态]\` | \`### S1 — electron-vite 项目初始化 [x]\` |
| T（任务）   | \`- [<状态字符>] T<数字> — <标题>\` | \`- [!] T1 — 初始化项目\` |

### 状态字符

| 状态 | M/S 行尾写法 | T 行写法 | 说明 |
|------|------------|---------|------|
| 待办 | \`[ ]\` | \`- [ ]\` | 空格，初始状态 |
| 已完成 | \`[x]\` | \`- [x]\` | 已完成并验证 |
| 进行中 | \`[!]\` | \`- [!]\` | 执行中遇到阻塞或正在做 |

### 关键约束

1. **连接符**：M/S/T 编号与标题之间必须用 \`—\`（或 \`–\`、\`-\`）连接
2. **层级顺序**：S 必须出现在某个 M 之后，T 必须出现在某个 S 之后（靠文档顺序隐式确定父子关系）
3. **M/S 状态括号必须在行尾**
4. **T 行必须以 \`- [ ]\`、\`- [x]\` 或 \`- [!]\` 开头**
5. 可以在 M/S/T 之间插入任意其他 markdown 内容（说明、表格等），不影响解析

### 案例模板

\`\`\`
## M1 — 项目脚手架与基础架构层 [ ]

### S1 — electron-vite 项目初始化 [x]

- [x] T1 — 初始化 electron-vite + React + TypeScript 项目
- [x] T2 — 配置 ESLint、Prettier、路径别名
- [x] T3 — 搭建基础目录结构（src/main, src/renderer, src/shared）

### S2 — IPC 通信层 [!]

- [x] T1 — 定义 IPC 通道常量与类型
- [!] T2 — 实现双向 invoke/handle 机制
- [ ] T3 — 添加事件推送（主进程 -> 渲染进程）

### S3 — 项目持久化存储 [ ]

- [ ] T1 — 设计 projects.json 数据结构
- [ ] T2 — 实现 ProjectStore 读写逻辑
- [ ] T3 — 实现项目扫描器

## M2 — 全局监控面板 [ ]

### S1 — 画布与节点渲染 [ ]

- [!] T1 — 使用 ReactFlow 搭建无限画布
- [ ] T2 — 实现 ProjectCardNode 组件
- [ ] T3 — 实现 UserNode 顶部节点

### S2 — 项目管理流程 [ ]

- [ ] T1 — 实现 InitSopModal 初始化向导
- [ ] T2 — 实现项目认领/忽略逻辑
- [ ] T3 — 实现项目创建向导
\`\`\`

**执行任何步骤后，立即更新对应条目状态，不得滞后。**

---

## 问题处理流程

当某原子目标/任务状态变为 \`[!\` 时：

1. **问题描述**：记录具体报错或异常现象
2. **可能原因列表**：穷举所有可能，按可能性从高到低排列
3. **排查过程**：在对应代码位置创建 \`test/\` 文件夹，从已验证可执行代码出发逐一排查；已排除标记 \`[✗]\`，确认是标记 \`[✓]\`
4. **解决后**：状态改为 \`[x]\`，补充解决方法说明，排查过程完整保留不覆盖
5. **穷尽仍未解决**：保持 \`[!]\` 状态，向用户说明已穷尽排查，询问处理方向

---

## 计划变更流程

发现已有计划存在错误时：

1. 列出所有错误点，**先询问用户确认**
2. 用户确认后更新计划正文
3. 废弃的原有内容移至 \`plan.md\` 末尾「废弃计划」章节，注明废弃原因

---

## 禁止事项

- **禁止瞎编参数**：若代码或 plan 中缺少关键参数，禁止使用假设值，必须向用户询问
`
}

// ── IPC Handler 注册 ─────────────────────────────────────────────────────────

function registerIpcHandlers(): void {

  // ── 项目管理 ────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.PROJECT_LIST, async () => {
    return readProjects()
  })

  ipcMain.handle(IPC.PROJECT_CREATE, async (
    _event,
    payload: { name: string; path: string; description?: string }
  ) => {
    try {
      const projectPath = payload.path
      const now = new Date()

      // 创建项目目录（若不存在）
      fs.mkdirSync(projectPath, { recursive: true })

      // 写入 CLAUDE.md
      const claudeMd = renderClaudeMdTemplate(
        payload.name,
        payload.description ?? '',
        now.toLocaleDateString('zh-CN')
      )
      fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), claudeMd, 'utf-8')

      // 写入 .claude/settings.json（设置 acceptEdits 权限）
      const claueDotDir = path.join(projectPath, '.claude')
      fs.mkdirSync(claueDotDir, { recursive: true })
      const projectSettings = { permissionMode: 'acceptEdits' }
      fs.writeFileSync(
        path.join(claueDotDir, 'settings.json'),
        JSON.stringify(projectSettings, null, 2),
        'utf-8'
      )

      // 写入 .claude/rules/plan-management.md（Plan 制定规则）
      const rulesDir = path.join(claueDotDir, 'rules')
      fs.mkdirSync(rulesDir, { recursive: true })
      fs.writeFileSync(
        path.join(rulesDir, 'plan-management.md'),
        renderPlanManagementRules(),
        'utf-8'
      )
      console.log(`[ipc] project:create → wrote .claude/rules/plan-management.md`)

      // 检测是否为 Git 仓库
      const isGitRepo = fs.existsSync(path.join(projectPath, '.git'))

      // 写入 projects.json
      const project: Project = {
        id: projectPath,
        name: payload.name,
        path: projectPath,
        claimStatus: 1,
        isGitRepo,
        activeSessionId: null,
        sessionIds: [],
        lastActiveAt: now.getTime(),
      }
      upsertProject(project)

      console.log(`[ipc] project:create OK → ${projectPath}`)
      return { ok: true, project }
    } catch (err) {
      console.error('[ipc] project:create failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.PROJECT_SCAN, async (_event, rootDir: string) => {
    try {
      return await scanForProjects(rootDir)
    } catch (err) {
      console.error('[ipc] project:scan failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.PROJECT_UPDATE, async (
    _event,
    payload: {
      updates: Array<{ projectId: string; claimStatus: ClaimStatus }>
      initCompleted?: boolean
      lastRootDir?: string
    }
  ) => {
    try {
      // 对于尚未在 store 中的项目（首次扫描结果），先用 upsertProject 创建骨架记录
      const existing = new Map(readProjects().map((p) => [p.id, p]))
      for (const { projectId, claimStatus } of payload.updates) {
        if (!existing.has(projectId)) {
          const newProject: Project = {
            id: projectId,
            name: path.basename(projectId),
            path: projectId,
            claimStatus,
            isGitRepo: fs.existsSync(path.join(projectId, '.git')),
            activeSessionId: null,
            sessionIds: [],
            lastActiveAt: Date.now(),
          }
          upsertProject(newProject)
        }
      }
      // 批量更新 claimStatus
      updateProjectClaims(payload.updates)
      // 可选：标记 init 完成
      if (payload.initCompleted) {
        setInitCompleted(payload.lastRootDir ?? null)
      }
      console.log(`[ipc] project:update OK (${payload.updates.length} items)`)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] project:update failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── 原生对话框 ───────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.DIALOG_OPEN_DIR, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择项目根目录',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ── PTY Session 管理 ────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SESSION_START, async (
    _event,
    payload: {
      sessionId?: string
      projectId: string
      projectPath: string
      permissionMode: PermissionMode
      model?: string
    }
  ) => {
    try {
      const logWinState = (globalThis as Record<string, unknown>).__logMainWinState as ((tag: string) => void) | undefined
      logWinState?.('SESSION_START_begin')
      const sessionId = payload.sessionId ?? randomUUID()
      const sessionStartTime = Date.now()
      // 自动信任目标目录，避免 Claude CLI 的信任对话框阻塞 PTY session
      ensureProjectTrusted(payload.projectPath)
      logWinState?.('SESSION_START_afterTrust')
      // 调试：记录启动参数和环境
      console.log(`[DEBUG:SESSION_START] projectId=${payload.projectId} projectPath=${payload.projectPath} permissionMode=${payload.permissionMode}`)
      console.log(`[DEBUG:SESSION_START] PATH=${process.env.PATH}`)
      console.log(`[DEBUG:SESSION_START] HOME=${process.env.HOME}`)
      ptyManager.startSession({
        sessionId,
        projectPath: payload.projectPath,
        permissionMode: payload.permissionMode,
        model: payload.model,
        onData: (sid, data) => {
          // 调试：捕获 PTY 原始输出
          console.log(`[DEBUG:PTY_RAW] session=${sid} data=${JSON.stringify(data.slice(0, 300))}`)
          mainWindow?.webContents.send(IPC.SESSION_STATUS, { sessionId: sid, data })
          termWindows.get(sid)?.webContents.send(IPC.TERM_DATA, data)
          // /branch 成功时 stdout 输出 "Branched─conversation"（─ = U+2500 制表线）
          const plain = stripAnsi(data)
          if (/Branched[\s\u2500\-]+conversation/i.test(plain) && !confirmedBranchPtyIds.has(sid)) {
            pendingBranchByPtySession.set(sid, Date.now())
            console.log(`[Branch] stdout detected /branch on PTY session ${sid}`)
          }
        },
        onExit: (sid, exitCode) => {
          console.log(`[PtyManager] Session ${sid} exited with code ${exitCode}`)
          console.log(`[DEBUG:PTY_EXIT] session=${sid} exitCode=${exitCode} time=${Date.now()}`)
          mainWindow?.webContents.send(IPC.SESSION_STATUS, {
            sessionId: sid,
            status: 'Completed',
          })
          termWindows.get(sid)?.webContents.send(IPC.TERM_DATA, '\r\n[进程已退出]\r\n')
          pendingBranchByPtySession.delete(sid)
        },
      })

      // 立即发送早期 PTY_BIND 到渲染端，创建临时 session entry（ptyId 作为临时 claudeId）
      // 这样即使 Hook/JSONL 未就绪，渲染端也能立即显示正在运行的 session
      mainWindow?.webContents.send(IPC.PTY_BIND, {
        ptyId: sessionId,
        claudeId: sessionId,  // 临时占位，autoWatchTranscript 或 Hook 到达后用真实 claudeId 迁移
        transcriptPath: null,
        cwd: payload.projectPath,
        projectId: payload.projectId,  // 直接传入，避免 pendingPtyStartsAtom 时序问题
      })
      console.log(`[PtyBind] Early PTY_BIND sent: PTY=${sessionId} (temporary claudeId, waiting for real binding)`)

      logWinState?.('SESSION_START_afterPtyStart')
      // 主动监控 transcript 文件（不依赖 hooks/statusLine，仿 agent-flow 方式）
      autoWatchTranscript(sessionId, payload.projectPath, sessionStartTime)

      logWinState?.('SESSION_START_afterWatch')
      // 更新 projects.json 记录活跃 session
      const existing = readProjects().find((p) => p.id === payload.projectId)
      if (existing) {
        upsertProject({
          ...existing,
          activeSessionId: sessionId,
          sessionIds: [...existing.sessionIds, sessionId],
          lastActiveAt: Date.now(),
        })
      }

      // 通知渲染进程刷新该项目（activeSessionId 已更新）
      const updatedProject = readProjects().find((p) => p.id === payload.projectId)
      if (updatedProject) {
        mainWindow?.webContents.send(IPC.PROJECT_UPDATED, updatedProject)
      }

      console.log(`[ipc] session:start OK → ${sessionId}`)
      return { ok: true, sessionId }
    } catch (err) {
      console.error('[ipc] session:start failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.SESSION_INPUT, async (
    _event,
    payload: { sessionId: string; text: string; raw?: boolean }
  ) => {
    try {
      // 若 sessionId 是 Claude Code UUID（branch session），通过绑定表反查真实 PTY UUID
      const ptyId = claudeToPtyMap.get(payload.sessionId) ?? payload.sessionId
      // raw=true：xterm 交互模式，每次按键原样发到 PTY，由 line discipline 处理行缓冲
      // raw=false（默认）：程序注入整句指令，自动追加 \r 触发执行
      if (payload.raw) {
        ptyManager.rawWrite(ptyId, payload.text)
      } else {
        ptyManager.writeToSession(ptyId, payload.text)
      }
      // 精确匹配 "/branch"（去除首尾空白后完全等于 /branch）
      if (payload.text.trim() === '/branch') {
        console.log(`[Branch] /branch detected on session ${payload.sessionId} → ptyId=${ptyId}`)
        // key 统一用真实 ptyId（hook server 用 ptyIdBeforeUnbind 查，必须与此一致）
        pendingBranchByPtySession.set(ptyId, Date.now())
        // parentClaudeId：从 ptyId 反查（ptyId 绑定到当前运行的 claudeId）
        const parentClaudeIdForBranch = ptyToClaudeMap.get(ptyId)
        // SESSION_BRANCH_LINK 预通知：sessionId 用 ptyId（渲染层 branchHandler 期望的 parentPtyId）
        mainWindow?.webContents.send(IPC.SESSION_BRANCH_LINK, {
          sessionId: ptyId,
          parentClaudeId: parentClaudeIdForBranch,
          timestamp: Date.now(),
        })
        // 3s 后连发 2×Ctrl+C，强制 branch session 退出以触发 SessionEnd hook
        setTimeout(() => {
          if (pendingBranchByPtySession.has(ptyId)) {
            console.log(`[Branch] Sending 2×Ctrl+C to force branch session exit (ptyId=${ptyId})`)
            ptyManager.rawWrite(ptyId, '\x03')
            setTimeout(() => ptyManager.rawWrite(ptyId, '\x03'), 200)
          }
        }, 3000)
      }
      return { ok: true }
    } catch (err) {
      console.error('[ipc] session:input failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.SESSION_STOP, async (
    _event,
    payload: { sessionId: string }
  ) => {
    try {
      const ptyId = claudeToPtyMap.get(payload.sessionId) ?? payload.sessionId
      // 先连发两次 Ctrl+C，让 Claude Code 优雅退出并写完 JSONL，再等 500ms 后强杀 PTY
      ptyManager.rawWrite(ptyId, '\x03\x03')
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
      ptyManager.stopSession(ptyId)
      console.log(`[ipc] session:stop: PTY ${ptyId} stopped after Ctrl+C`)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] session:stop failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.SESSION_RESUME, async (
    _event,
    payload: { projectId: string; projectPath: string; resumeSessionId: string; permissionMode: PermissionMode }
  ) => {
    try {
      const logWinState = (globalThis as Record<string, unknown>).__logMainWinState as ((tag: string) => void) | undefined
      logWinState?.('SESSION_RESUME_begin')
      const sessionId = randomUUID()
      const sessionStartTime = Date.now()
      ensureProjectTrusted(payload.projectPath)
      logWinState?.('SESSION_RESUME_afterTrust')
      ptyManager.resumeSession({
        sessionId,
        projectPath: payload.projectPath,
        permissionMode: payload.permissionMode,
        resumeSessionId: payload.resumeSessionId,
        onData: (sid, data) => {
          mainWindow?.webContents.send(IPC.SESSION_STATUS, { sessionId: sid, data })
          termWindows.get(sid)?.webContents.send(IPC.TERM_DATA, data)
        },
        onExit: (sid, exitCode) => {
          console.log(`[PtyManager] Session ${sid} exited with code ${exitCode}`)
          mainWindow?.webContents.send(IPC.SESSION_STATUS, { sessionId: sid, status: 'Completed' })
          termWindows.get(sid)?.webContents.send(IPC.TERM_DATA, '\r\n[进程已退出]\r\n')
        },
      })
      logWinState?.('SESSION_RESUME_afterPtyStart')
      // claude -r 不触发 SessionStart hook，依赖 autoWatchTranscript 建立 PTY↔Claude 绑定
      // expectedClaudeId = resumeSessionId（claudeId），确保只匹配主线 JSONL，不误绑 branch JSONL
      autoWatchTranscript(sessionId, payload.projectPath, sessionStartTime, true, undefined, payload.resumeSessionId)
      logWinState?.('SESSION_RESUME_afterWatch')
      console.log(`[ipc] session:resume OK → ${sessionId}`)
      return { ok: true, sessionId }
    } catch (err) {
      console.error('[ipc] session:resume failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── Session meta 持久化（.meta.json sidecar，确保 startedAt live/restore 一致）──

  ipcMain.handle(IPC.SESSION_META_WRITE, async (
    _event,
    payload: { claudeId: string; cwd: string; startedAt: number }
  ) => {
    try {
      const encoded = payload.cwd.replace(/[^a-zA-Z0-9]/g, '-')
      const claudeDir = path.join(os.homedir(), '.claude', 'projects', encoded)
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true })
      }
      const metaFile = path.join(claudeDir, `${payload.claudeId}.meta.json`)
      // 只在文件不存在时写入（防止覆盖已有值）
      if (!fs.existsSync(metaFile)) {
        fs.writeFileSync(metaFile, JSON.stringify({ startedAt: payload.startedAt }), 'utf-8')
        console.log(`[ipc] session:meta-write: written ${payload.claudeId.slice(0,8)} startedAt=${new Date(payload.startedAt).toISOString()}`)
      }
      return { ok: true }
    } catch (err) {
      console.error('[ipc] session:meta-write failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── Git 操作（M4 S4，委托给 GitManager）──────────────────────────────────────

  ipcMain.handle(IPC.GIT_COMMIT, (_event, payload: { projectPath: string; message: string }) => {
    return GitManager.commit(payload.projectPath, payload.message)
  })

  ipcMain.handle(IPC.GIT_RESET, (_event, payload: { projectPath: string; commitHash: string }) => {
    return GitManager.reset(payload.projectPath, payload.commitHash)
  })

  ipcMain.handle(IPC.GIT_ENSURE_REPO, (_event, payload: { projectPath: string }) => {
    return GitManager.ensureRepo(payload.projectPath)
  })

  ipcMain.handle(IPC.GIT_DELETE_COMMIT, (_event, payload: { projectPath: string; commitHash: string }) => {
    return GitManager.deleteCommit(payload.projectPath, payload.commitHash)
  })

  ipcMain.handle(IPC.GIT_PUSH, (_event, payload: { projectPath: string; branch?: string }) => {
    return GitManager.push(payload.projectPath, payload.branch)
  })

  ipcMain.handle(IPC.GIT_GET_STATUS, (_event, payload: { projectPath: string }) => {
    return GitManager.getStatus(payload.projectPath)
  })

  ipcMain.handle(IPC.GIT_MARK_SAVE, async (_event, payload: { transcriptPath: string; mark: GitMark }) => {
    try {
      const dir = path.dirname(payload.transcriptPath)
      const base = path.basename(payload.transcriptPath, '.jsonl')
      const marksPath = path.join(dir, `${base}.git-marks.jsonl`)
      fs.appendFileSync(marksPath, JSON.stringify(payload.mark) + '\n', 'utf-8')
      console.log(`[ipc] git:mark-save ok: ${payload.mark.nodeId} hash=${payload.mark.commitHash}`)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] git:mark-save failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.GIT_MARKS_LOAD, async (_event, payload: { gitMarksPath: string }) => {
    try {
      if (!fs.existsSync(payload.gitMarksPath)) return { ok: true, marks: [] }
      const lines = fs.readFileSync(payload.gitMarksPath, 'utf-8').split('\n').filter(Boolean)
      const marks: GitMark[] = lines.map((l) => JSON.parse(l) as GitMark)
      console.log(`[ipc] git:marks-load: ${marks.length} marks from ${payload.gitMarksPath}`)
      return { ok: true, marks }
    } catch (err) {
      console.error('[ipc] git:marks-load failed:', err)
      return { ok: false, marks: [], error: String(err) }
    }
  })

  ipcMain.handle(IPC.GIT_MARK_DELETE, async (_event, payload: { transcriptPath: string; nodeId: string }) => {
    try {
      const dir = path.dirname(payload.transcriptPath)
      const base = path.basename(payload.transcriptPath, '.jsonl')
      const marksPath = path.join(dir, `${base}.git-marks.jsonl`)
      if (!fs.existsSync(marksPath)) return { ok: true }
      const lines = fs.readFileSync(marksPath, 'utf-8').split('\n').filter(Boolean)
      const kept = lines.filter((l) => {
        try { return (JSON.parse(l) as GitMark).nodeId !== payload.nodeId }
        catch { return true }
      })
      fs.writeFileSync(marksPath, kept.map((l) => l + '\n').join(''), 'utf-8')
      console.log(`[ipc] git:mark-delete ok: nodeId=${payload.nodeId} remaining=${kept.length}`)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] git:mark-delete failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── 配置读写 ─────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.CONFIG_READ, async () => {
    return readAllConfigGroups()
  })

  ipcMain.handle(IPC.CONFIG_WRITE, async (_event, payload: { scope: 'claude' | 'driver'; key: string; value: unknown }) => {
    console.log('[ipc] config:write', payload.key, 'scope=', payload.scope)
    try {
      if (payload.scope === 'driver') {
        patchDriverConfig(payload.key as keyof import('../shared/types/index').DriverConfig, payload.value)
      } else {
        const settings = readClaudeSettings()
        if (payload.key === 'env') {
          // env 块走 deep merge，不覆盖用户手动添加的其他 env 字段
          const newEnv = payload.value as Record<string, string>
          settings.env = { ...(settings.env ?? {}), ...newEnv }
        } else {
          settings[payload.key] = payload.value
        }
        writeClaudeSettings(settings)
      }
      return { ok: true }
    } catch (err) {
      console.error('[ipc] config:write error:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── M5 S2 全局设置 Modal ─────────────────────────────────────────────────

  ipcMain.handle(IPC.DRIVER_CONFIG_READ, async () => {
    console.log('[ipc] driver-config:read')
    const config = readDriverConfig()
    return { ...config, appVersion: app.getVersion() }
  })

  ipcMain.handle(IPC.API_TEST, async (_event, payload: { apiKey: string }) => {
    console.log('[ipc] api:test')
    try {
      const https = await import('https')
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })
      const result = await new Promise<{ ok: boolean; model?: string; error?: string }>((resolve) => {
        const req = https.request(
          {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': payload.apiKey,
              'anthropic-version': '2023-06-01',
              'Content-Length': Buffer.byteLength(body),
            },
            timeout: 8000,
          },
          (res) => {
            let data = ''
            res.on('data', (chunk: Buffer) => { data += chunk.toString() })
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data) as { model?: string; error?: { message?: string } }
                if (res.statusCode === 200) {
                  resolve({ ok: true, model: parsed.model ?? 'claude-haiku-4-5-20251001' })
                } else {
                  resolve({ ok: false, error: parsed.error?.message ?? `HTTP ${res.statusCode}` })
                }
              } catch {
                resolve({ ok: false, error: '响应解析失败' })
              }
            })
          }
        )
        req.on('error', (err: Error) => resolve({ ok: false, error: err.message }))
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }) })
        req.write(body)
        req.end()
      })
      return result
    } catch (err) {
      console.error('[ipc] api:test error:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── Provider 配置 ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.PROVIDER_CONFIG_READ, async () => {
    const env = readClaudeEnvBlock()
    console.log('[ipc] provider-config:read env keys:', Object.keys(env).length)
    return env
  })

  ipcMain.handle(IPC.CLAUDE_SETTINGS_READ, async () => {
    const s = readClaudeSettings()
    console.log('[ipc] claude-settings:read keys:', Object.keys(s).length)
    return {
      apiKey: s.apiKey ?? '',
      apiKeyHelper: s.apiKeyHelper ?? '',
      language: s.language ?? '',
      outputStyle: s.outputStyle ?? '',
      syntaxHighlightingDisabled: !!s.syntaxHighlightingDisabled,
      showThinkingSummaries: !!s.showThinkingSummaries,
      spinnerTipsEnabled: s.spinnerTipsEnabled !== false,
      autoMemoryEnabled: !!s.autoMemoryEnabled,
      memoryDir: s.memoryDir ?? '',
      cleanupPeriodDays: typeof s.cleanupPeriodDays === 'number' ? s.cleanupPeriodDays : 30,
      ignorePatterns: Array.isArray(s.ignorePatterns) ? s.ignorePatterns as string[] : [],
      permissionDefaultMode: (s as Record<string, unknown>)['permissions.defaultMode'] ?? 'default',
      permissionAdditionalDirs: Array.isArray((s as Record<string, unknown>)['permissions.additionalDirectories']) ? (s as Record<string, unknown>)['permissions.additionalDirectories'] as string[] : [],
      permissionAllow: Array.isArray((s as Record<string, unknown>)['permissions.allow']) ? (s as Record<string, unknown>)['permissions.allow'] as string[] : [],
    }
  })

  ipcMain.handle(IPC.PROVIDER_CONFIG_WRITE, async (_event, payload: { env: Record<string, string> }) => {
    console.log('[ipc] provider-config:write keys:', Object.keys(payload.env))
    try {
      const hasValues = Object.values(payload.env).some((v) => v !== '' && v !== undefined)
      if (!hasValues) {
        removeClaudeEnvBlock()
      } else {
        writeClaudeEnvBlock(payload.env)
      }
      return { ok: true }
    } catch (err) {
      console.error('[ipc] provider-config:write error:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.API_TEST_PROVIDER, async (_event, payload: {
    baseUrl: string
    apiKey: string
    model: string
  }) => {
    console.log('[ipc] api:test-provider baseUrl:', payload.baseUrl)
    try {
      const https = await import('https')
      const parsedUrl = new URL(payload.baseUrl)
      const body = JSON.stringify({
        model: payload.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const req = https.request(
          {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + '/v1/messages',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': payload.apiKey,
              'anthropic-version': '2023-06-01',
              'Content-Length': Buffer.byteLength(body),
            },
            timeout: 8000,
          },
          (res) => {
            let data = ''
            res.on('data', (chunk: Buffer) => { data += chunk.toString() })
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data) as { error?: { message?: string } }
                if (res.statusCode === 200) {
                  resolve({ ok: true })
                } else {
                  resolve({ ok: false, error: parsed.error?.message ?? `HTTP ${res.statusCode}` })
                }
              } catch {
                resolve({ ok: false, error: '响应解析失败' })
              }
            })
          }
        )
        req.on('error', (err: Error) => resolve({ ok: false, error: err.message }))
        req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, error: '请求超时' }) })
        req.write(body)
        req.end()
      })
      return result
    } catch (err) {
      console.error('[ipc] api:test-provider error:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.CONFIG_EXPORT, async (_event, payload: { targetPath: string }) => {
    console.log('[ipc] config:export', payload.targetPath)
    try {
      const fs = await import('fs')
      const os = await import('os')
      const path = await import('path')
      const srcPath = path.join(os.homedir(), '.claude-driver', 'config.json')
      if (!fs.existsSync(srcPath)) {
        // 导出默认配置
        const config = readDriverConfig()
        fs.writeFileSync(payload.targetPath, JSON.stringify(config, null, 2), 'utf-8')
      } else {
        fs.copyFileSync(srcPath, payload.targetPath)
      }
      return { ok: true }
    } catch (err) {
      console.error('[ipc] config:export error:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.CONFIG_IMPORT, async (_event, payload: { sourcePath: string }) => {
    console.log('[ipc] config:import', payload.sourcePath)
    try {
      const fs = await import('fs')
      const raw = fs.readFileSync(payload.sourcePath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      // 基础格式校验：必须是对象
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: '文件格式无效：必须是 JSON 对象' }
      }
      const imported = { ...readDriverConfig(), ...parsed }
      writeDriverConfig(imported as import('../shared/types/index').DriverConfig)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] config:import error:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.DIALOG_SAVE_FILE, async (_event, payload?: { defaultName?: string }) => {
    console.log('[ipc] dialog:save-file')
    const result = await dialog.showSaveDialog({
      defaultPath: payload?.defaultName ?? 'claude-driver-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    return result.canceled ? null : result.filePath
  })

  ipcMain.handle(IPC.DIALOG_OPEN_FILE, async (_event, payload?: { filters?: Electron.FileFilter[] }) => {
    console.log('[ipc] dialog:open-file')
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: payload?.filters ?? [{ name: 'JSON', extensions: ['json'] }],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.SHELL_OPEN_PATH, async (_event, targetPath: string) => {
    try {
      if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) {
        await shell.openExternal(targetPath)
      } else {
        await shell.openPath(targetPath)
      }
      return { ok: true }
    } catch (err) {
      console.error('[SHELL_OPEN_PATH] Failed to open:', targetPath, err)
      return { ok: false, error: String(err) }
    }
  })

  // ── JSONL 监听（M4 S3 T5）────────────────────────────────────────────────

  ipcMain.handle(IPC.JSONL_WATCH, async (
    _event,
    payload: { transcriptPath: string; sessionId: string; readFromStart: boolean }
  ) => {
    try {
      const watcher = getJsonlWatcher()

      if (payload.readFromStart) {
        // 历史模式：若文件已存在则全量读取后分批推送；否则跳过（session 刚启动时文件尚未创建）
        if (!fs.existsSync(payload.transcriptPath)) {
          console.log(`[ipc] jsonl:watch: file not yet created, skip historical read for ${payload.sessionId}`)
        } else {
          const { parseJsonlLine } = await import('./lib/jsonl/JsonlParser')
          const content = fs.readFileSync(payload.transcriptPath, 'utf-8')
          const lines = content.split('\n').filter((l) => l.trim())

          // 扫描最后 30 行，查找最近的 file-history-snapshot（branch 起始点）
          // 找到后通过 JSONL_BRANCH_SNAPSHOT 通知 renderer，renderer 据此过滤掉父 session 历史前缀
          const tailLines = lines.slice(-30)
          let branchStartUuid: string | undefined
          for (let i = tailLines.length - 1; i >= 0; i--) {
            try {
              const obj = JSON.parse(tailLines[i]) as Record<string, unknown>
              if (obj['type'] === 'file-history-snapshot') {
                branchStartUuid = obj['messageId'] as string | undefined
                break
              }
            } catch { /* ignore */ }
          }
          if (branchStartUuid) {
            mainWindow?.webContents.send(IPC.JSONL_BRANCH_SNAPSHOT, {
              sessionId: payload.sessionId,
              branchStartUuid,
            })
            console.log(`[ipc] jsonl:watch branch snapshot detected for ${payload.sessionId}: ${branchStartUuid}`)
          }

          // 逐行解析并追踪 file-history-snapshot，标注 isBranchStart
          let prevWasSnapshot = false
          const records = lines.map((l) => {
            const isSnapshot = (() => {
              try { return (JSON.parse(l) as Record<string, unknown>)['type'] === 'file-history-snapshot' }
              catch { return false }
            })()
            const wasPrevSnapshot = prevWasSnapshot
            prevWasSnapshot = isSnapshot

            const r = parseJsonlLine(l)
            if (r) {
              r.sessionId = payload.sessionId
              if (wasPrevSnapshot && r.type === 'user') r.isBranchStart = true
            }
            return r
          }).filter(Boolean)

          // 分批推送（每批 50 条，避免 IPC 消息过大）
          const BATCH_SIZE = 50
          for (let i = 0; i < records.length; i += BATCH_SIZE) {
            const batch = records.slice(i, i + BATCH_SIZE)
            mainWindow?.webContents.send(IPC.JSONL_RECORDS, {
              sessionId: payload.sessionId,
              records: batch,
            })
          }
          console.log(`[ipc] jsonl:watch historical - sent ${records.length} records for ${payload.sessionId}`)

          // 同步加载 subagent 插入线（仅历史模式）
          // 注意：subagent JSONL 时间线节点由 JsonlWatcher.watchFile() → scanSubagentsDir() 统一加载，
          // 此处不再手动扫描，避免与 scanSubagentsDir 重复推送导致 renderer 端时间线节点翻倍。
          // 路径：<claudeDir>/<claudeId>/subagents/agent-*.insertions.jsonl
          const subDir = path.join(
            path.dirname(payload.transcriptPath),
            path.basename(payload.transcriptPath, '.jsonl'),
            'subagents'
          )
          try {
            for (const sf of fs.readdirSync(subDir)) {
              if (!sf.startsWith('agent-') || !sf.endsWith('.insertions.jsonl')) continue
              const agentId = sf.replace('agent-', '').replace('.insertions.jsonl', '')
              const insertionsPath = path.join(subDir, sf)
              const insertions = replayInsertions(insertionsPath)
              if (insertions.length > 0) {
                mainWindow?.webContents.send(IPC.JSONL_SUBAGENT_INSERTIONS, {
                  sessionId: payload.sessionId,
                  agentId,
                  insertions,
                })
                console.log(`[ipc] jsonl:watch subagent insertions ${agentId}: sent ${insertions.length} insertions`)
              }
            }
          } catch { /* subdir scan failed, skip */ }
        }
      }

      // 无论历史/实时，都注册 tail 监听（历史模式之后仍然可以追加实时内容）
      watcher.watchFile(payload.transcriptPath, payload.sessionId, false)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] jsonl:watch failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── 历史 session 元数据扫描（T8）────────────────────────────────────────

  ipcMain.handle(IPC.PROJECT_HISTORY_SCAN, async (
    _event,
    payload: { projectPath: string; maxSessions: number }
  ) => {
    const encoded = payload.projectPath.replace(/[^a-zA-Z0-9]/g, '-')
    const claudeDir = path.join(os.homedir(), '.claude', 'projects', encoded)
    const MAX = payload.maxSessions ?? 20

    // ── 诊断日志：打印编码路径和目录内容，帮助定位 Windows 路径编码问题 ──
    console.log(`[history-scan] projectPath=${payload.projectPath} encoded=${encoded}`)
    console.log(`[history-scan] claudeDir=${claudeDir} exists=${fs.existsSync(claudeDir)}`)

    if (!fs.existsSync(claudeDir)) {
      // 列出 .claude/projects/ 下所有实际目录，帮助对比编码差异
      const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
      try {
        if (fs.existsSync(projectsRoot)) {
          const actualDirs = fs.readdirSync(projectsRoot)
          console.log(`[history-scan] .claude/projects/ actual entries (${actualDirs.length}): ${actualDirs.join(' | ')}`)
        } else {
          console.log(`[history-scan] .claude/projects/ root does NOT exist: ${projectsRoot}`)
        }
      } catch (err) {
        console.error(`[history-scan] failed to list .claude/projects/:`, err)
      }
      console.log(`[ipc] project:history-scan: dir not found: ${claudeDir}`)
      return []
    }

    const results: Array<{
      claudeId: string; cwd: string; transcriptPath: string; mtime: number
      startedAt?: number
      forkedFrom: { sessionId: string; messageUuid: string } | null
      branchTriggerIndex: number | null
      parentNodeCountAtBranch: number | null
      subagentFiles: Array<{ agentId: string; filePath: string }>
      insertionsPath: string | null
      milestonesPath: string | null
      gitMarksPath: string | null
    }> = []

    try {
      const entries = fs.readdirSync(claudeDir)

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue

        const filePath = path.join(claudeDir, entry)
        const claudeId = entry.replace('.jsonl', '')

        try {
          const stat = fs.statSync(filePath)
          const content = fs.readFileSync(filePath, 'utf-8')
          const lines = content.split('\n').filter((l) => l.trim())

          // 优先读 .meta.json 获取 startedAt；若无则从 JSONL 第一条 timestamp 提取
          const metaFile = path.join(claudeDir, `${claudeId}.meta.json`)
          let startedAt: number | undefined
          let metaExists = false
          if (fs.existsSync(metaFile)) {
            try {
              const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as { startedAt: number }
              if (meta.startedAt && !isNaN(meta.startedAt)) {
                startedAt = meta.startedAt
                metaExists = true
              }
            } catch { /* meta file corrupted, fall through to JSONL extraction */ }
          }

          // 找第一条含 cwd 的记录行，同时提取第一条 timestamp（仅当 meta 不存在时）
          let cwd: string | undefined
          let forkedFrom: { sessionId: string; messageUuid: string } | null = null

          for (const line of lines) {
            try {
              const obj = JSON.parse(line) as Record<string, unknown>
              // 提取第一条 timestamp（ISO 8601 字符串 → ms），独立于 cwd 查找
              if (startedAt === undefined && obj['timestamp']) {
                const ts = new Date(obj['timestamp'] as string).getTime()
                if (!isNaN(ts)) startedAt = ts
              }
              if (obj['cwd']) {
                cwd = obj['cwd'] as string
                const ff = obj['forkedFrom'] as { sessionId: string; messageUuid: string } | undefined
                forkedFrom = ff ?? null
                // 不 break：继续扫描后续行以找到 timestamp（可能在 cwd 行之后）
                if (startedAt !== undefined) break
              }
            } catch { continue }
          }
          console.log(`[history-scan] ${claudeId.slice(0,8)}: startedAt=${startedAt ? new Date(startedAt).toISOString() : 'null'} (source=${metaExists ? 'meta.json' : startedAt ? 'JSONL timestamp' : 'none'}), mtime=${new Date(stat.mtimeMs).toISOString()}`)

          // 过滤：只要匹配项目路径的 session
          if (!cwd) continue
          // 跨平台路径匹配：归一化分隔符
          if (cwd.replace(/\\/g, '/') !== payload.projectPath.replace(/\\/g, '/') && !cwd.replace(/\\/g, '/').startsWith(payload.projectPath.replace(/\\/g, '/') + '/')) continue

          // 新 session（无 .meta.json）→ 种子写入，确保后续 live/restore 一致
          if (!metaExists && startedAt !== undefined) {
            try {
              fs.writeFileSync(metaFile, JSON.stringify({ startedAt }), 'utf-8')
              console.log(`[history-scan] ${claudeId.slice(0,8)}: seeded .meta.json with startedAt=${new Date(startedAt).toISOString()}`)
            } catch (err) {
              console.warn(`[history-scan] ${claudeId.slice(0,8)}: failed to write .meta.json:`, err)
            }
          }

          // 扫描 subagent 子目录（<claudeDir>/<claudeId>/subagents/agent-*.jsonl）
          const subagentFiles: Array<{ agentId: string; filePath: string }> = []
          const subDir = path.join(claudeDir, claudeId, 'subagents')
          if (fs.existsSync(subDir)) {
            try {
              for (const sf of fs.readdirSync(subDir)) {
                if (!sf.startsWith('agent-') || !sf.endsWith('.jsonl')) continue
                const agentId = sf.replace('agent-', '').replace('.jsonl', '')
                subagentFiles.push({ agentId, filePath: path.join(subDir, sf) })
              }
            } catch { /* subdir read failed, skip */ }
          }

          const insertionsFile = path.join(claudeDir, `${claudeId}.insertions.jsonl`)
          const insertionsPath = fs.existsSync(insertionsFile) ? insertionsFile : null
          const milestonesFile = path.join(claudeDir, `${claudeId}.milestones.jsonl`)
          const milestonesPath = fs.existsSync(milestonesFile) ? milestonesFile : null
          const gitMarksFile = path.join(claudeDir, `${claudeId}.git-marks.jsonl`)
          const gitMarksPath = fs.existsSync(gitMarksFile) ? gitMarksFile : null
          results.push({ claudeId, cwd, transcriptPath: filePath, mtime: stat.mtimeMs, startedAt, forkedFrom, branchTriggerIndex: null, parentNodeCountAtBranch: null, subagentFiles, insertionsPath, milestonesPath, gitMarksPath })
        } catch { continue }
      }
    } catch (err) {
      console.error('[ipc] project:history-scan failed:', err)
      return []
    }

    // ── 计算每个 branch session 在父 JSONL 中的触发节点索引 ──────────────────
    // 遍历所有 forkedFrom != null 的 session，找到父 JSONL，统计 forkedFrom.messageUuid 前
    // 出现的 user/assistant 类型记录数（与 renderer timelineBySessionAtom 的索引计算一致）
    const claudeIdToResult = new Map(results.map((r) => [r.claudeId, r]))
    for (const r of results) {
      if (!r.forkedFrom) continue
      const parentResult = claudeIdToResult.get(r.forkedFrom.sessionId)
      if (!parentResult) {
        console.log(`[history-scan] branchTriggerIndex: parent ${r.forkedFrom.sessionId.slice(0,8)} not in results for ${r.claudeId.slice(0,8)}`)
        continue
      }
      try {
        const parentContent = fs.readFileSync(parentResult.transcriptPath, 'utf-8')
        const parentLines = parentContent.split('\n').filter((l) => l.trim())
        let nodeCount = 0
        let found = false
        for (const line of parentLines) {
          try {
            const obj = JSON.parse(line) as Record<string, unknown>
            const uuid = obj['uuid'] as string | undefined
            if (uuid === r.forkedFrom.messageUuid) { found = true; break }
            const role = obj['role'] as string | undefined
            const msgType = obj['type'] as string | undefined
            // 计算 user/assistant 节点数（与 jsonlToNode 一致：role=user → user_input，role=assistant → assistant）
            if ((role === 'user' || role === 'assistant') && msgType !== 'file-history-snapshot') {
              nodeCount++
            }
          } catch { continue }
        }
        r.branchTriggerIndex = found ? Math.max(0, nodeCount - 1) : null
        r.parentNodeCountAtBranch = found ? nodeCount : null
        console.log(`[history-scan] branchTriggerIndex for ${r.claudeId.slice(0,8)}: ${r.branchTriggerIndex ?? 'not found'} (found=${found} nodeCount=${nodeCount})`)
      } catch (err) {
        console.warn(`[history-scan] branchTriggerIndex calc failed for ${r.claudeId.slice(0,8)}:`, err)
      }
    }

    // 按 startedAt（fallback mtime）降序排列，取最近 MAX 个，再升序（时间正序）返回
    const effectiveTime = (r: typeof results[number]) => r.startedAt ?? r.mtime
    results.sort((a, b) => effectiveTime(b) - effectiveTime(a))
    const selected = results.slice(0, MAX)
    selected.sort((a, b) => effectiveTime(a) - effectiveTime(b))

    const withIns = selected.filter((s) => s.insertionsPath !== null).length
    console.log(`[ipc] project:history-scan: ${results.length} total, returning ${selected.length} (${withIns} have insertions) for ${payload.projectPath}`)
    selected.forEach((s) => {
      console.log(`[ipc] history-scan item: claudeId=${s.claudeId.slice(0,8)} insertionsPath=${s.insertionsPath ?? 'null'}`)
    })
    return selected
  })

  // ── 插入线持久化（M4 S3 T9）──────────────────────────────────────────────
  // 存储路径：<claudeId>.insertions.jsonl（与主 JSONL 同目录，不污染主 JSONL 格式）
  // 格式：每行是一条 JSON，完整 LineInsertion 对象（首次写入）或 {_patch:true, id, ...changes}（状态更新）

  /** 重放 insertions.jsonl 文件：按行序收集完整 record，再按序应用 patch 行 */
  function replayInsertions(filePath: string): Array<Record<string, unknown>> {
    if (!fs.existsSync(filePath)) return []
    const raw = fs.readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const recordsById = new Map<string, Record<string, unknown>>()
    const order: string[] = []

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (obj._patch === true) {
          const id = obj.id as string
          const existing = recordsById.get(id)
          if (existing) {
            const merged = { ...existing, ...obj, _patch: undefined } as Record<string, unknown>
            if (
              obj.badgeContent && typeof obj.badgeContent === 'object' &&
              existing.badgeContent && typeof existing.badgeContent === 'object'
            ) {
              merged.badgeContent = {
                ...(existing.badgeContent as Record<string, unknown>),
                ...(obj.badgeContent as Record<string, unknown>),
              }
            }
            recordsById.set(id, merged)
          }
        } else {
          const id = obj.id as string
          if (!recordsById.has(id)) order.push(id)
          recordsById.set(id, obj)
        }
      } catch { /* 跳过损坏行 */ }
    }

    return order.map((id) => recordsById.get(id)).filter(Boolean) as Array<Record<string, unknown>>
  }

  ipcMain.handle(IPC.INSERTION_APPEND, async (
    _event,
    payload: { transcriptPath: string; insertion: unknown }
  ) => {
    try {
      const insertionsPath = payload.transcriptPath.replace(/\.jsonl$/, '.insertions.jsonl')
      const line = JSON.stringify(payload.insertion) + '\n'
      fs.appendFileSync(insertionsPath, line, 'utf-8')
      return { ok: true }
    } catch (err) {
      console.error('[ipc] insertion:append failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.INSERTION_PATCH, async (
    _event,
    payload: { transcriptPath: string; patch: { _patch: boolean; id: string; [key: string]: unknown } }
  ) => {
    try {
      const insertionsPath = payload.transcriptPath.replace(/\.jsonl$/, '.insertions.jsonl')
      const line = JSON.stringify(payload.patch) + '\n'
      fs.appendFileSync(insertionsPath, line, 'utf-8')
      return { ok: true }
    } catch (err) {
      console.error('[ipc] insertion:patch failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.INSERTIONS_LOAD, async (
    _event,
    payload: { insertionsPath: string }
  ) => {
    console.log(`[ipc] insertions:load called for ${payload.insertionsPath}`)
    try {
      const insertions = replayInsertions(payload.insertionsPath)
      console.log(`[ipc] insertions:load: ${insertions.length} insertions from ${payload.insertionsPath}`)
      return { ok: true, insertions }
    } catch (err) {
      console.error('[ipc] insertions:load failed:', err)
      return { ok: false, error: String(err), insertions: [] }
    }
  })

  // ── Subagent 插入线持久化（路径：<claudeId>/subagents/agent-<agentId>.insertions.jsonl）──

  /** 从父 session transcriptPath 推导 subagent 插入线路径 */
  function getSubagentInsertionsPath(parentTranscriptPath: string, agentId: string): string {
    const parentDir = path.dirname(parentTranscriptPath)
    const parentBase = path.basename(parentTranscriptPath, '.jsonl')
    return path.join(parentDir, parentBase, 'subagents', `agent-${agentId}.insertions.jsonl`)
  }

  ipcMain.handle(IPC.INSERTION_SUBAGENT_APPEND, async (
    _event,
    payload: { parentTranscriptPath: string; agentId: string; insertion: unknown }
  ) => {
    try {
      const insertionsPath = getSubagentInsertionsPath(payload.parentTranscriptPath, payload.agentId)
      const dir = path.dirname(insertionsPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const line = JSON.stringify(payload.insertion) + '\n'
      fs.appendFileSync(insertionsPath, line, 'utf-8')
      console.log(`[ipc] insertion:subagent-append agentId=${payload.agentId.slice(0, 8)} path=${insertionsPath}`)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] insertion:subagent-append failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.INSERTION_SUBAGENT_PATCH, async (
    _event,
    payload: { parentTranscriptPath: string; agentId: string; patch: { _patch: boolean; id: string; [key: string]: unknown } }
  ) => {
    try {
      const insertionsPath = getSubagentInsertionsPath(payload.parentTranscriptPath, payload.agentId)
      const line = JSON.stringify(payload.patch) + '\n'
      fs.appendFileSync(insertionsPath, line, 'utf-8')
      return { ok: true }
    } catch (err) {
      console.error('[ipc] insertion:subagent-patch failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── Milestone 持久化（M4 S3 T10）────────────────────────────────────────
  // 存储路径：<claudeId>.milestones.jsonl（与主 JSONL 同目录）
  // 格式：每行是一条完整 Milestone JSON

  ipcMain.handle(IPC.MILESTONE_SAVE, async (
    _event,
    payload: { transcriptPath: string; milestone: unknown }
  ) => {
    try {
      const milestonesPath = payload.transcriptPath.replace(/\.jsonl$/, '.milestones.jsonl')
      const line = JSON.stringify(payload.milestone) + '\n'
      fs.appendFileSync(milestonesPath, line, 'utf-8')
      console.log(`[ipc] milestone:save ok → ${milestonesPath}`)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] milestone:save failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.MILESTONES_LOAD, async (
    _event,
    payload: { milestonesPath: string }
  ) => {
    try {
      if (!fs.existsSync(payload.milestonesPath)) {
        return { ok: true, milestones: [] }
      }
      const raw = fs.readFileSync(payload.milestonesPath, 'utf-8')
      const milestones = raw.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      console.log(`[ipc] milestones:load: ${milestones.length} milestones from ${payload.milestonesPath}`)
      return { ok: true, milestones }
    } catch (err) {
      console.error('[ipc] milestones:load failed:', err)
      return { ok: false, error: String(err), milestones: [] }
    }
  })

  // ── Plan 读取（M4 S2 T1）─────────────────────────────────────────────────

  ipcMain.handle(IPC.PLAN_READ, async (_event, projectPath: string) => {
    try {
      const planPath = path.join(projectPath, 'plan', 'overall_plan.md')
      if (!fs.existsSync(planPath)) {
        return { ok: true, content: null }
      }
      const content = fs.readFileSync(planPath, 'utf-8')
      return { ok: true, content }
    } catch (err) {
      console.error('[ipc] plan:read failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── 项目级 settings.json 读写（M4 S1 T2）─────────────────────────────────

  ipcMain.handle(IPC.PROJECT_SETTINGS_READ, async (_event, projectPath: string) => {
    try {
      // 读取项目 .claude/settings.json（权限/模型/工具等）
      const settingsPath = path.join(projectPath, '.claude', 'settings.json')
      let settings: Record<string, unknown> = {}
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      }

      // 读取项目 .mcp.json 定义的 server 名列表（项目级）
      const mcpJsonServers = readProjectMcpJsonServers(projectPath)

      // 读取 ~/.claude.json 顶层 mcpServers（用户全局级）
      const globalMcpServers = readGlobalMcpServers()

      // 读取 ~/.claude.json 中该项目的 .mcp.json 启用/禁用状态
      const mcpState = readProjectMcpState(projectPath)

      // 读取项目 .claude/settings.json 中 permissions.deny（全局 MCP 禁用判断）
      const permissionsObj = settings['permissions'] as Record<string, unknown> | undefined
      const permissionsDeny: string[] = Array.isArray(permissionsObj?.['deny'])
        ? (permissionsObj!['deny'] as string[])
        : []

      // 读取项目 .claude/settings.local.json 的 permissions.deny（Skill 禁用状态，不进 git）
      const localSettingsPath = path.join(projectPath, '.claude', 'settings.local.json')
      let localPermissionsDeny: string[] = []
      try {
        if (fs.existsSync(localSettingsPath)) {
          const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8')) as Record<string, unknown>
          const localPerms = localSettings['permissions'] as Record<string, unknown> | undefined
          localPermissionsDeny = Array.isArray(localPerms?.['deny']) ? (localPerms!['deny'] as string[]) : []
        }
      } catch (err) {
        console.error('[ipc] project-settings:read local settings failed:', err)
      }

      // 读取 Skills：全局 + 项目级（按来源区分，plugin 保留 label 供前端分组显示）
      const globalSkills = readAllConfigGroups().skillGroups
        .flatMap(g => g.items.map(s => ({
          name: s.name,
          source: g.source as 'user' | 'plugin',
          pluginLabel: g.source === 'plugin' ? g.label : undefined,
          description: s.description,
        })))
      const projectSkills = readProjectSkills(projectPath).map(s => ({ name: s.name, source: 'project' as const, description: s.description }))

      console.log(`[ipc] project-settings:read ${projectPath} → project=${mcpJsonServers.length}, global=${globalMcpServers.length}, skills=${globalSkills.length + projectSkills.length}, localDeny=${localPermissionsDeny.length}`)

      return {
        ok: true,
        settings,
        mcpJsonServers,
        globalMcpServers,
        mcpState,
        permissionsDeny,
        localPermissionsDeny,
        globalSkills,
        projectSkills,
      }
    } catch (err) {
      console.error('[ipc] project-settings:read failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.PROJECT_SETTINGS_WRITE, async (
    _event,
    payload: { projectPath: string; patch: Record<string, unknown> }
  ) => {
    try {
      const dotClaudeDir = path.join(payload.projectPath, '.claude')
      const settingsPath = path.join(dotClaudeDir, 'settings.json')
      const tmpPath = settingsPath + '.tmp'

      fs.mkdirSync(dotClaudeDir, { recursive: true })
      let existing: Record<string, unknown> = {}
      if (fs.existsSync(settingsPath)) {
        existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      }
      const merged = { ...existing, ...payload.patch }
      fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8')
      fs.renameSync(tmpPath, settingsPath)
      console.log(`[ipc] project-settings:write OK → ${settingsPath}`)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] project-settings:write failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── MCP server 启用/禁用（项目级）──────────────────────────────────────────

  ipcMain.handle(IPC.MCP_SET_ENABLED, async (
    _event,
    payload: { projectPath: string; serverName: string; enabled: boolean; source: 'mcp.json' | 'global' }
  ) => {
    try {
      if (payload.source === 'mcp.json') {
        // .mcp.json server：写 ~/.claude.json disabledMcpjsonServers
        patchProjectMcpState(payload.projectPath, payload.serverName, payload.enabled)
        console.log(`[ipc] mcp:set-enabled mcp.json server "${payload.serverName}" enabled=${payload.enabled}`)
      } else {
        // 全局 server：写项目 .claude/settings.json 的 permissions.deny
        const dotClaudeDir = path.join(payload.projectPath, '.claude')
        const settingsPath = path.join(dotClaudeDir, 'settings.json')
        const tmpPath = settingsPath + '.tmp'
        fs.mkdirSync(dotClaudeDir, { recursive: true })

        let existing: Record<string, unknown> = {}
        if (fs.existsSync(settingsPath)) {
          existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
        }

        const perms = (existing['permissions'] as Record<string, unknown> | undefined) ?? {}
        const denyList: string[] = Array.isArray(perms['deny']) ? (perms['deny'] as string[]) : []
        const denyRule = `mcp__${payload.serverName}__*`

        const newDeny = payload.enabled
          // 启用：从 deny 列表移除该规则（同时兼容不带 __* 的旧格式）
          ? denyList.filter(r => r !== denyRule && r !== `mcp__${payload.serverName}`)
          // 禁用：加入 deny 列表（去重）
          : [...new Set([...denyList, denyRule])]

        existing['permissions'] = { ...perms, deny: newDeny }
        fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), 'utf-8')
        fs.renameSync(tmpPath, settingsPath)
        console.log(`[ipc] mcp:set-enabled global server "${payload.serverName}" enabled=${payload.enabled} deny=${newDeny.length}`)
      }
      return { ok: true }
    } catch (err) {
      console.error('[ipc] mcp:set-enabled failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── Skill 启用/禁用（项目级，写 settings.local.json）────────────────────

  ipcMain.handle(IPC.SKILL_SET_ENABLED, async (
    _event,
    payload: { projectPath: string; skillName: string; enabled: boolean }
  ) => {
    try {
      const dotClaudeDir = path.join(payload.projectPath, '.claude')
      const localSettingsPath = path.join(dotClaudeDir, 'settings.local.json')
      const tmpPath = localSettingsPath + '.tmp'
      fs.mkdirSync(dotClaudeDir, { recursive: true })

      let existing: Record<string, unknown> = {}
      if (fs.existsSync(localSettingsPath)) {
        existing = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8')) as Record<string, unknown>
      }

      const perms = (existing['permissions'] as Record<string, unknown> | undefined) ?? {}
      const denyList: string[] = Array.isArray(perms['deny']) ? (perms['deny'] as string[]) : []
      const denyRule = `Skill(${payload.skillName})`

      const newDeny = payload.enabled
        ? denyList.filter(r => r !== denyRule)
        : [...new Set([...denyList, denyRule])]

      existing['permissions'] = { ...perms, deny: newDeny }
      fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), 'utf-8')
      fs.renameSync(tmpPath, localSettingsPath)

      // 确保 settings.local.json 已在 .gitignore 中
      const gitignorePath = path.join(payload.projectPath, '.gitignore')
      try {
        const existing_gi = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : ''
        if (!existing_gi.includes('.claude/settings.local.json')) {
          fs.appendFileSync(gitignorePath, '\n.claude/settings.local.json\n')
          console.log(`[ipc] skill:set-enabled → added settings.local.json to .gitignore`)
        }
      } catch { /* .gitignore 写入失败不阻塞主流程 */ }

      console.log(`[ipc] skill:set-enabled "${payload.skillName}" enabled=${payload.enabled} deny=${newDeny.length}`)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] skill:set-enabled failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── 权限请求审批（M4 S2 T5）─────────────────────────────────────────────

  ipcMain.handle(IPC.PERMISSION_RESPOND, async (
    _event,
    payload: { sessionId: string; ptySessionId: string; approved: boolean; message?: string }
  ) => {
    try {
      // 权限响应：Claude Code 权限提示为 TUI 选项型（默认聚焦 Yes）
      // 同意：直接回车；拒绝：方向键下×2 到 No + 回车；附加信息：Tab + 文字 + 回车
      // 逐个按键发送，每个之间 50ms 延迟（TUI 需要逐个处理按键事件）
      const keys: string[] = []
      if (!payload.approved) {
        keys.push('\x1b[B', '\x1b[B')  // Down×2: Yes -> Yes-don't-ask -> No
      }
      const withMessage = payload.message?.trim()
      if (withMessage) {
        keys.push('\t', withMessage, '\r')  // Tab + 文字 + Enter
      } else {
        keys.push('\r')  // 直接 Enter
      }
      console.log(`[ipc] permission:respond → session=${payload.ptySessionId} approved=${payload.approved} msg=${!!withMessage} keys=${keys.length} seq=${JSON.stringify(keys)}`)
      for (let i = 0; i < keys.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 50))
        ptyManager.rawWrite(payload.ptySessionId, keys[i])
        console.log(`[ipc]   key[${i}] sent (${keys[i].length} chars)`)
      }
      NotificationService.decrementBadge()
      return { ok: true }
    } catch (err) {
      console.error('[ipc] permission:respond failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── 权限请求关闭（M9）─────────────────────────────────────────────────

  ipcMain.handle(IPC.PERMISSION_DISMISS, async (
    _event,
    payload: { requestId: string }
  ) => {
    try {
      console.log(`[ipc] permission:dismiss → requestId=${payload.requestId}`)
      NotificationService.decrementBadge()
      return { ok: true }
    } catch (err) {
      console.error('[ipc] permission:dismiss failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── 独立终端窗口（xterm.js BrowserWindow）────────────────────────────────

  ipcMain.handle(IPC.TERM_WINDOW_OPEN, async (
    _event,
    payload: { sessionId: string; title?: string }
  ) => {
    try {
      // 若已存在则聚焦即可
      const existing = termWindows.get(payload.sessionId)
      if (existing && !existing.isDestroyed()) {
        existing.focus()
        return { ok: true }
      }

      const preloadPath = join(__dirname, '../preload/index.js')
      // 保存主窗口最大化/全屏状态，创建子窗口后延迟恢复
      // Linux WM 在新窗口出现时会异步重新布局（~100-200ms 延迟），必须等 WM 处理完再恢复
      const wasMaximized = mainWindow?.isMaximized() ?? false
      const wasFullScreen = mainWindow?.isFullScreen() ?? false
      const termWindow = new BrowserWindow({
        width: 900,
        height: 560,
        minWidth: 600,
        minHeight: 300,
        show: true,
        title: payload.title ?? `Terminal — ${payload.sessionId.slice(0, 8)}`,
        autoHideMenuBar: true,
        parent: mainWindow ?? undefined,
        ...(process.platform === 'linux' ? { icon } : {}),
        webPreferences: {
          preload: preloadPath,
          sandbox: false,
        },
      })

      // Linux: WM 会在终端窗口出现后的数秒内多次异步缩放主窗口
      // 用定时器无法可靠覆盖，改用 resize 事件监听器 + 防回环锁
      if (process.platform === 'linux' && mainWindow && (wasMaximized || wasFullScreen)) {
        const savedBounds = mainWindow.getBounds()
        let restoreAttempts = 0
        const MAX_ATTEMPTS = 15
        let restoring = false

        const onMainResize = () => {
          if (!mainWindow || mainWindow.isDestroyed() || restoring) return
          if (restoreAttempts >= MAX_ATTEMPTS) return
          const cur = mainWindow.getBounds()
          if (Math.abs(cur.width - savedBounds.width) < 50 && Math.abs(cur.height - savedBounds.height) < 50) return

          restoreAttempts++
          restoring = true
          console.log(`[term-window] WM resize #${restoreAttempts}: ${cur.width}x${cur.height}, restoring to ${savedBounds.width}x${savedBounds.height}`)

          if (wasFullScreen) {
            mainWindow.setFullScreen(false)
            setTimeout(() => {
              mainWindow?.setFullScreen(true)
              setTimeout(() => { restoring = false }, 150)
            }, 80)
          } else {
            mainWindow.unmaximize()
            setTimeout(() => {
              mainWindow?.maximize()
              setTimeout(() => { restoring = false }, 150)
            }, 80)
          }
        }

        mainWindow.on('resize', onMainResize)
        setTimeout(() => {
          mainWindow?.removeListener('resize', onMainResize)
          console.log('[term-window] resize guard removed (5s timeout)')
        }, 5000)
      }

      // 开发模式下打开 devtools 辅助调试 renderer 内容
      if (is.dev) {
        termWindow.webContents.openDevTools({ mode: 'detach' })
      }

      termWindow.on('closed', () => {
        termWindows.delete(payload.sessionId)
      })

      // 加载同一 renderer，使用 hash 路由区分页面
      const sessionParam = encodeURIComponent(payload.sessionId)
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        const url = `${process.env['ELECTRON_RENDERER_URL']}#/terminal?sessionId=${sessionParam}`
        console.log(`[ipc] term-window loadURL: ${url}`)
        termWindow.loadURL(url)
      } else {
        termWindow.loadFile(join(__dirname, '../renderer/index.html'), {
          hash: `/terminal?sessionId=${sessionParam}`
        })
      }

      termWindows.set(payload.sessionId, termWindow)
      console.log(`[ipc] term-window:open created → session ${payload.sessionId}`)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] term-window:open failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.TERM_WINDOW_CLOSE, async (
    _event,
    payload: { sessionId: string }
  ) => {
    const win = termWindows.get(payload.sessionId)
    if (win && !win.isDestroyed()) {
      win.close()
    }
    termWindows.delete(payload.sessionId)
    return { ok: true }
  })

  // PTY resize（由终端窗口内的 xterm.js 触发）
  ipcMain.handle(IPC.TERM_RESIZE, async (
    _event,
    payload: { sessionId: string; cols: number; rows: number }
  ) => {
    try {
      ptyManager.resizeSession(payload.sessionId, payload.cols, payload.rows)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // 读取项目级 .claude/agents/ 目录
  ipcMain.handle(IPC.AGENT_LIST_PROJECT, async (_event, payload: { projectPath: string }) => {
    try {
      const agentsDir = path.join(payload.projectPath, '.claude', 'agents')
      const items = readAgentsFromDir(agentsDir)
      console.log(`[ipc] agent:list-project: ${items.length} agents in ${agentsDir}`)
      return { ok: true, items }
    } catch (err) {
      console.error('[ipc] agent:list-project failed:', err)
      return { ok: false, items: [] }
    }
  })

  // ── M6 S1 灵魂交流：临时 insight PTY（在 home 目录裸启 claude → /insights → 自动销毁）
  //   insightPtyIds：所有 insight 专属 PTY 的 sessionId 集合，用于在 onHookEvent 中屏蔽
  //   这是 onHookEvent 外部声明的 Set，registerIpcHandlers 调用时立即可用
  ipcMain.handle(IPC.INSIGHT_RUN, async () => {
    const insightId = `insight-${randomUUID()}`
    const homeDir = os.homedir()
    const reportPath = path.join(homeDir, '.claude', 'usage-data', 'report.html')

    // 预信任 home 目录，跳过 Claude trust folder 对话框（与正常 session 启动一致）
    ensureProjectTrusted(homeDir)

    console.log(`[insight] starting temporary PTY (id=${insightId}) in ${homeDir}`)
    insightPtyIds.add(insightId)

    let promptReady = false  // 收到 Claude 提示符后才发送命令

    try {
      ptyManager.startBare(
        {
          sessionId: insightId,
          projectPath: homeDir,
          permissionMode: 'default',
          onData: (_id, data) => {
            const plain = stripAnsi(data)
            console.log(`[insight:DATA] ${JSON.stringify(plain.slice(0, 400))}`)
            // 优先处理 trust folder 对话框（兜底：应对预信任失败/新机器/并发竞争）
            // 命中则本次跳过 prompt 检测——trust 对话框选项自带 ❯ 光标，避免在 trust 未确认时
            // 被下方 promptReady 判定误发 /insights（原 bug 的残留路径）
            if (handleTrustFolderPrompt(insightId, data)) return
            // 检测 Claude 交互提示符——去掉宽泛的 '?' 与 '> '，避免误命中 trust 对话框文本
            //   ❯      : Claude TUI 主提示符
            //   Human: : 消息输入提示
            //   \n>    : 行首独立 > 提示符（去 ANSI 后匹配，排除 "a > b" 类普通文本里的 >）
            if (!promptReady && (plain.includes('❯') || plain.includes('Human:') || /\n>\s/.test(plain))) {
              promptReady = true
              console.log('[insight] Claude prompt detected, sending /insights')
              // 使用 rawWrite 保证不再追加多余 \r
              ptyManager.rawWrite(insightId, '/insights\r')
            }
            // 检测 /insights 完成信号（基于去 ANSI 后的纯文本匹配，避免颜色码拆断关键词）
            if (promptReady && (plain.includes('report.html') || plain.includes('Generated') || plain.includes('Done'))) {
              console.log('[insight] /insights done signal detected in stdout')
              // 延迟 500ms 确保文件写入完成后再检查
              setTimeout(() => {
                if (fs.existsSync(reportPath)) {
                  console.log(`[insight] report.html confirmed at ${reportPath}`)
                  mainWindow?.webContents.send(IPC.INSIGHT_REPORT_READY, { filePath: reportPath })
                } else {
                  console.warn(`[insight] done signal seen but report.html NOT found at ${reportPath}`)
                }
                // 销毁临时 PTY
                ptyManager.stopSession(insightId)
              }, 500)
            }
          },
          onExit: (_id, code) => {
            console.log(`[insight] temporary PTY exited (code=${code})`)
            insightPtyIds.delete(insightId)
            trustHandledPtyIds.delete(insightId)
            // 进程退出时若文件已存在（命令成功但未检测到 Done 信号），补发通知
            if (fs.existsSync(reportPath)) {
              mainWindow?.webContents.send(IPC.INSIGHT_REPORT_READY, { filePath: reportPath })
            }
          },
        },
        []  // 裸 claude，不传任何参数
      )

      // 2min 超时：若 Claude 长时间未响应则强制销毁
      setTimeout(() => {
        if (insightPtyIds.has(insightId)) {
          console.warn('[insight] 2min timeout, force stopping insight PTY')
          ptyManager.stopSession(insightId)
          insightPtyIds.delete(insightId)
          trustHandledPtyIds.delete(insightId)
        }
      }, 120_000)

      return { ok: true }
    } catch (err) {
      insightPtyIds.delete(insightId)
      trustHandledPtyIds.delete(insightId)
      console.error('[insight] failed to start insight PTY:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── M6 S5 闲聊 PTY：stream-json 模式 + 气泡窗口 ────────────────────────────
  const chatWindows = new Map<string, BrowserWindow>()

  ipcMain.handle(IPC.CHAT_START, async () => {
    const chatId = `chat-${randomUUID()}`
    const homeDir = os.homedir()
    // 预信任 home 目录，跳过 Claude trust folder 对话框（与正常 session 启动一致）
    ensureProjectTrusted(homeDir)
    chatPtyIds.add(chatId)
    console.log(`[chat] starting PTY (id=${chatId}) in ${homeDir}`)

    try {
      ptyManager.startBare(
        {
          sessionId: chatId,
          projectPath: homeDir,
          permissionMode: 'default',
          onData: (_id, raw) => {
            // 优先处理 trust folder 对话框（兜底），其余原始输出转发到 chat 终端窗口
            handleTrustFolderPrompt(chatId, raw)
            chatWindows.get(chatId)?.webContents.send(IPC.TERM_DATA, raw)
          },
          onExit: (sid, code) => {
            console.log(`[chat] PTY exited (id=${sid} code=${code})`)
            chatPtyIds.delete(sid)
            trustHandledPtyIds.delete(sid)
            chatWindows.get(sid)?.webContents.send(IPC.TERM_DATA, '\r\n[对话已结束]\r\n')
          },
        },
        []   // 裸启：交互式 Claude CLI，无 -p/stream-json
      )
      return { ok: true, sessionId: chatId }
    } catch (err) {
      chatPtyIds.delete(chatId)
      trustHandledPtyIds.delete(chatId)
      console.error('[chat] startBare failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.CHAT_WINDOW_OPEN, async (_event, payload: { sessionId: string }) => {
    try {
      const existing = chatWindows.get(payload.sessionId)
      if (existing && !existing.isDestroyed()) { existing.focus(); return { ok: true } }

      const preloadPath = join(__dirname, '../preload/index.js')
      const chatWindow = new BrowserWindow({
        width: 720,
        height: 600,
        minWidth: 500,
        minHeight: 360,
        title: '💬 闲聊 — Claude',
        autoHideMenuBar: true,
        ...(process.platform === 'linux' ? { icon } : {}),
        webPreferences: { preload: preloadPath, sandbox: false },
      })

      if (is.dev) {
        chatWindow.webContents.openDevTools({ mode: 'detach' })
      }

      chatWindow.on('closed', () => chatWindows.delete(payload.sessionId))

      // 复用 TerminalPage（xterm.js），通过 #/terminal 路由加载
      const sessionParam = encodeURIComponent(payload.sessionId)
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        chatWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/terminal?sessionId=${sessionParam}`)
      } else {
        chatWindow.loadFile(join(__dirname, '../renderer/index.html'), {
          hash: `/terminal?sessionId=${sessionParam}`,
        })
      }

      chatWindows.set(payload.sessionId, chatWindow)
      console.log(`[chat] window opened for session ${payload.sessionId}`)
      return { ok: true }
    } catch (err) {
      console.error('[chat] CHAT_WINDOW_OPEN failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── M6 S1 灵魂交流：在新 BrowserWindow 打开本地 HTML 文件 ─────────────────
  const webviewWindows = new Map<string, BrowserWindow>()

  ipcMain.handle(IPC.OPEN_WEBVIEW, async (_event, payload: { filePath: string; title?: string }) => {
    try {
      const key = payload.filePath

      // 若已存在则聚焦
      const existing = webviewWindows.get(key)
      if (existing && !existing.isDestroyed()) {
        existing.focus()
        return { ok: true }
      }

      const webviewWin = new BrowserWindow({
        width: 900,
        height: Math.floor(800 * 0.9),
        minWidth: 600,
        minHeight: 400,
        title: payload.title ?? '使用洞见报告',
        autoHideMenuBar: true,
        ...(process.platform === 'linux' ? { icon } : {}),
        webPreferences: {
          // 允许加载本地 file:// 资源
          webSecurity: false,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })

      webviewWin.on('closed', () => {
        webviewWindows.delete(key)
      })

      webviewWin.loadFile(payload.filePath)
      webviewWindows.set(key, webviewWin)
      console.log(`[insight] opened webview for: ${payload.filePath}`)
      return { ok: true }
    } catch (err) {
      console.error('[ipc] open:webview failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── M6 S2 定时触发：scheduler handlers ─────────────────────────────────────

  /** 临时注册：ptyId → prompt 检测 resolver（从 onData 中触发） */
  const schedulerPromptResolvers = new Map<string, { origOnData: (d: string) => void; resolve: (v: boolean) => void }>()

  ipcMain.handle(IPC.SCHEDULER_LIST, async () => {
    try {
      const sessions = readSchedulerSessions()
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
      const now = Date.now()

      const result = sessions.flatMap((entry: SchedulerSessionEntry) =>
        entry.tasks.map((task) => ({
          taskId:      task.taskId,
          projectPath: entry.projectPath,
          claudeId:    entry.claudeId,
          interval:    task.interval,
          prompt:      task.prompt,
          createdAt:   task.createdAt,
          isActive:    schedulerPtyByProject.has(entry.projectPath),
          isExpired:   (now - task.createdAt) > SEVEN_DAYS,
        }))
      )
      return { ok: true, tasks: result }
    } catch (err) {
      console.error('[scheduler] list error:', err)
      return { ok: false, error: String(err), tasks: [] }
    }
  })

  ipcMain.handle(IPC.SCHEDULER_CREATE, async (
    _event,
    payload: { projectPath: string; interval: string; prompt: string }
  ) => {
    const { projectPath, interval, prompt } = payload
    const taskId = randomUUID()

    try {
      // 检查该项目是否已有活跃 PTY
      let existingPtyId = schedulerPtyByProject.get(projectPath)
      // 提升到外层，让 /loop 发送后的等待阶段也能读到
      let detectedClaudeId = ''

      if (!existingPtyId || !ptyManager.getActiveSessions().includes(existingPtyId)) {
        // 需要启动新 PTY（或 resume 旧会话）
        const sessions = readSchedulerSessions()
        const entry = sessions.find((e: SchedulerSessionEntry) => e.projectPath === projectPath)
        const ptyId = `scheduler-${randomUUID()}`
        schedulerPtyIds.add(ptyId)

        const args = entry?.claudeId
          ? ['--resume', entry.claudeId]   // resume 旧 loop session
          : []                              // 裸 claude（新 session）

        detectedClaudeId = entry?.claudeId ?? ''
        console.log(`[scheduler] starting PTY ${ptyId} in ${projectPath}, args: ${args.join(' ')}`)

        let promptDetected = false

        ptyManager.startBare(
          {
            sessionId: ptyId,
            projectPath,
            permissionMode: 'default',
            onData: (sid, data) => {
              const plain = stripAnsi(data)

              // 触发 prompt 检测 resolver
              const resolver = schedulerPromptResolvers.get(sid)
              if (resolver && !promptDetected) {
                if (/[❯>?]/.test(plain) || plain.includes('Human:') || plain.includes('$ ')) {
                  promptDetected = true
                  schedulerPromptResolvers.delete(sid)
                  resolver.resolve(true)
                }
              }

              // 从 stdout 解析 claudeId（格式：Session ID: <uuid>），加入 hook 隔离集合
              const sessionMatch = plain.match(/Session ID:\s*([0-9a-f-]{36})/i)
              if (sessionMatch && sessionMatch[1] && !detectedClaudeId) {
                detectedClaudeId = sessionMatch[1]
                console.log(`[scheduler] detected claudeId from stdout: ${detectedClaudeId}`)
                schedulerClaudeIds.add(detectedClaudeId)
                updateSchedulerClaudeId(projectPath, detectedClaudeId)
              }
            },
            onExit: (sid, code) => {
              console.log(`[scheduler] PTY ${sid} exited (code=${code})`)
              schedulerPtyIds.delete(sid)
              schedulerPtyByProject.delete(projectPath)
              if (detectedClaudeId) schedulerClaudeIds.delete(detectedClaudeId)
              // 清理 pending prompt resolver
              const r = schedulerPromptResolvers.get(sid)
              if (r) { schedulerPromptResolvers.delete(sid); r.resolve(false) }
            },
          },
          args
        )

        schedulerPtyByProject.set(projectPath, ptyId)
        existingPtyId = ptyId

        // 等待提示符（最长 30s）
        const resolver = new Promise<boolean>((res) => {
          const timer = setTimeout(() => {
            schedulerPromptResolvers.delete(ptyId)
            res(false)
          }, 30_000)
          schedulerPromptResolvers.set(ptyId, {
            origOnData: () => {},
            resolve: (v: boolean) => { clearTimeout(timer); res(v) },
          })
        })
        const gotPrompt = await resolver
        if (!gotPrompt) {
          console.warn(`[scheduler] timeout waiting for prompt in PTY ${ptyId}`)
          return { ok: false, error: '等待 Claude 启动超时（30s）' }
        }
      }

      // 发送 /loop 命令
      const loopCmd = `/loop ${interval} ${prompt}\r`
      console.log(`[scheduler] sending to PTY ${existingPtyId}: /loop ${interval} ${prompt}`)
      ptyManager.rawWrite(existingPtyId, loopCmd)

      // 等待一小段时间，给 onData 机会捕获 Session ID（stdout 异步到达）
      await new Promise<void>((res) => setTimeout(res, 800))

      // 优先用 onData 中捕获的 claudeId，其次从持久化里读
      let claudeId = detectedClaudeId
      if (!claudeId) {
        const freshSessions = readSchedulerSessions()
        const freshEntry = freshSessions.find((e: SchedulerSessionEntry) => e.projectPath === projectPath)
        claudeId = freshEntry?.claudeId ?? ''
        console.log(`[scheduler] claudeId from store: ${claudeId || '(empty)'}`)
      }

      // 写入持久化
      appendTaskToSession(projectPath, claudeId, {
        taskId,
        interval,
        prompt,
        createdAt: Date.now(),
      })

      console.log(`[scheduler] task created: ${taskId} for project ${projectPath}`)
      return { ok: true, taskId }
    } catch (err) {
      console.error('[scheduler] create error:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.SCHEDULER_TOGGLE, async (
    _event,
    payload: { projectPath: string; active: boolean }
  ) => {
    const { projectPath, active } = payload
    try {
      if (!active) {
        // 停止 PTY
        const ptyId = schedulerPtyByProject.get(projectPath)
        if (ptyId) {
          console.log(`[scheduler] stopping PTY ${ptyId} for project ${projectPath}`)
          ptyManager.stopSession(ptyId)
          schedulerPtyByProject.delete(projectPath)
        }
        return { ok: true }
      } else {
        // 恢复 PTY：有 claudeId 则 resume，否则裸启动（首次创建后 claudeId 可能还未写入）
        const sessions = readSchedulerSessions()
        const entry = sessions.find((e: SchedulerSessionEntry) => e.projectPath === projectPath)

        const ptyId = `scheduler-${randomUUID()}`
        schedulerPtyIds.add(ptyId)

        const resumeClaudeId = entry?.claudeId ?? ''
        const resumeArgs = resumeClaudeId ? ['--resume', resumeClaudeId] : []

        // resume 时已知 claudeId，立即加入隔离集合
        if (resumeClaudeId) schedulerClaudeIds.add(resumeClaudeId)

        console.log(`[scheduler] toggle-on: PTY ${ptyId} in ${projectPath}, args=${resumeArgs.join(' ') || '(bare)'}`)

        let toggleDetectedClaudeId = resumeClaudeId
        ptyManager.startBare(
          {
            sessionId: ptyId,
            projectPath,
            permissionMode: 'default',
            onData: (_sid, data) => {
              const plain = stripAnsi(data)
              // 捕获新的 claudeId（裸启动时产生新 session，或 resume 后确认实际 id）
              const m = plain.match(/Session ID:\s*([0-9a-f-]{36})/i)
              if (m && m[1] && m[1] !== toggleDetectedClaudeId) {
                console.log(`[scheduler-toggle] detected claudeId: ${m[1]}`)
                toggleDetectedClaudeId = m[1]
                schedulerClaudeIds.add(m[1])
                updateSchedulerClaudeId(projectPath, m[1])
              }
            },
            onExit: (sid, code) => {
              console.log(`[scheduler-resume] PTY ${sid} exited (code=${code})`)
              schedulerPtyIds.delete(sid)
              schedulerPtyByProject.delete(projectPath)
              if (toggleDetectedClaudeId) schedulerClaudeIds.delete(toggleDetectedClaudeId)
            },
          },
          resumeArgs
        )
        schedulerPtyByProject.set(projectPath, ptyId)
        console.log(`[scheduler] PTY started for toggle-on: ${ptyId}`)
        return { ok: true }
      }
    } catch (err) {
      console.error('[scheduler] toggle error:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.SCHEDULER_DELETE, async (_event, payload: { taskId: string }) => {
    try {
      deleteSchedulerTask(payload.taskId)
      console.log(`[scheduler] task deleted: ${payload.taskId}`)
      return { ok: true }
    } catch (err) {
      console.error('[scheduler] delete error:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── M7 Token 统计：扫描单个 JSONL 文件汇总 token 消耗 ───────────────────────
  ipcMain.handle(IPC.TOKEN_SCAN_FILE, async (_event, payload: { transcriptPath: string }) => {
    const { transcriptPath } = payload
    try {
      if (!fs.existsSync(transcriptPath)) {
        return { ok: false, error: 'file not found' }
      }
      const content = fs.readFileSync(transcriptPath, 'utf-8')
      const lines = content.split('\n')

      let inputTokens = 0
      let outputTokens = 0
      let cacheCreationTokens = 0
      let cacheReadTokens = 0
      let model: string | null = null

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let raw: unknown
        try { raw = JSON.parse(trimmed) } catch { continue }
        if (typeof raw !== 'object' || raw === null) continue

        const obj = raw as Record<string, unknown>
        if (obj['type'] !== 'assistant') continue

        const msg = obj['message'] as Record<string, unknown> | undefined
        if (!msg) continue

        const rawUsage = msg['usage'] as Record<string, unknown> | undefined
        if (rawUsage) {
          inputTokens         += (rawUsage['input_tokens'] as number | undefined) ?? 0
          outputTokens        += (rawUsage['output_tokens'] as number | undefined) ?? 0
          cacheCreationTokens += (rawUsage['cache_creation_input_tokens'] as number | undefined) ?? 0
          cacheReadTokens     += (rawUsage['cache_read_input_tokens'] as number | undefined) ?? 0
        }

        if (!model && typeof msg['model'] === 'string') {
          model = msg['model']
        }
      }

      console.log(`[TokenScan] ${path.basename(transcriptPath)}: input=${inputTokens} output=${outputTokens} cacheCreate=${cacheCreationTokens} cacheRead=${cacheReadTokens} model=${model}`)
      return { ok: true, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, model }
    } catch (err) {
      console.error('[TokenScan] scan error:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── M6 S3 远程交互（cc-connect）────────────────────────────────────────────
  const remoteBridge = new RemoteBridgeService()

  // cc-connect 服务 PTY + 终端窗口追踪
  let ccConnectPtyId: string | null = null
  let ccConnectWindow: BrowserWindow | null = null

  ipcMain.handle(IPC.CC_CONNECT_CHECK, async () => {
    return remoteBridge.checkInstall()
  })

  // 启动服务：通过 PTY 启动 cc-connect start + 打开终端窗口 + 推送日志到主窗口
  ipcMain.handle(IPC.CC_CONNECT_START, async () => {
    if (ccConnectPtyId && ptyManager.getStatus(ccConnectPtyId) === 'Running') {
      console.log('[remote] cc-connect already running')
      return { ok: true }
    }

    // 确保配置文件存在
    try {
      remoteBridge.ensureConfig()
    } catch (err) {
      console.error('[remote] ensureConfig failed:', err)
    }

    const sessionId = `cc-connect-${randomUUID()}`
    const homeDir = os.homedir()
    ccConnectPtyId = sessionId
    console.log(`[remote] starting cc-connect PTY (id=${sessionId})`)

    try {
      ptyManager.startCommand(
        {
          sessionId,
          projectPath: homeDir,
          permissionMode: 'default',
          onData: (_id, raw) => {
            // 转发到终端窗口
            ccConnectWindow?.webContents.send(IPC.TERM_DATA, raw)
            // 按行拆分推送日志到主窗口
            const lines = raw.split('\n').filter((l: string) => l.trim())
            for (const line of lines) {
              mainWindow?.webContents.send(IPC.CC_CONNECT_LOG, { log: line })
            }
          },
          onExit: (sid, code) => {
            console.log(`[remote] cc-connect PTY exited (id=${sid} code=${code})`)
            ccConnectWindow?.webContents.send(IPC.TERM_DATA, '\r\n[服务已停止]\r\n')
            ccConnectPtyId = null
            ccConnectWindow = null
          },
        },
        'cc-connect',
        ['start']
      )

      // 打开终端窗口
      const preloadPath = join(__dirname, '../preload/index.js')
      const serviceWindow = new BrowserWindow({
        width: 720,
        height: 600,
        minWidth: 500,
        minHeight: 360,
        title: '📡 cc-connect 服务',
        autoHideMenuBar: true,
        ...(process.platform === 'linux' ? { icon } : {}),
        webPreferences: { preload: preloadPath, sandbox: false },
      })
      if (is.dev) serviceWindow.webContents.openDevTools({ mode: 'detach' })
      serviceWindow.on('closed', () => {
        // 用户关闭窗口时停止服务
        if (ccConnectPtyId) {
          ptyManager.stopSession(ccConnectPtyId)
        }
        ccConnectPtyId = null
        ccConnectWindow = null
      })

      const sessionParam = encodeURIComponent(sessionId)
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        await serviceWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/terminal?sessionId=${sessionParam}`)
      } else {
        await serviceWindow.loadFile(join(__dirname, '../renderer/index.html'), {
          hash: `/terminal?sessionId=${sessionParam}`,
        })
      }
      ccConnectWindow = serviceWindow
      console.log('[remote] cc-connect service window opened')
      return { ok: true }
    } catch (err) {
      ccConnectPtyId = null
      console.error('[remote] failed to start cc-connect:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.CC_CONNECT_STOP, async () => {
    if (ccConnectPtyId) {
      ptyManager.stopSession(ccConnectPtyId)
      ccConnectPtyId = null
    }
    if (ccConnectWindow && !ccConnectWindow.isDestroyed()) {
      ccConnectWindow.close()
    }
    ccConnectWindow = null
    console.log('[remote] cc-connect stopped')
    return { ok: true }
  })

  ipcMain.handle(IPC.CC_CONNECT_STATUS, async () => {
    const running = ccConnectPtyId !== null && ptyManager.getStatus(ccConnectPtyId) === 'Running'
    return { running }
  })

  ipcMain.handle(IPC.CC_CONNECT_CONFIG_SAVE, async (
    _event,
    payload: { projectId: string; bot: import('../shared/types/index').FeishuBotConfig }
  ) => {
    try {
      remoteBridge.saveProjectBot(payload.projectId, payload.bot)
      return { ok: true }
    } catch (err) {
      console.error('[remote] CC_CONNECT_CONFIG_SAVE error:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC.CC_CONNECT_CONFIG_READ, async (
    _event,
    payload: { projectName: string }
  ) => {
    try {
      const config = remoteBridge.readProjectConfig(payload.projectName)
      return { found: config !== null, config }
    } catch (err) {
      console.error('[remote] CC_CONNECT_CONFIG_READ error:', err)
      return { found: false, config: null }
    }
  })

  // 一键安装：通过 CLI 位置参数传入提示词，启动 Claude 交互式会话 → 打开终端窗口
  ipcMain.handle(IPC.CC_CONNECT_INSTALL, async () => {
    const installId = `chat-${randomUUID()}`
    const homeDir = os.homedir()
    const INSTALL_PROMPT = '帮我查询当前电脑上有无cc connect，如果没有的话Follow https://raw.githubusercontent.com/chenhg5/cc-connect/refs/heads/main/INSTALL.md to install and configure cc-connect，如果有的话直接告诉已经安装好了。安装完成后请执行 which cc-connect 确认安装成功'
    chatPtyIds.add(installId)
    console.log(`[remote-install] starting PTY (id=${installId}) with prompt`)

    try {
      ptyManager.startBare(
        {
          sessionId: installId,
          projectPath: homeDir,
          permissionMode: 'bypassPermissions',
          onData: (_id, raw) => {
            // 转发到终端窗口
            chatWindows.get(installId)?.webContents.send(IPC.TERM_DATA, raw)
          },
          onExit: (sid, code) => {
            console.log(`[remote-install] PTY exited (id=${sid} code=${code})`)
            chatPtyIds.delete(sid)
            chatWindows.get(sid)?.webContents.send(IPC.TERM_DATA, '\r\n[对话已结束]\r\n')
          },
        },
        ['--dangerously-skip-permissions', INSTALL_PROMPT]
      )

      // 打开终端窗口
      const preloadPath = join(__dirname, '../preload/index.js')
      const installWindow = new BrowserWindow({
        width: 720,
        height: 600,
        minWidth: 500,
        minHeight: 360,
        title: '📦 安装 cc-connect',
        autoHideMenuBar: true,
        ...(process.platform === 'linux' ? { icon } : {}),
        webPreferences: { preload: preloadPath, sandbox: false },
      })
      if (is.dev) installWindow.webContents.openDevTools({ mode: 'detach' })
      installWindow.on('closed', () => chatWindows.delete(installId))

      const sessionParam = encodeURIComponent(installId)
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        await installWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/terminal?sessionId=${sessionParam}`)
      } else {
        await installWindow.loadFile(join(__dirname, '../renderer/index.html'), {
          hash: `/terminal?sessionId=${sessionParam}`,
        })
      }
      chatWindows.set(installId, installWindow)
      console.log(`[remote-install] terminal window opened`)
      return { ok: true }
    } catch (err) {
      chatPtyIds.delete(installId)
      console.error('[remote-install] failed:', err)
      return { ok: false, error: String(err) }
    }
  })

  // ── 应用更新 ──────────────────────────────────────────────────
  ipcMain.handle(IPC.UPDATER_CHECK, async () => {
    console.log('[ipc] updater:check')
    await checkForUpdates()
  })

  ipcMain.handle(IPC.UPDATER_DOWNLOAD, async () => {
    console.log('[ipc] updater:download')
    await downloadUpdate()
  })

  ipcMain.handle(IPC.UPDATER_QUIT_AND_INSTALL, async () => {
    console.log('[ipc] updater:quit-and-install')
    quitAndInstall()
  })

  // ── 作者推荐 ──────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.RECOMMEND_GET, async (_event, payload: { category: string }) => {
    console.log('[ipc] recommend:get category=', payload.category)
    try {
      const validCategories = ['agents', 'skills', 'mcps', 'workflows', 'clis']
      if (!validCategories.includes(payload.category)) {
        console.error('[ipc] recommend:get invalid category:', payload.category)
        return []
      }
      // 生产环境从 resources/ 读取；开发环境从项目根目录 resources/ 读取
      const isDev = !app.isPackaged
      const filePath = isDev
        ? path.join(__dirname, '../../resources/author_recommend', `${payload.category}.json`)
        : path.join(process.resourcesPath, 'app.asar', 'resources', 'author_recommend', `${payload.category}.json`)
      console.log('[ipc] recommend:get reading from:', filePath)
      if (!fs.existsSync(filePath)) {
        console.warn('[ipc] recommend:get file not found:', filePath)
        return []
      }
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw)
    } catch (err) {
      console.error('[ipc] recommend:get error:', err)
      return []
    }
  })
}

// ── 后续启动：自动重扫新增项目 ───────────────────────────────────────────────

async function autoRescanProjects(): Promise<void> {
  const lastRootDir = getLastRootDir()
  if (!lastRootDir) return

  try {
    const scanned = await scanForProjects(lastRootDir)
    const existing = new Map(readProjects().map((p) => [p.id, p]))
    const newOnes: Array<{ projectId: string; claimStatus: ClaimStatus }> = []

    for (const s of scanned) {
      if (!existing.has(s.path)) {
        // 新发现的项目：默认 claimStatus=0（待确认），写入 projects.json
        const newProject: Project = {
          id: s.path,
          name: s.name,
          path: s.path,
          claimStatus: 0,
          isGitRepo: s.isGitRepo,
          activeSessionId: null,
          sessionIds: [],
          lastActiveAt: Date.now(),
        }
        upsertProject(newProject)
        newOnes.push({ projectId: s.path, claimStatus: 0 })
      }
    }

    if (newOnes.length > 0) {
      console.log(`[autoRescan] Found ${newOnes.length} new project(s), claimStatus=0`)
    }
  } catch (err) {
    console.error('[autoRescan] Failed:', err)
  }
}

// ── 初始化用户级 settings.json 默认配置（每次启动执行，合并写入不覆盖已有字段）──

function initUserSettings(): void {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  const tmpPath      = settingsPath + '.tmp'
  const defaults: Record<string, unknown> = {
    outputStyle: 'Explanatory',
  }

  let existing: Record<string, unknown> = {}
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    } catch {
      console.warn('[initUserSettings] Failed to parse existing settings.json, using defaults only')
    }
  }

  // defaults 为基底，existing 优先（不覆盖用户已有字段）
  const merged = { ...defaults, ...existing }
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8')
    fs.renameSync(tmpPath, settingsPath)
    console.log('[initUserSettings] settings.json initialized')
  } catch (err) {
    console.error('[initUserSettings] Failed to write settings.json:', err)
  }
}

// ── 启动 Hook Server（M2 S1）────────────────────────────────────────────────

async function startServices(): Promise<void> {
  // 初始化用户级默认配置（幂等，合并写入）
  initUserSettings()

  // EventBus：通过闭包延迟获取 mainWindow，确保 window 就绪后才发送
  const bus = createHookEventBus(() => mainWindow, HOOK_PORT)

  // 后续启动重扫：若之前已完成初始化且记录了 lastRootDir，自动检测新项目
  autoRescanProjects()

  try {
    await startHookServer(HOOK_PORT, {
      onHookEvent: (payload) => {
        bus.dispatchHook(payload)

        // insight / chat 临时 PTY 产生的 Hook 完全隔离：按 ptyId 识别（运行在 home 目录，不与项目冲突）
        {
          const hookPtyId = ptyManager.findSessionByCwd(payload.cwd)
            ?? claudeToPtyMap.get(payload.session_id)
          if (hookPtyId && (insightPtyIds.has(hookPtyId) || chatPtyIds.has(hookPtyId))) {
            console.log(`[chat/insight] skipping hook routing for temporary PTY (${hookPtyId})`)
            return
          }
        }
        // scheduler PTY 产生的 Hook 按 claudeId 隔离：不用 findSessionByCwd，避免同目录误过滤
        if (schedulerClaudeIds.has(payload.session_id)) {
          console.log(`[scheduler] skipping hook routing for scheduler claudeId (${payload.session_id})`)
          return
        }

        // ── 桌面通知 + 角标（PermissionRequest）────────────────────────────────
        if (payload.hook_event_name === 'PermissionRequest') {
          const p = payload as { description?: string; tool_name?: string; agent_id?: string }
          const agentLabel = p.agent_id ? `Agent (${p.agent_id.slice(0, 6)})` : '主线程'
          const desc = p.description ?? p.tool_name ?? '操作'
          NotificationService.notify('Claude Steer', `[${agentLabel}] 请求执行：${desc}`)
          NotificationService.incrementBadge()
          console.log(`[Main] PermissionRequest notification sent: ${agentLabel} / ${desc.slice(0, 40)}`)
        }

        // ── PTY ↔ Claude Code session 绑定/解绑 ───────────────────────────────
        // SessionStart：找对应 PTY，建立绑定（若 autoWatch 已早期绑定则此处是重复绑定，无害）
        if (payload.hook_event_name === 'SessionStart') {
          let ptyId = ptyManager.findSessionByCwd(payload.cwd)
          const alreadyBound = claudeToPtyMap.has(payload.session_id)
          // fallback：findSessionByCwd 可能因 cwd 编码问题（Windows GBK mojibake）返回 null，
          // 此时查找唯一未绑定的活跃 PTY 作为 fallback（单 session 场景下精确匹配）
          if (!ptyId && !alreadyBound) {
            const activeSessions = ptyManager.getActiveSessions()
            const unboundSessions = activeSessions.filter(sid => !ptyToClaudeMap.has(sid))
            if (unboundSessions.length === 1) {
              ptyId = unboundSessions[0]
              console.log(`[PtyBind] SessionStart hook: findSessionByCwd failed, using fallback unbound PTY=${ptyId}`)
            }
          }
          // 若找到的 PTY 已被其他 claudeId 绑定（如 branch session 在运行），跳过绑定
          // 此时 autoWatchTranscript 会用正确的新 PTY 建立绑定，避免破坏 branch 绑定
          const ptyAlreadyBoundToOther = ptyId ? (ptyToClaudeMap.has(ptyId) && ptyToClaudeMap.get(ptyId) !== payload.session_id) : false
          console.log(`[PtyBind] SessionStart hook: claudeId=${payload.session_id} cwd=${payload.cwd} foundPty=${ptyId ?? 'NONE'} alreadyBound=${alreadyBound} ptyBoundToOther=${ptyAlreadyBoundToOther}`)
          if (ptyId && !ptyAlreadyBoundToOther) {
            bindPtyToClaudeSession(ptyId, payload.session_id, payload.transcript_path ?? '', payload.cwd)
          } else if (ptyAlreadyBoundToOther && ptyId) {
            console.log(`[PtyBind] SessionStart hook: skipping bind, PTY ${ptyId} already bound to ${ptyToClaudeMap.get(ptyId)}, waiting for autoWatch`)
          }
        }
        // SessionEnd：解绑前先保存 ptyId（branch 检测需要，解绑后 claudeToPtyMap 条目消失）
        // 多 Agent 场景下 findSessionByCwd 会返回错误 PTY，必须在解绑前从 claudeToPtyMap 精确读取
        const ptyIdBeforeUnbind = payload.hook_event_name === 'SessionEnd'
          ? claudeToPtyMap.get(payload.session_id)
          : undefined

        // SessionEnd：解绑（若无绑定自动忽略，覆盖"branch 切走后旧 session SessionEnd"的情况）
        if (payload.hook_event_name === 'SessionEnd') {
          unbindPtyFromClaudeSession(payload.session_id)
        }

        // 快速 branch 检测：SessionEnd 携带 branch 子 session_id（Ctrl+C 强制退出后触发）
        // 兜底链路：SessionStart / Notification / Stop（适用于未发出 Ctrl+C 的情形）
        const isCandidateHook = (
          payload.hook_event_name === 'SessionEnd' ||
          payload.hook_event_name === 'SessionStart' ||
          payload.hook_event_name === 'Notification' ||
          payload.hook_event_name === 'Stop'
        )
        if (isCandidateHook) {
          // SessionEnd：用解绑前保存的 ptyId（精确，不受多 Agent 同 cwd 影响）
          // 其他 Hook：fallback 到 findSessionByCwd（兜底链路，多 Agent 场景可能仍返回错误 PTY，
          //            但这些 Hook 比 SessionEnd 晚到，此时 pendingBranchByPtySession 可能已被消费）
          const parentPtyId = ptyIdBeforeUnbind ?? ptyManager.findSessionByCwd(payload.cwd)
          if (parentPtyId && parentPtyId !== payload.session_id) {
            const branchTs = pendingBranchByPtySession.get(parentPtyId)
            if (branchTs && Date.now() - branchTs < 120_000) {
              pendingBranchByPtySession.delete(parentPtyId)
              // 冷却：30s 内阻止 stdout "Branched-conversation" 重复触发第二次 pending
              confirmedBranchPtyIds.add(parentPtyId)
              setTimeout(() => confirmedBranchPtyIds.delete(parentPtyId), 30_000)
              console.log(`[Branch] Confirmed via ${payload.hook_event_name}: child=${payload.session_id} parent_pty=${parentPtyId}`)
              // 关键：confirm SESSION_BRANCH_LINK 必须在 autoWatchTranscript 之前发送，
              // 否则 autoWatchTranscript 同步找到 JSONL 时会先发 PTY_BIND，
              // 导致渲染层在 PENDING_BIND 状态建立前就 addToRealtime，将 branch 标记为 "Agent"
              mainWindow?.webContents.send(IPC.SESSION_BRANCH_LINK, {
                sessionId: parentPtyId,
                branchSessionId: payload.session_id,
                timestamp: Date.now(),
              })
              // SessionStart hook 现已可靠触发，branch claudeId 直接从 hook 拿到
              // autoWatchTranscript 仅作兜底绑定（SessionStart hook 到达前的竞态窗口）
              autoWatchTranscript(payload.session_id, payload.cwd, branchTs, false, parentPtyId)
            }
          }
        }
      },
      onStatusLine: (data) => bus.dispatchStatusLine(data),
      onPortConflict: (port) => {
        console.error(`[Main] Port ${port} conflict detected`)
        // 通知渲染进程弹窗提示（M5 S2 实现 Modal，此处仅发送通知）
        mainWindow?.webContents.send(IPC.NOTIFICATION, {
          id: `port-conflict-${Date.now()}`,
          type: 'error',
          title: '端口冲突',
          message: `端口 ${port} 已被其他程序占用，Hook 功能不可用。请在全局设置中修改端口号。`,
          sessionId: '',
          projectId: '',
          requiresAction: false,
          resolved: false,
          createdAt: Date.now()
        })
      },
      onError: (err) => {
        console.error('[Main] Hook Server error:', err)
      }
    })

    // 生成 Windows hook 桥接 .ps1 脚本（非 Windows 平台为 no-op）
    setupHookBridge(HOOK_PORT)

    // 向 ~/.claude/settings.json 注入 Hook 配置（幂等操作）
    injectHookConfig(HOOK_PORT)

    // 生成 statusLine 桥接脚本并注入 settings.json（幂等操作）
    setupStatusLineBridge(HOOK_PORT)
  } catch (err) {
    console.error('[Main] Failed to start services:', err)
  }
}

// ── 运行时依赖检查（全部通过才放行到主界面）──────────────────────────────

async function runDependencyCheck(): Promise<boolean> {
  console.log('[Main] === Dependency check started ===')

  while (true) {
    const results = checkAllDependencies()
    const missing = results.filter(r => !r.found)

    if (missing.length === 0) {
      console.log('[Main] All dependencies OK — proceeding to main UI')
      return true
    }

    // 尝试自动修复 Claude CLI（npm 可用 + claude 是可自动安装的唯一缺失项时）
    const claudeMissing = missing.find(r => r.name === 'Claude Code CLI')
    const npmOk = results.find(r => r.name === 'npm')?.found
    const nodeOk = results.find(r => r.name === 'Node.js')?.found
    const canOnlyAutoFixClaude = missing.length === 1 && claudeMissing?.canAutoFix && npmOk && nodeOk

    if (canOnlyAutoFixClaude) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Claude Code CLI Not Found',
        message: 'Claude Code CLI was not found on your system.\n\nIt is required for claude-steer to function.',
        detail: 'Click "Install" to automatically install it via npm.',
        buttons: ['Install', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      })

      if (choice === 1) {
        app.quit()
        return false
      }

      console.log('[Main] Auto-installing Claude Code CLI...')
      const result = await autoInstallClaude()
      if (result.ok) {
        console.log('[Main] Claude CLI installed — re-checking...')
        continue // 重新检查所有依赖
      }

      // 自动安装失败
      dialog.showMessageBoxSync({
        type: 'error',
        title: 'Installation Failed',
        message: 'Failed to install Claude Code CLI automatically.',
        detail: result.message + '\n\nPlease install it manually:\nnpm install -g @anthropic-ai/claude-code\n\nThen restart the application.',
        buttons: ['Quit'],
      })
      app.quit()
      return false
    }

    // 无法自动修复 — 显示缺失清单 + 平台安装命令 + 下载链接
    const parts = missing.map(r => {
      let line = `• ${r.name}`
      if (r.version) line += ` (found v${r.version}, need v18+)`
      if (r.error) line += `\n  ${r.error.replace(/\n/g, '\n  ')}`
      if (r.installHint) line += `\n  Run: ${r.installHint.replace(/\n/g, '\n       ')}`
      if (r.manualUrl) line += `\n  Or download: ${r.manualUrl}`
      return line
    })

    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Missing Dependencies',
      message: `${missing.length} required tool(s) not found:\n\n${parts.join('\n\n')}`,
      detail: 'Please install the missing tools, then click "Retry" to re-check.\n\nThe application cannot start until all dependencies are available.',
      buttons: ['Retry', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    })

    if (choice === 1) {
      app.quit()
      return false
    }
    // Retry → loop back to re-check ALL dependencies
  }
}

// ── 应用生命周期────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // ── 初始化文件日志（最早执行，捕获所有后续 log）───────────────
  ensureLogDir()
  // 每次启动清空 latest.log
  try { fs.writeFileSync(LOG_LATEST_FILE, '', 'utf-8') } catch { /* ignore */ }
  // 覆盖 console 方法，同时写入文件和 stdout
  const _origLog   = console.log.bind(console)
  const _origWarn  = console.warn.bind(console)
  const _origError = console.error.bind(console)
  const _origDebug = console.debug.bind(console)
  console.log   = (...args: unknown[]) => { const msg = args.map(String).join(' '); _origLog(...args); appendToLogFile('LOG', msg) }
  console.warn  = (...args: unknown[]) => { const msg = args.map(String).join(' '); _origWarn(...args); appendToLogFile('WARN', msg) }
  console.error = (...args: unknown[]) => { const msg = args.map(String).join(' '); _origError(...args); appendToLogFile('ERROR', msg) }
  console.debug = (...args: unknown[]) => { const msg = args.map(String).join(' '); _origDebug(...args); appendToLogFile('DEBUG', msg) }
  console.log(`[Main] Log file: ${LOG_SESSION_FILE}`)
  console.log(`[Main] Latest log: ${LOG_LATEST_FILE}`)

  // ── macOS Dock 启动 PATH 修复 ──────────────────────────────────────────────
  // Dock/Launchpad 启动的 GUI app 只继承 launchd 的最小 PATH (/usr/bin:/bin)，
  // 不包含 nvm/Homebrew 安装的 claude、git 等命令路径。
  // 读取 shell 配置文件恢复完整 PATH，避免 "command not found"。
  if (process.platform === 'darwin') {
    const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin']
    const shellPath = process.env.SHELL || '/bin/zsh'
    try {
      const shellRc = shellPath.includes('zsh') ? '.zshrc' : '.bash_profile'
      const rcPath = path.join(os.homedir(), shellRc)
      if (fs.existsSync(rcPath)) {
        const rcContent = fs.readFileSync(rcPath, 'utf-8')
        const pathMatch = rcContent.match(/export\s+PATH=["']?([^"'\n]+)["']?/)
        if (pathMatch) {
          process.env.PATH = [pathMatch[1], ...extraPaths, process.env.PATH]
            .filter(Boolean)
            .join(path.delimiter)
          console.log(`[Main] PATH restored from ${shellRc}`)
        }
      }
      // shell rc 未匹配到 export PATH 时，至少追加 Homebrew 路径
      if (!process.env.PATH?.includes('/opt/homebrew/bin')) {
        process.env.PATH = [...extraPaths, process.env.PATH].join(path.delimiter)
      }
    } catch {
      // shell rc 读取失败时仍然追加 Homebrew 路径
      process.env.PATH = [...extraPaths, process.env.PATH].join(path.delimiter)
      console.log('[Main] PATH augmented with Homebrew fallback')
    }
  }

  // ── Claude Code 初始化配置 ────────────────────────────────────────────────
  // .claude.json 中 hasCompletedOnboarding=true 是 Claude Code 正常运行的前提
  // 不加的话 Claude Code 会有地区检测，始终不可用
  ensureOnboardingCompleted()

  // ── node-pty 原生模块自检 ──────────────────────────────────────────────────
  try {
    require('node-pty')
    console.log('[Main] node-pty loaded OK')
  } catch (err) {
    console.error('[Main] node-pty load FAILED:', err)
    dialog.showErrorBox(
      '原生模块加载失败',
      'node-pty 未正确编译。请执行:\n\nnpm run postinstall\n\n然后重新启动应用。'
    )
  }

  // ── 运行时依赖检查（全部通过才放行到主界面）─────────────────────────────
  const depsOk = await runDependencyCheck()
  if (!depsOk) return  // 用户选择退出

  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createWindow()
  initUpdater(mainWindow!)
  await startServices()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
