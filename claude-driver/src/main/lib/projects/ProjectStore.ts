// 使用方法：import { readProjects, upsertProject, updateProjectClaims } from './lib/projects/ProjectStore'
// 编译说明：主进程 Node.js 模块
// 代码说明：~/.claude-driver/projects.json 原子读写工具
//           存储所有已知项目记录、init 完成标志、最后扫描根目录

import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Project, ClaimStatus } from '../../../shared/types/index'

// ── 路径常量 ──────────────────────────────────────────────────────────────────

const DRIVER_DIR = path.join(os.homedir(), '.claude-driver')
const PROJECTS_PATH = path.join(DRIVER_DIR, 'projects.json')
const PROJECTS_TMP_PATH = path.join(DRIVER_DIR, 'projects.json.tmp')

// ── 文件格式 ──────────────────────────────────────────────────────────────────

interface ProjectsFile {
  version: number
  /** 首次初始化向导是否已完成 */
  initCompleted: boolean
  /** 上次扫描的根目录（用于后续启动自动重扫） */
  lastRootDir: string | null
  projects: Project[]
}

const DEFAULT_FILE: ProjectsFile = {
  version: 1,
  initCompleted: false,
  lastRootDir: null,
  projects: [],
}

// ── 基础读写 ──────────────────────────────────────────────────────────────────

export function readProjectsFile(): ProjectsFile {
  try {
    const raw = fs.readFileSync(PROJECTS_PATH, 'utf-8')
    return JSON.parse(raw) as ProjectsFile
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[ProjectStore] Failed to read projects.json:', err)
    }
    return { ...DEFAULT_FILE }
  }
}

export function writeProjectsFile(data: ProjectsFile): void {
  try {
    fs.mkdirSync(DRIVER_DIR, { recursive: true })
    fs.writeFileSync(PROJECTS_TMP_PATH, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(PROJECTS_TMP_PATH, PROJECTS_PATH)
  } catch (err) {
    console.error('[ProjectStore] Failed to write projects.json:', err)
    throw err
  }
}

// ── 便捷操作函数 ──────────────────────────────────────────────────────────────

/** 返回所有已知项目列表 */
export function readProjects(): Project[] {
  return readProjectsFile().projects
}

/** 插入或更新单个项目（以 id 为主键） */
export function upsertProject(project: Project): void {
  const file = readProjectsFile()
  const idx = file.projects.findIndex((p) => p.id === project.id)
  if (idx >= 0) {
    file.projects[idx] = project
  } else {
    file.projects.push(project)
  }
  writeProjectsFile(file)
}

/** 批量更新项目的 claimStatus */
export function updateProjectClaims(
  updates: Array<{ projectId: string; claimStatus: ClaimStatus }>
): void {
  const file = readProjectsFile()
  const map = new Map(file.projects.map((p) => [p.id, p]))

  for (const { projectId, claimStatus } of updates) {
    const project = map.get(projectId)
    if (project) {
      map.set(projectId, { ...project, claimStatus })
    } else {
      // 项目不在记录中（理论上不应该，但防御性处理）
      console.warn(`[ProjectStore] updateProjectClaims: project ${projectId} not found`)
    }
  }

  file.projects = Array.from(map.values())
  writeProjectsFile(file)
}

/** 检查是否已完成初始化向导 */
export function isInitCompleted(): boolean {
  return readProjectsFile().initCompleted
}

/** 标记初始化完成，同时记录扫描根目录 */
export function setInitCompleted(lastRootDir: string | null): void {
  const file = readProjectsFile()
  file.initCompleted = true
  file.lastRootDir = lastRootDir
  writeProjectsFile(file)
}

/** 获取上次扫描的根目录 */
export function getLastRootDir(): string | null {
  return readProjectsFile().lastRootDir
}

/** projects.json 是否存在（用于判断是否首次启动） */
export function projectsFileExists(): boolean {
  return fs.existsSync(PROJECTS_PATH)
}
