// 使用方法：import { PtyManager } from './lib/pty/PtyManager'
//           const manager = new PtyManager(bus)
//           manager.startSession({ sessionId, projectPath, permissionMode, onData, onExit })
// 编译说明：主进程 Node.js 模块，node-pty 已针对 Electron 39 重编
// 代码说明：node-pty 进程管理器——维护多个并发 Claude session 的 PTY 实例
//           每个 session 包含心跳检测（10s）和超时自动关闭（30min）
//           调试可见输出：onData 中加 process.stdout.write(data) 即可在 npm run dev 终端看到原始输出

import pty from 'node-pty'
import { execSync } from 'child_process'
import { readClaudeEnvBlock } from '../config/SettingsManager'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { HEARTBEAT_INTERVAL_MS, PTY_TIMEOUT_MS } from '../../../shared/constants/index'
import type { SessionStatus, PermissionMode } from '../../../shared/types/index'

/**
 * 解析 claude 二进制文件的绝对路径
 * Electron 进程的 PATH 可能不包含 nvm 管理的 node 版本目录，
 * 导致 execvp(3) failed: No such file or directory
 */
export function resolveClaudeBin(): string {
  // ── Windows 路径 ──────────────────────────────────────────────────────
  if (process.platform === 'win32') {
    // 1. where claude（Windows 版 which）
    try {
      const whereResult = execSync('where claude', { encoding: 'utf-8', timeout: 3000 }).trim()
      const lines = whereResult.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      // 优先选择 Windows 可执行扩展名（.cmd/.exe/.ps1），避免选到 npm 生成的 POSIX shell 脚本
      const WIN_EXTS = ['.cmd', '.exe', '.ps1']
      const bestMatch = lines.find(l => {
        if (!fs.existsSync(l)) return false
        const ext = path.extname(l).toLowerCase()
        return WIN_EXTS.includes(ext)
      }) ?? lines.find(l => fs.existsSync(l))
      if (bestMatch) {
        console.log(`[PtyManager] claude found via where: ${bestMatch}`)
        return bestMatch
      }
    } catch { /* where 失败，继续 */ }

    // 2. npm 全局安装路径（%APPDATA%\npm\claude.cmd）
    const npmGlobal = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm')
    for (const ext of ['.cmd', '.ps1', '']) {
      const candidate = path.join(npmGlobal, `claude${ext}`)
      if (fs.existsSync(candidate)) {
        console.log(`[PtyManager] claude found via npm global: ${candidate}`)
        return candidate
      }
    }

    // 3. nvm-windows 路径（%APPDATA%\nvm\*\node_modules\.bin\claude.cmd）
    const nvmWinDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'nvm')
    try {
      const versions = fs.readdirSync(nvmWinDir).filter(d => /^v?\d/.test(d)).sort().reverse()
      for (const ver of versions) {
        for (const ext of ['.cmd', '.ps1', '']) {
          const candidate = path.join(nvmWinDir, ver, 'node_modules', '.bin', `claude${ext}`)
          if (fs.existsSync(candidate)) {
            console.log(`[PtyManager] claude found via nvm-windows: ${candidate}`)
            return candidate
          }
        }
      }
    } catch { /* nvm-windows 目录不存在 */ }

    // 4. 兜底：claude.cmd，让 node-pty 按 PATH + PATHEXT 搜索
    console.warn('[PtyManager] claude binary not found on Windows, falling back to "claude.cmd"')
    return 'claude.cmd'
  }

  // ── macOS / Linux 路径（原有逻辑不变）───────────────────────────────
  // 1. 尝试从 PATH 中查找
  try {
    const whichResult = execSync('which claude', { encoding: 'utf-8', timeout: 3000 }).trim()
    if (whichResult && fs.existsSync(whichResult)) {
      // 解析 symlink 得到真实路径
      const realPath = fs.realpathSync(whichResult)
      console.log(`[PtyManager] claude found via which: ${whichResult} -> ${realPath}`)
      return realPath
    }
  } catch { /* which 失败，继续 */ }

  // 2. 遍历 ~/.nvm/versions/node/*/bin/claude
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
  try {
    const versions = fs.readdirSync(nvmDir).sort().reverse() // 优先新版本
    for (const ver of versions) {
      const candidate = path.join(nvmDir, ver, 'bin', 'claude')
      if (fs.existsSync(candidate)) {
        console.log(`[PtyManager] claude found in nvm: ${candidate}`)
        return candidate
      }
    }
  } catch { /* nvm 目录不存在 */ }

  // 3. Homebrew Apple Silicon 路径（M1/M2/M3/M4 Mac）
  const homebrewSilicon = '/opt/homebrew/bin/claude'
  if (fs.existsSync(homebrewSilicon)) {
    const realPath = fs.realpathSync(homebrewSilicon)
    console.log(`[PtyManager] claude found via Homebrew (Apple Silicon): ${homebrewSilicon} -> ${realPath}`)
    return realPath
  }

  // 4. Homebrew Intel Mac 路径
  const homebrewIntel = '/usr/local/bin/claude'
  if (fs.existsSync(homebrewIntel)) {
    const realPath = fs.realpathSync(homebrewIntel)
    console.log(`[PtyManager] claude found via Homebrew (Intel): ${homebrewIntel} -> ${realPath}`)
    return realPath
  }

  // 5. 兜底：返回 'claude'，让 execvp 按 PATH 搜索（可能会失败）
  console.warn('[PtyManager] claude binary not found, falling back to "claude" in PATH')
  return 'claude'
}

/** 启动时解析一次，所有 session 共用；auto-install 后可通过 refreshClaudeBin() 刷新 */
let CLAUDE_BIN = resolveClaudeBin()
console.log(`[PtyManager] Resolved claude binary: ${CLAUDE_BIN}`)

/** 重新搜索 claude 二进制（依赖自动安装后调用） */
export function refreshClaudeBin(): string {
  CLAUDE_BIN = resolveClaudeBin()
  console.log(`[PtyManager] Refreshed claude binary: ${CLAUDE_BIN}`)
  return CLAUDE_BIN
}

/** 获取当前解析的 claude 二进制路径 */
export function getClaudeBin(): string {
  return CLAUDE_BIN
}

export interface PtyStartOptions {
  sessionId: string
  projectPath: string
  permissionMode: PermissionMode
  model?: string
  /** 收到 stdout 数据时的回调（含 ANSI 控制码） */
  onData: (sessionId: string, data: string) => void
  /** 进程退出时的回调 */
  onExit: (sessionId: string, exitCode: number) => void
}

interface PtyInstance {
  pty: pty.IPty
  sessionId: string
  projectPath: string
  status: SessionStatus
  /** 最后一次交互时间戳（用于超时检测） */
  lastActivityAt: number
  heartbeatTimer: ReturnType<typeof setInterval> | null
  timeoutTimer: ReturnType<typeof setTimeout> | null
}

/** 将 PermissionMode 转为 Claude CLI 参数 */
function permissionModeToArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case 'acceptEdits':        return ['--allowedTools', 'Edit,Write,MultiEdit']
    case 'plan':               return ['--plan']
    case 'auto':               return ['--dangerously-skip-permissions']
    case 'bypassPermissions':  return ['--dangerously-skip-permissions']
    case 'dontAsk':            return ['--output-format', 'stream-json']
    case 'default':
    default:                   return []
  }
}

export class PtyManager {
  private sessions = new Map<string, PtyInstance>()

  /**
   * 启动新的 Claude PTY session
   * @throws 如果 sessionId 已存在则抛出错误
   */
  startSession(opts: PtyStartOptions): void {
    const args = [
      '--output-format', 'stream-json',
      ...permissionModeToArgs(opts.permissionMode),
      ...(opts.model ? ['--model', opts.model] : [])
    ]
    this._spawnSession(opts, args)
  }

  /**
   * 构建 PTY 进程的环境变量：
   *   process.env 为基底 → 剥离宿主机级 Anthropic 变量（防止静默覆盖 provider 配置）
   *   → 合并 settings.json 的 env 块（provider 配置优先级最高）→ 追加 TERM
   */
  private _buildPtyEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> }

    // 剥离宿主机已有 Anthropic 变量，确保 settings.json 的 provider 配置优先生效
    const STRIP_KEYS = [
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
      'API_TIMEOUT_MS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    ]
    for (const k of STRIP_KEYS) {
      delete env[k]
    }

    // 合并 settings.json 中的 provider env 块
    const providerEnv = readClaudeEnvBlock()
    Object.assign(env, providerEnv)

    env.TERM = 'xterm-256color'

    if (Object.keys(providerEnv).length > 0) {
      console.log(`[PtyManager] Injected provider env: ANTHROPIC_BASE_URL=${providerEnv.ANTHROPIC_BASE_URL ?? 'default'} ANTHROPIC_MODEL=${providerEnv.ANTHROPIC_MODEL ?? 'default'}`)
    }
    return env
  }

  /**
   * 内部：根据给定参数 spawn PTY 进程并注册 session
   * startSession 和 resumeSession 共用此逻辑
   */
  private _spawnSession(opts: PtyStartOptions, args: string[]): void {
    if (this.sessions.has(opts.sessionId)) {
      throw new Error(`[PtyManager] Session ${opts.sessionId} already exists`)
    }

    console.log(`[PtyManager] Starting session ${opts.sessionId} in ${opts.projectPath}`)
    console.log(`[PtyManager] claude args: ${args.join(' ')}`)

    const ptyProcess = pty.spawn(CLAUDE_BIN, args, {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: opts.projectPath,
      env: this._buildPtyEnv(),
    })

    const instance: PtyInstance = {
      pty: ptyProcess,
      sessionId: opts.sessionId,
      projectPath: opts.projectPath,
      status: 'Running',
      lastActivityAt: Date.now(),
      heartbeatTimer: null,
      timeoutTimer: null
    }

    ptyProcess.onData((data) => {
      // 调试：捕获 PTY 原始输出
      console.log(`[PtyManager:RAW] session=${opts.sessionId} data=${JSON.stringify(data.slice(0, 200))}`)
      instance.lastActivityAt = Date.now()
      this.resetTimeoutTimer(instance, opts)
      opts.onData(opts.sessionId, data)
    })

    // 进程退出回调
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[PtyManager] Session ${opts.sessionId} exited with code ${exitCode}`)
      this.clearTimers(instance)
      instance.status = exitCode === 0 ? 'Completed' : 'Interrupted'
      opts.onExit(opts.sessionId, exitCode ?? 0)
      this.sessions.delete(opts.sessionId)
    })

    // 启动心跳检测（每 10s）
    instance.heartbeatTimer = setInterval(() => {
      this.checkHeartbeat(instance, opts)
    }, HEARTBEAT_INTERVAL_MS)

    // 启动超时计时器（30min）
    instance.timeoutTimer = setTimeout(() => {
      console.log(`[PtyManager] Session ${opts.sessionId} timed out after 30min`)
      this.stopSession(opts.sessionId)
    }, PTY_TIMEOUT_MS)

    this.sessions.set(opts.sessionId, instance)
  }

  /**
   * 启动裸 PTY session，args 完全由调用方指定（不走 permissionModeToArgs）
   * 用于 insight 等临时工具 session，避免混入正常项目 session 逻辑
   */
  startBare(opts: PtyStartOptions, args: string[]): void {
    this._spawnSession(opts, args)
  }

  /**
   * 启动任意命令的 PTY session（不限于 CLAUDE_BIN）
   * 用于 cc-connect start 等非 Claude CLI 的长期运行服务
   * 不设置 30 分钟超时，仅保留心跳检测
   */
  startCommand(opts: PtyStartOptions, command: string, args: string[]): void {
    this._spawnSessionWithCommand(opts, command, args)
  }

  /**
   * 内部：spawn 任意命令的 PTY session（不限于 CLAUDE_BIN）
   * 与 _spawnSession 逻辑一致，但使用自定义 command 且不设 30min 超时
   */
  private _spawnSessionWithCommand(opts: PtyStartOptions, command: string, args: string[]): void {
    if (this.sessions.has(opts.sessionId)) {
      throw new Error(`[PtyManager] Session ${opts.sessionId} already exists`)
    }

    console.log(`[PtyManager] Starting command session ${opts.sessionId} in ${opts.projectPath}`)
    console.log(`[PtyManager] command: ${command} ${args.join(' ')}`)

    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: opts.projectPath,
      env: this._buildPtyEnv(),
    })

    const instance: PtyInstance = {
      pty: ptyProcess,
      sessionId: opts.sessionId,
      projectPath: opts.projectPath,
      status: 'Running',
      lastActivityAt: Date.now(),
      heartbeatTimer: null,
      timeoutTimer: null
    }

    ptyProcess.onData((data) => {
      console.log(`[PtyManager:RAW] session=${opts.sessionId} data=${JSON.stringify(data.slice(0, 200))}`)
      instance.lastActivityAt = Date.now()
      opts.onData(opts.sessionId, data)
    })

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[PtyManager] Command session ${opts.sessionId} exited with code ${exitCode}`)
      this.clearTimers(instance)
      instance.status = exitCode === 0 ? 'Completed' : 'Interrupted'
      opts.onExit(opts.sessionId, exitCode ?? 0)
      this.sessions.delete(opts.sessionId)
    })

    // 仅启动心跳检测（每 10s），不设超时（长期运行服务）
    instance.heartbeatTimer = setInterval(() => {
      this.checkHeartbeat(instance, opts)
    }, HEARTBEAT_INTERVAL_MS)

    this.sessions.set(opts.sessionId, instance)
  }

  /**
   * 恢复历史 session（claude --resume <sessionId>）
   */
  resumeSession(opts: PtyStartOptions & { resumeSessionId: string }): void {
    const args = [
      '--resume', opts.resumeSessionId,
      '--output-format', 'stream-json',
      ...permissionModeToArgs(opts.permissionMode),
      ...(opts.model ? ['--model', opts.model] : [])
    ]
    this._spawnSession(opts, args)
  }

  /**
   * 向 session stdin 写入文本
   * @param text 消息内容（行尾使用 \r，PTY 标准）
   */
  writeToSession(sessionId: string, text: string): void {
    const instance = this.sessions.get(sessionId)
    if (!instance) {
      console.warn(`[PtyManager] writeToSession: session ${sessionId} not found`)
      return
    }
    // PTY stdin 行尾必须是 \r（回车），\n 在某些终端环境下不触发执行
    const normalized = text.endsWith('\r') ? text : text + '\r'
    instance.pty.write(normalized)
    instance.lastActivityAt = Date.now()
    this.resetTimeoutTimer(instance, { sessionId, onExit: () => {} })
  }

  /**
   * 向 session stdin 写入原始字节（不追加 \r）
   * 用于发送控制字符（如 Ctrl+C = \x03）或已包含完整行尾的命令
   */
  rawWrite(sessionId: string, text: string): void {
    const instance = this.sessions.get(sessionId)
    if (!instance) {
      console.warn(`[PtyManager] rawWrite: session ${sessionId} not found`)
      return
    }
    instance.pty.write(text)
    instance.lastActivityAt = Date.now()
  }

  /**
   * 停止 session（SIGTERM → 1s 后 SIGKILL）
   */
  stopSession(sessionId: string): void {
    const instance = this.sessions.get(sessionId)
    if (!instance) {
      console.warn(`[PtyManager] stopSession: session ${sessionId} not found`)
      return
    }

    console.log(`[PtyManager] Stopping session ${sessionId}`)
    this.clearTimers(instance)
    instance.status = 'Interrupted'

    try {
      instance.pty.kill('SIGTERM')
      // 1s 后确认终止（进程可能忽略 SIGTERM）
      setTimeout(() => {
        try {
          instance.pty.kill('SIGKILL')
        } catch {
          // 进程可能已经退出，忽略错误
        }
      }, 1000)
    } catch (err) {
      console.error(`[PtyManager] Error stopping session ${sessionId}:`, err)
    }
  }

  /** 通过项目路径查找 PTY session ID（跨平台路径分隔符归一化） */
  findSessionByCwd(cwd: string): string | null {
    const nCwd = cwd.replace(/\\/g, '/')
    for (const [sessionId, instance] of this.sessions) {
      const nProj = instance.projectPath.replace(/\\/g, '/')
      if (nCwd === nProj || nCwd.startsWith(nProj + '/')) {
        return sessionId
      }
    }
    return null
  }

  /** 获取 session 状态 */
  getStatus(sessionId: string): SessionStatus | null {
    return this.sessions.get(sessionId)?.status ?? null
  }

  /** 获取所有活跃 session ID */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys())
  }

  /** 停止所有 session（应用退出时调用） */
  stopAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.stopSession(sessionId)
    }
  }

  /**
   * 调整 PTY 终端尺寸（由独立终端窗口的 xterm.js 在 resize 时调用）
   */
  resizeSession(sessionId: string, cols: number, rows: number): void {
    const instance = this.sessions.get(sessionId)
    if (!instance) {
      console.warn(`[PtyManager] resizeSession: session ${sessionId} not found`)
      return
    }
    instance.pty.resize(Math.max(cols, 20), Math.max(rows, 5))
  }

  // ── 内部工具方法 ────────────────────────────────────────────────────────

  private checkHeartbeat(instance: PtyInstance, opts: PtyStartOptions): void {
    try {
      // process.kill(pid, 0) 不发送真实信号，只检测进程是否存在
      process.kill(instance.pty.pid, 0)
    } catch {
      // 进程已不存在
      console.warn(`[PtyManager] Heartbeat failed for session ${instance.sessionId}`)
      this.clearTimers(instance)
      instance.status = 'Interrupted'
      opts.onExit(instance.sessionId, -1)
      this.sessions.delete(instance.sessionId)
    }
  }

  private resetTimeoutTimer(instance: PtyInstance, opts: { sessionId: string; onExit: (id: string, code: number) => void }): void {
    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer)
    }
    instance.timeoutTimer = setTimeout(() => {
      console.log(`[PtyManager] Session ${opts.sessionId} timed out (30min inactivity)`)
      this.stopSession(opts.sessionId)
    }, PTY_TIMEOUT_MS)
  }

  private clearTimers(instance: PtyInstance): void {
    if (instance.heartbeatTimer) {
      clearInterval(instance.heartbeatTimer)
      instance.heartbeatTimer = null
    }
    if (instance.timeoutTimer) {
      clearTimeout(instance.timeoutTimer)
      instance.timeoutTimer = null
    }
  }
}
