// 使用方法：import { readGlobalMcpServers, readProjectMcpState, patchProjectMcpState } from './ClaudeJsonManager'
// 编译说明：主进程 Node.js 模块
// 代码说明：~/.claude.json 读写工具——全局 MCP 配置 + 项目级 MCP 启用/禁用状态管理
//           注意：~/.claude.json 是 Claude Code 的核心配置文件，写入时必须原子操作，
//           且只能 patch 目标字段，禁止覆盖其他字段

import fs from 'fs'
import path from 'path'
import os from 'os'

const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json')
const CLAUDE_JSON_TMP_PATH = path.join(os.homedir(), '.claude.json.tmp')

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  type: 'stdio' | 'http' | string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
}

interface ClaudeJsonProjectEntry {
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  [key: string]: unknown
}

interface ClaudeJsonData {
  mcpServers?: Record<string, McpServerConfig>
  projects?: Record<string, ClaudeJsonProjectEntry>
  [key: string]: unknown
}

// ── 读写基础层 ────────────────────────────────────────────────────────────────

function readClaudeJson(): ClaudeJsonData {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf-8')) as ClaudeJsonData
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[ClaudeJsonManager] Failed to read ~/.claude.json:', err)
    }
    return {}
  }
}

function writeClaudeJsonAtomic(data: ClaudeJsonData): void {
  try {
    fs.writeFileSync(CLAUDE_JSON_TMP_PATH, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(CLAUDE_JSON_TMP_PATH, CLAUDE_JSON_PATH)
  } catch (err) {
    console.error('[ClaudeJsonManager] Failed to write ~/.claude.json:', err)
    throw err
  }
}

// ── 路径标准化（去尾部斜杠，与 Claude Code 写入格式保持一致）────────────────

function normalizePath(projectPath: string): string {
  return projectPath.replace(/\/$/, '')
}

// ── 全局 MCP（~/.claude.json 顶层 mcpServers）───────────────────────────────

/** 确保 ~/.claude.json 顶层 hasCompletedOnboarding = true，跳过地区检测 */
export function ensureOnboardingCompleted(): void {
  const data = readClaudeJson()
  if (!data.hasCompletedOnboarding) {
    data.hasCompletedOnboarding = true
    writeClaudeJsonAtomic(data)
    console.log('[ClaudeJsonManager] Set hasCompletedOnboarding=true')
  }
}

/** 确保项目目录已通过信任对话框（~/.claude.json projects[path].hasTrustDialogAccepted = true） */
export function ensureProjectTrusted(projectPath: string): void {
  const key = normalizePath(projectPath)
  const data = readClaudeJson()
  if (!data.projects) data.projects = {}
  if (!data.projects[key]) data.projects[key] = {}
  const entry = data.projects[key]
  if (!entry.hasTrustDialogAccepted) {
    entry.hasTrustDialogAccepted = true
    writeClaudeJsonAtomic(data)
    console.log(`[ClaudeJsonManager] ensureProjectTrusted(${key}): set hasTrustDialogAccepted=true`)
  }
}

/** 读取全局 MCP server 名称列表 */
export function readGlobalMcpServers(): string[] {
  const data = readClaudeJson()
  const servers = data.mcpServers ?? {}
  const names = Object.keys(servers)
  console.log(`[ClaudeJsonManager] readGlobalMcpServers: found ${names.length} servers`)
  return names
}

// ── 项目级 .mcp.json 文件读取 ─────────────────────────────────────────────────

/** 读取项目根目录 .mcp.json 中定义的 MCP server 名称列表 */
export function readProjectMcpJsonServers(projectPath: string): string[] {
  const mcpJsonPath = path.join(normalizePath(projectPath), '.mcp.json')
  try {
    if (!fs.existsSync(mcpJsonPath)) return []
    const raw = fs.readFileSync(mcpJsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
    const names = Object.keys(parsed.mcpServers ?? {})
    console.log(`[ClaudeJsonManager] readProjectMcpJsonServers(${projectPath}): found ${names.length} servers`)
    return names
  } catch (err) {
    console.error(`[ClaudeJsonManager] Failed to read .mcp.json at ${projectPath}:`, err)
    return []
  }
}

// ── 项目级启用/禁用状态（~/.claude.json projects[path]）──────────────────────

export interface ProjectMcpState {
  /** .mcp.json 中已明确启用的 server 名列表 */
  enabledMcpjsonServers: string[]
  /** .mcp.json 中已明确禁用的 server 名列表 */
  disabledMcpjsonServers: string[]
}

/** 读取指定项目的 MCP 启用/禁用状态 */
export function readProjectMcpState(projectPath: string): ProjectMcpState {
  const key = normalizePath(projectPath)
  const data = readClaudeJson()
  const entry = data.projects?.[key] ?? {}
  return {
    enabledMcpjsonServers: (entry.enabledMcpjsonServers as string[] | undefined) ?? [],
    disabledMcpjsonServers: (entry.disabledMcpjsonServers as string[] | undefined) ?? [],
  }
}

/**
 * 修改指定项目某个 .mcp.json server 的启用/禁用状态
 * 只修改 enabledMcpjsonServers / disabledMcpjsonServers 两个字段，不碰其他字段
 */
export function patchProjectMcpState(
  projectPath: string,
  serverName: string,
  enabled: boolean,
): void {
  const key = normalizePath(projectPath)
  const data = readClaudeJson()

  if (!data.projects) data.projects = {}
  // 只创建空骨架，禁止覆盖已有其他字段
  if (!data.projects[key]) data.projects[key] = {}

  const entry = data.projects[key]
  const currentEnabled = (entry.enabledMcpjsonServers as string[] | undefined) ?? []
  const currentDisabled = (entry.disabledMcpjsonServers as string[] | undefined) ?? []

  if (enabled) {
    entry.enabledMcpjsonServers  = [...new Set([...currentEnabled, serverName])]
    entry.disabledMcpjsonServers = currentDisabled.filter(n => n !== serverName)
  } else {
    entry.disabledMcpjsonServers = [...new Set([...currentDisabled, serverName])]
    entry.enabledMcpjsonServers  = currentEnabled.filter(n => n !== serverName)
  }

  writeClaudeJsonAtomic(data)
  console.log(`[ClaudeJsonManager] patchProjectMcpState(${key}, ${serverName}, enabled=${enabled}) OK`)
}
