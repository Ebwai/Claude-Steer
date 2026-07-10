// 使用方法：import { injectHookConfig, readClaudeSettings, readAllConfigGroups } from './lib/config/SettingsManager'
// 编译说明：主进程 Node.js 模块
// 代码说明：~/.claude/settings.json 读写工具 + 全局配置分组读取（agents/skills/hooks/tools/mcp）

import fs from 'fs'
import path from 'path'
import os from 'os'
import type { HookEventName } from '../../../shared/types/index'
import { readGlobalMcpServers } from './ClaudeJsonManager'

// ── 路径常量 ──────────────────────────────────────────────────────────────────

import { DRIVER_CONFIG_DIRNAME } from '../../../shared/constants/index'

const CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude')
const DRIVER_CONFIG_DIR = path.join(os.homedir(), DRIVER_CONFIG_DIRNAME)
const SETTINGS_PATH = path.join(CLAUDE_CONFIG_DIR, 'settings.json')
const SETTINGS_TMP_PATH = path.join(CLAUDE_CONFIG_DIR, 'settings.json.tmp')
const PLUGINS_INSTALLED_PATH = path.join(CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json')
const USER_AGENTS_DIR = path.join(CLAUDE_CONFIG_DIR, 'agents')
const USER_SKILLS_DIR = path.join(CLAUDE_CONFIG_DIR, 'skills')

// ── 内部 settings.json 类型 ───────────────────────────────────────────────────

/** 仪表盘注册的 Hook 事件类型（与 Claude Code 文档对齐） */
const HOOK_EVENT_TYPES: HookEventName[] = [
  'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd',
  'PreCompact', 'PostCompact',
  'PermissionRequest', 'PermissionDenied',
]

type SettingsHookEntry = { type: string; url?: string; command?: string }
type SettingsHookMatcher = { hooks?: SettingsHookEntry[]; command?: string; matcher?: string }

/** Claude Code v2.x+ statusLine 要求 object 格式，不接受 string */
type StatusLineConfig = { type: 'command'; command: string; refreshInterval?: number }

type ClaudeSettings = {
  hooks?: Record<string, SettingsHookMatcher[]>
  statusLine?: StatusLineConfig | string
  enabledPlugins?: Record<string, boolean>
  mcpServers?: Record<string, unknown>
  allowedTools?: string[]
  disallowedTools?: string[]
  env?: Record<string, string>
  [key: string]: unknown
}

// ── 公开 Export 类型 ──────────────────────────────────────────────────────────

/** 通用分组容器 */
export interface ItemGroup<T> {
  /** 展示标签："内置 (Claude Code)" / "个人" / "superpowers" */
  label: string
  source: 'builtin' | 'user' | 'plugin'
  /** 完整插件 ID，如 "superpowers@superpowers-dev"（source=plugin 时有值） */
  pluginId?: string
  items: T[]
}

export interface AgentItem { name: string; model: string }
export interface SkillItem  { name: string; description?: string; dirName?: string }
export interface HookItem   { event: string; name: string }
export interface ToolItem   { name: string }
export interface McpItem    { name: string }

export interface AllConfigGroups {
  agentGroups: ItemGroup<AgentItem>[]
  skillGroups: ItemGroup<SkillItem>[]
  hookGroups:  ItemGroup<HookItem>[]
  toolGroups:  ItemGroup<ToolItem>[]
  mcpGroups:   ItemGroup<McpItem>[]
}

// ── 内部 Plugin 注册表类型 ────────────────────────────────────────────────────

interface InstalledPluginRecord {
  scope: 'user' | 'local'
  installPath: string
  version: string
  projectPath?: string
}

interface InstalledPluginsFile {
  version: number
  plugins: Record<string, InstalledPluginRecord[]>
}

interface PluginMeta {
  id: string          // "superpowers@superpowers-dev"
  shortName: string   // "superpowers"（从 package.json name 字段读取）
  installPath: string
}

// ── 基础 settings.json 读写 ───────────────────────────────────────────────────

/** 读取 ~/.claude/settings.json，不存在时返回空对象 */
export function readClaudeSettings(): ClaudeSettings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as ClaudeSettings
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[SettingsManager] Failed to read settings.json:', err)
    }
    return {}
  }
}

/** 原子写入 ~/.claude/settings.json（write-tmp + rename） */
export function writeClaudeSettings(data: ClaudeSettings): void {
  try {
    fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(SETTINGS_TMP_PATH, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(SETTINGS_TMP_PATH, SETTINGS_PATH)
  } catch (err) {
    console.error('[SettingsManager] Failed to write settings.json:', err)
    throw err
  }
}

// ── Provider env 块读写 ────────────────────────────────────────────────────

/** 读取 settings.json 中的 env 块，无则返回 {} */
export function readClaudeEnvBlock(): Record<string, string> {
  const settings = readClaudeSettings()
  if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) {
    return { ...settings.env }
  }
  return {}
}

/** 合并写入 settings.json 的 env 块（保留其他字段不变） */
export function writeClaudeEnvBlock(env: Record<string, string>): void {
  const settings = readClaudeSettings()
  settings.env = { ...(settings.env ?? {}), ...env }
  writeClaudeSettings(settings)
}

/** 删除 settings.json 中的 env 块（切回 Anthropic 官方时调用） */
export function removeClaudeEnvBlock(): void {
  const settings = readClaudeSettings()
  delete settings.env
  writeClaudeSettings(settings)
  console.log('[SettingsManager] Removed env block from settings.json')
}

// ── Hook Bridge 脚本（Windows PowerShell 版）───────────────────────────────────

const HOOK_BRIDGE_SCRIPT = 'hook-bridge.ps1'

/** 生成 Windows hook 桥接 .ps1 脚本：读取 stdin JSON，POST 到 hook server */
function generateHookWindowsScript(port: number): string {
  const hookUrl = `http://127.0.0.1:${port}/hooks`
  return `# Claude Steer Hook Bridge (Windows PowerShell)
# 由 Claude Code 在触发 hook 事件时自动调用，将 stdin JSON 转发到仪表盘 hook server
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$body = [Console]::In.ReadToEnd()
try {
  Invoke-RestMethod -Uri '${hookUrl}' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
} catch {}
`
}

/**
 * 生成/更新 Windows hook 桥接 .ps1 脚本，返回 settings.json 中注册的命令字符串
 * 非 Windows 平台为 no-op（返回空字符串）
 */
export function setupHookBridge(port: number): string {
  if (process.platform !== 'win32') return ''
  fs.mkdirSync(DRIVER_CONFIG_DIR, { recursive: true })
  const scriptPath = path.join(DRIVER_CONFIG_DIR, HOOK_BRIDGE_SCRIPT)
  fs.writeFileSync(scriptPath, generateHookWindowsScript(port), { encoding: 'utf-8' })
  console.log(`[SettingsManager] Hook bridge script written: ${scriptPath}`)
  return `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`
}

function buildHookCommand(hookUrl: string): string {
  if (process.platform === 'win32') {
    // Windows: 使用独立 .ps1 脚本文件（用 -File 执行，[Console]::In 可正确读取 stdin）
    // 注意：setupHookBridge() 必须在 injectHookConfig() 之前调用以生成脚本文件
    return `powershell -ExecutionPolicy Bypass -File "${path.join(DRIVER_CONFIG_DIR, HOOK_BRIDGE_SCRIPT)}"`
  }
  // macOS/Linux: curl 读取 stdin 转发到本地 HTTP server
  return `curl -s -X POST ${hookUrl} -H 'Content-Type: application/json' -d @-`
}

export function injectHookConfig(port: number): void {
  const hookUrl = `http://127.0.0.1:${port}/hooks`
  const hookCommand = buildHookCommand(hookUrl)
  const settings = readClaudeSettings()
  if (!settings.hooks) settings.hooks = {}

  /**
   * 判断某个 hook 条目是否为仪表盘注入的 hook（所有平台格式统一识别）
   * 覆盖：
   *   - curl 格式（macOS/Linux）：curl ... http://127.0.0.1:PORT/hooks ...
   *   - PowerShell .ps1 桥接脚本（Windows）：powershell ... hook-bridge.ps1
   *   - 旧 PowerShell 内联格式：[Console]::In.ReadToEnd / $input | Out-String
   *   - 旧 http 格式：{ type: 'http', url: 'http://127.0.0.1:PORT/hooks' }
   *
   * 跨平台迁移（如从 Mac 切到 Windows）会产生不同格式并存，Claude Code 对所有
   * matcher 都会执行，导致 hook 事件 × N。此函数统一识别后清理，确保每个事件
   * 只有当前平台的一条 hook。
   */
  function isOwnDashboardHook(h: { type?: string; url?: string; command?: string }): boolean {
    if (h.type === 'http' && h.url?.includes('127.0.0.1:' + port + '/hooks')) {
      return true
    }
    if (h.type === 'command' && typeof h.command === 'string') {
      // curl 格式（所有平台可能残留）
      if (h.command.startsWith('curl ') && h.command.includes('127.0.0.1:' + port + '/hooks')) {
        return true
      }
      // 当前平台 .ps1 桥接脚本
      if (h.command.includes(HOOK_BRIDGE_SCRIPT)) {
        return true
      }
      // 旧 PowerShell 内联格式
      if (h.command.includes('[Console]::In.ReadToEnd') ||
          h.command.includes('$input | Out-String')) {
        return true
      }
    }
    return false
  }

  let changed = false
  for (const eventType of HOOK_EVENT_TYPES) {
    if (!settings.hooks[eventType]) settings.hooks[eventType] = []
    let matchers = settings.hooks[eventType]

    // 清理所有旧格式仪表盘 hook（跨平台迁移会残留多套格式）
    const cleanedMatchers: SettingsHookMatcher[] = []
    for (const m of matchers) {
      if (m.hooks) {
        const remaining = m.hooks.filter(h => {
          if (isOwnDashboardHook(h)) {
            const format = h.type === 'http' ? 'http' :
              h.command?.startsWith('curl ') ? 'curl' :
              h.command?.includes(HOOK_BRIDGE_SCRIPT) ? 'ps1' : 'old-ps'
            console.log(`[SettingsManager] Removing stale dashboard hook (${format}): ${eventType}`)
            changed = true
            return false
          }
          return true
        })
        if (remaining.length > 0) {
          cleanedMatchers.push({ ...m, hooks: remaining })
        } else {
          changed = true
        }
      } else {
        cleanedMatchers.push(m)
      }
    }
    matchers = cleanedMatchers
    settings.hooks[eventType] = matchers

    // 注入当前平台的 hook 命令
    const alreadyInjected = matchers.some(m =>
      m.hooks?.some(h => h.type === 'command' && h.command === hookCommand)
    )
    if (!alreadyInjected) {
      matchers.push({ hooks: [{ type: 'command', command: hookCommand }] })
      changed = true
    }
  }

  if (changed) {
    writeClaudeSettings(settings)
    console.log(`[SettingsManager] Hook config injected for port ${port} (platform=${process.platform})`)
  } else {
    console.log(`[SettingsManager] Hook config already present for port ${port}, skipping`)
  }
}

export function removeHookConfig(port: number): void {
  const hookUrl = `http://127.0.0.1:${port}/hooks`
  const hookCommand = buildHookCommand(hookUrl)
  const settings = readClaudeSettings()
  if (!settings.hooks) return

  let changed = false
  for (const eventType of HOOK_EVENT_TYPES) {
    const matchers = settings.hooks[eventType]
    if (!matchers) continue
    const filtered = matchers
      .map(m => ({
        ...m,
        hooks: m.hooks?.filter(h => {
          // 清理旧的 http 格式（兼容升级前残留）
          if (h.type === 'http' && h.url === hookUrl) return false
          // 清理 command 格式：精确匹配（当前 .ps1 文件格式）+ 旧 PowerShell 格式
          if (h.type === 'command' && typeof h.command === 'string') {
            if (h.command === hookCommand) return false
            if (process.platform === 'win32' && (
              h.command.includes('$input | Out-String') ||
              h.command.includes('[Console]::In.ReadToEnd')
            )) return false
          }
          return true
        }) ?? []
      }))
      .filter(m => (m.hooks?.length ?? 0) > 0 || m.command)
    if (filtered.length !== matchers.length) {
      settings.hooks[eventType] = filtered
      changed = true
    }
  }

  if (changed) {
    writeClaudeSettings(settings)
    console.log(`[SettingsManager] Hook config removed for port ${port}`)
  }
}

/**
 * 从单个 settings 对象中提取指定事件的用户自定义 hook 命令（排除仪表盘 curl 命令）
 */
function isDashboardHook(command: string, dashboardUrl: string): boolean {
  if (command.includes(dashboardUrl)) return true
  // Windows: 仪表盘注入的 hook 是 .ps1 桥接脚本，URL 藏在脚本内部，命令本身不含 dashboardUrl
  if (command.includes(HOOK_BRIDGE_SCRIPT)) return true
  return false
}

function extractUserHooks(
  settings: ClaudeSettings,
  eventName: string,
  dashboardUrl: string,
): string[] {
  const matchers = settings.hooks?.[eventName] ?? []
  const result: string[] = []
  for (const m of matchers) {
    if (m.command && !isDashboardHook(m.command, dashboardUrl)) result.push(m.command)
    for (const h of m.hooks ?? []) {
      if (!h.command || isDashboardHook(h.command, dashboardUrl)) continue
      result.push(h.command)
    }
  }
  return result
}

/**
 * 返回指定 hook 事件下用户自定义的 command 列表（排除仪表盘注入的 curl 转发命令）
 * 同时读取全局 ~/.claude/settings.json 和项目级 <cwd>/.claude/settings.json，合并去重
 */
export function getUserHooksForEvent(eventName: string, port: number, cwd?: string): string[] {
  const dashboardUrl = `http://127.0.0.1:${port}/hooks`
  const result: string[] = []

  // 全局配置
  const globalSettings = readClaudeSettings()
  result.push(...extractUserHooks(globalSettings, eventName, dashboardUrl))

  // 项目级配置
  if (cwd) {
    const projectSettingsPath = path.join(cwd, '.claude', 'settings.json')
    try {
      const raw = fs.readFileSync(projectSettingsPath, 'utf-8')
      const projectSettings = JSON.parse(raw) as ClaudeSettings
      result.push(...extractUserHooks(projectSettings, eventName, dashboardUrl))
    } catch {
      // 项目无 settings.json 或解析失败，静默忽略
    }
  }

  // 去重（同一命令在全局和项目级都配置的情况）
  return [...new Set(result)]
}

// ── statusLine 注入 ────────────────────────────────────────────────────────────

export function injectStatusLineConfig(scriptPath: string): void {
  const settings = readClaudeSettings()
  const target: StatusLineConfig = { type: 'command', command: scriptPath }
  const current = settings.statusLine

  if (current && typeof current === 'object' && current.type === 'command' && current.command === scriptPath) {
    console.log('[SettingsManager] statusLine already configured (object format), skipping')
    return
  }

  settings.statusLine = target
  writeClaudeSettings(settings)
  console.log(`[SettingsManager] statusLine configured (object format): ${scriptPath}`)
}

// ── 内部工具函数 ───────────────────────────────────────────────────────────────

/** 解析 Markdown frontmatter（key: value 行格式） */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const k = line.slice(0, idx).trim()
    const v = line.slice(idx + 1).trim()
    if (k) result[k] = v
  }
  return result
}

/** 读取目录中所有 .md 文件并解析为 AgentItem 列表 */
export function readAgentsFromDir(dir: string): AgentItem[] {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        try {
          const content = fs.readFileSync(path.join(dir, f), 'utf-8')
          const fm = parseFrontmatter(content)
          const base = f.replace(/\.md$/, '')
          return { name: fm.name || base, model: fm.model || 'inherit' }
        } catch { return null }
      })
      .filter((x): x is AgentItem => x !== null)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[SettingsManager] Failed to read agents from ${dir}:`, err)
    }
    return []
  }
}

/** 读取目录中所有子目录下的 SKILL.md，优先用 frontmatter name: 字段，回退到目录名 */
function readSkillsFromDir(dir: string): SkillItem[] {
  try {
    return fs.readdirSync(dir)
      .filter(sub => fs.existsSync(path.join(dir, sub, 'SKILL.md')))
      .map(sub => {
        try {
          const content = fs.readFileSync(path.join(dir, sub, 'SKILL.md'), 'utf-8')
          const fm = parseFrontmatter(content)
          return { name: fm['name'] || sub, description: fm['description'], dirName: sub }
        } catch { return { name: sub, description: undefined, dirName: sub } }
      })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[SettingsManager] Failed to read skills from ${dir}:`, err)
    }
    return []
  }
}

/** 读取项目级 skills（<projectPath>/.claude/skills/）*/
export function readProjectSkills(projectPath: string): SkillItem[] {
  return readSkillsFromDir(path.join(projectPath, '.claude', 'skills'))
}

/** 解析 hooks.json 文件，返回 HookItem 列表 */
function readHooksFromJson(filePath: string, labelFilter?: (name: string) => boolean): HookItem[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { hooks?: Record<string, SettingsHookMatcher[]> }
    const hooksMap = parsed.hooks ?? {}
    const result: HookItem[] = []

    for (const [event, matchers] of Object.entries(hooksMap)) {
      for (const m of matchers) {
        // shell command 型
        if (m.command) {
          const name = m.command.split(/[/\\]/).pop() ?? m.command
          if (!labelFilter || labelFilter(name)) result.push({ event, name })
        }
        // hooks 数组型
        for (const h of m.hooks ?? []) {
          const raw = h.command ?? h.url ?? ''
          const name = raw.split(/[/\\]/).pop() ?? raw
          if (!labelFilter || labelFilter(name)) result.push({ event, name })
        }
      }
    }
    return result
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[SettingsManager] Failed to read hooks from ${filePath}:`, err)
    }
    return []
  }
}

/** 读取 installed_plugins.json，返回所有已安装插件元数据 */
function readInstalledPlugins(): PluginMeta[] {
  try {
    const raw = fs.readFileSync(PLUGINS_INSTALLED_PATH, 'utf-8')
    const registry = JSON.parse(raw) as InstalledPluginsFile
    const result: PluginMeta[] = []

    for (const [pluginId, installs] of Object.entries(registry.plugins)) {
      for (const install of installs) {
        // 从 package.json 读取 name 字段作为 shortName
        let shortName = pluginId.split('@')[0]
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(install.installPath, 'package.json'), 'utf-8')) as { name?: string }
          if (pkg.name) shortName = pkg.name
        } catch { /* 忽略，使用 pluginId 派生 */ }

        result.push({ id: pluginId, shortName, installPath: install.installPath })
      }
    }
    return result
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[SettingsManager] Failed to read installed_plugins.json:', err)
    }
    return []
  }
}

// ── 分组配置读取（主 Export）─────────────────────────────────────────────────

/**
 * 一次性读取全局配置的所有分组数据，供 CONFIG_READ IPC 使用
 * 覆盖：agents / skills / 工作流 hooks / tools / mcp servers
 */
export function readAllConfigGroups(): AllConfigGroups {
  const settings = readClaudeSettings()
  const plugins = readInstalledPlugins()
  const dashboardUrl = '127.0.0.1' // 用于过滤仪表盘注入的 hook

  // ── Agents ──────────────────────────────────────────────────────────────
  const agentGroups: ItemGroup<AgentItem>[] = []

  // 内置 Claude Code subagent 类型（二进制内置，非文件系统）
  agentGroups.push({
    label: '内置 (Claude Code)',
    source: 'builtin',
    items: [
      { name: 'Explore',           model: 'claude-haiku-4-5' },
      { name: 'Plan',              model: 'inherit' },
      { name: 'General-purpose',   model: 'inherit' },
      { name: 'statusline-setup',  model: 'claude-sonnet-4-6' },
      { name: 'Claude Code Guide', model: 'claude-haiku-4-5' },
    ],
  })

  // 用户个人 agents（~/.claude/agents/）
  const userAgents = readAgentsFromDir(USER_AGENTS_DIR)
  agentGroups.push({ label: '个人', source: 'user', items: userAgents })

  // Plugin agents
  for (const plugin of plugins) {
    const items = readAgentsFromDir(path.join(plugin.installPath, 'agents'))
    if (items.length > 0) {
      agentGroups.push({ label: plugin.shortName, source: 'plugin', pluginId: plugin.id, items })
    }
  }

  // ── Skills ──────────────────────────────────────────────────────────────
  const skillGroups: ItemGroup<SkillItem>[] = []

  // 用户个人 skills（~/.claude/skills/*/SKILL.md）
  const userSkills = readSkillsFromDir(USER_SKILLS_DIR)
  skillGroups.push({ label: '个人', source: 'user', items: userSkills })

  // Plugin skills
  for (const plugin of plugins) {
    const items = readSkillsFromDir(path.join(plugin.installPath, 'skills'))
    if (items.length > 0) {
      skillGroups.push({ label: plugin.shortName, source: 'plugin', pluginId: plugin.id, items })
    }
  }

  // ── 工作流 Hooks ─────────────────────────────────────────────────────────
  const hookGroups: ItemGroup<HookItem>[] = []

  // 用户个人 hooks（settings.json，过滤仪表盘注入 + plugin 命令）
  const userHooks: HookItem[] = []
  if (settings.hooks) {
    const pluginPaths = plugins.map(p => p.installPath)
    for (const [event, matchers] of Object.entries(settings.hooks)) {
      for (const m of matchers ?? []) {
        // shell command 型
        if (m.command) {
          const isPlugin = pluginPaths.some(p => m.command!.includes(p))
          if (!isPlugin) userHooks.push({ event, name: m.command.split(/[/\\]/).pop() ?? m.command })
        }
        // http/hooks 数组型
        for (const h of m.hooks ?? []) {
          // 过滤仪表盘注入的 command hook（curl 转发到本地 server）
          if (h.type === 'command' && h.command?.includes(dashboardUrl)) continue
          // 兼容旧的 http 格式（已废弃，顺带过滤）
          if (h.type === 'http' && h.url?.includes(dashboardUrl)) continue
          const raw = h.command ?? h.url ?? ''
          const isPlugin = pluginPaths.some(p => raw.includes(p))
          if (!isPlugin) {
            const name = raw.split(/[/\\]/).pop() ?? raw
            userHooks.push({ event, name })
          }
        }
      }
    }
  }
  hookGroups.push({ label: '个人', source: 'user', items: userHooks })

  // Plugin hooks（从各插件的 hooks/hooks.json 读取）
  for (const plugin of plugins) {
    const hooksJsonPath = path.join(plugin.installPath, 'hooks', 'hooks.json')
    const items = readHooksFromJson(hooksJsonPath)
    if (items.length > 0) {
      hookGroups.push({ label: plugin.shortName, source: 'plugin', pluginId: plugin.id, items })
    }
  }

  // ── Tools ────────────────────────────────────────────────────────────────
  // Claude Code 内置工具（无法动态读取，按默认工具列表展示）
  const defaultTools = [
    'Agent', 'AskUserQuestion', 'Bash', 'Edit', 'EnterPlanMode', 'ExitPlanMode',
    'Glob', 'Grep', 'Read', 'Skill', 'Task', 'ToolSearch',
    'WebFetch', 'WebSearch', 'Write',
  ]
  const allowed = Array.isArray(settings.allowedTools) ? (settings.allowedTools as string[]) : defaultTools
  const disallowed = new Set(Array.isArray(settings.disallowedTools) ? (settings.disallowedTools as string[]) : [])
  const toolItems = allowed.filter(t => !disallowed.has(t)).map(name => ({ name }))

  const toolGroups: ItemGroup<ToolItem>[] = [
    { label: '内置', source: 'builtin', items: toolItems },
  ]

  // ── MCP Servers（从 ~/.claude.json 顶层 mcpServers 读取，新版路径）────────
  const globalMcpNames = readGlobalMcpServers()
  const mcpGroups: ItemGroup<McpItem>[] = [
    { label: '个人', source: 'user', items: globalMcpNames.map(name => ({ name })) },
  ]

  return { agentGroups, skillGroups, hookGroups, toolGroups, mcpGroups }
}

// ── 向后兼容的单一读取函数（供外部直接引用）───────────────────────────────────

/** @deprecated 使用 readAllConfigGroups() 代替 */
export function readAgentsDir() { return readAgentsFromDir(USER_AGENTS_DIR) }

/** @deprecated 使用 readAllConfigGroups() 代替 */
export function readInstalledPluginSkills() {
  const plugins = readInstalledPlugins()
  const result: Array<{ name: string; source: 'user' | 'plugin'; pluginId?: string }> = []
  for (const s of readSkillsFromDir(USER_SKILLS_DIR)) result.push({ ...s, source: 'user' })
  for (const p of plugins) {
    for (const s of readSkillsFromDir(path.join(p.installPath, 'skills'))) {
      result.push({ ...s, source: 'plugin', pluginId: p.id })
    }
  }
  return result
}
