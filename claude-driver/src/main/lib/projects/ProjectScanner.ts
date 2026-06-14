// 使用方法：import { scanForProjects } from './lib/projects/ProjectScanner'
// 编译说明：主进程 Node.js 模块
// 代码说明：递归扫描目录，寻找含 CLAUDE.md 的项目文件夹
//           支持路径前缀去重（保留最浅层路径）和 Git 仓库检测

import fs from 'fs'
import path from 'path'

// ── 扫描结果类型 ──────────────────────────────────────────────────────────────

export interface ScannedProject {
  path: string
  name: string
  isGitRepo: boolean
}

// ── 排除目录名（不递归进入）──────────────────────────────────────────────────

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.npm', '.yarn', '.pnpm',
  'dist', 'build', 'out', '.next', '.nuxt', '.output',
  '__pycache__', '.venv', 'venv', '.env',
  '.cache', '.tmp', 'tmp', 'temp',
  'Library', 'Applications', 'System',   // macOS
])

const MAX_DEPTH = 6

// ── 核心工具函数 ──────────────────────────────────────────────────────────────

/** 检查目录是否为 Git 仓库（存在 .git 子目录） */
export function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'))
  } catch {
    return false
  }
}

/**
 * 路径前缀去重：对于两个路径 A 和 B，若 B 是 A 的子目录，保留 A（外层）丢弃 B。
 * 入参路径先按长度升序排序，确保最外层路径优先接受。
 */
function deduplicateByPrefix(paths: string[]): string[] {
  const sorted = [...paths].sort((a, b) => a.length - b.length)
  const accepted: string[] = []

  for (const p of sorted) {
    const isNested = accepted.some(
      (parent) => p.startsWith(parent + path.sep) || p.startsWith(parent + '/')
    )
    if (!isNested) {
      accepted.push(p)
    }
  }

  return accepted
}

/**
 * 递归收集包含 CLAUDE.md 的目录（深度限制 MAX_DEPTH）
 */
function collectCandidates(dir: string, depth: number, found: string[]): void {
  if (depth > MAX_DEPTH) return

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 无读权限，跳过
  }

  // 检查当前目录是否含 CLAUDE.md
  const hasClaude = entries.some((e) => e.isFile() && e.name === 'CLAUDE.md')
  if (hasClaude) {
    found.push(dir)
    // 即使当前目录已是项目，仍继续递归（子目录也可能有独立 CLAUDE.md）
    // 去重逻辑在最后统一处理
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (EXCLUDE_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('.') && entry.name !== '.claude') continue

    collectCandidates(path.join(dir, entry.name), depth + 1, found)
  }
}

/**
 * 扫描 rootDir，返回含 CLAUDE.md 的项目列表（路径前缀去重后）
 */
export async function scanForProjects(rootDir: string): Promise<ScannedProject[]> {
  console.log(`[ProjectScanner] Scanning: ${rootDir}`)

  const candidates: string[] = []
  collectCandidates(rootDir, 0, candidates)

  const deduplicated = deduplicateByPrefix(candidates)
  console.log(`[ProjectScanner] Found ${deduplicated.length} projects (from ${candidates.length} candidates)`)

  return deduplicated.map((projectPath) => ({
    path: projectPath,
    name: path.basename(projectPath),
    isGitRepo: isGitRepo(projectPath),
  }))
}
