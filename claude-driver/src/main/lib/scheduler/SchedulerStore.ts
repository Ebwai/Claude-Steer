// 使用方法：import { readSchedulerSessions, writeSchedulerSessions } from './SchedulerStore'
// 编译说明：主进程 Node.js 模块
// 代码说明：调度器持久化存储——读写 ~/.claude-driver/scheduler-sessions.json
//           每个条目以 projectPath 为键，记录 claudeId + 任务列表

import fs from 'fs'
import path from 'path'
import os from 'os'

const STORE_DIR  = path.join(os.homedir(), '.claude-driver')
const STORE_FILE = path.join(STORE_DIR, 'scheduler-sessions.json')

/** 单个定时任务记录 */
export interface SchedulerTaskRecord {
  taskId: string
  interval: string
  prompt: string
  createdAt: number
}

/** 一个项目对应一个 loop session entry */
export interface SchedulerSessionEntry {
  projectPath: string
  claudeId: string        // claude --resume 用到的 session id
  tasks: SchedulerTaskRecord[]
}

export type SchedulerStore = SchedulerSessionEntry[]

export function readSchedulerSessions(): SchedulerStore {
  try {
    if (!fs.existsSync(STORE_FILE)) return []
    const raw = fs.readFileSync(STORE_FILE, 'utf-8')
    return JSON.parse(raw) as SchedulerStore
  } catch (err) {
    console.error('[SchedulerStore] read error:', err)
    return []
  }
}

export function writeSchedulerSessions(data: SchedulerStore): void {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true })
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    console.error('[SchedulerStore] write error:', err)
  }
}

/** 向指定项目的 session 追加一个任务记录（若 entry 不存在则新建） */
export function appendTaskToSession(projectPath: string, claudeId: string, task: SchedulerTaskRecord): SchedulerStore {
  const data = readSchedulerSessions()
  const idx = data.findIndex((e) => e.projectPath === projectPath)
  if (idx >= 0) {
    data[idx].claudeId = claudeId   // 更新最新 claudeId（resume 后可能变化）
    data[idx].tasks.push(task)
  } else {
    data.push({ projectPath, claudeId, tasks: [task] })
  }
  writeSchedulerSessions(data)
  return data
}

/** 从持久化中删除指定 taskId */
export function deleteTask(taskId: string): SchedulerStore {
  const data = readSchedulerSessions()
  for (const entry of data) {
    entry.tasks = entry.tasks.filter((t) => t.taskId !== taskId)
  }
  // 清理空 entry
  const filtered = data.filter((e) => e.tasks.length > 0)
  writeSchedulerSessions(filtered)
  return filtered
}

/** 更新某个项目 entry 的 claudeId（resume 后用新 id） */
export function updateClaudeId(projectPath: string, claudeId: string): void {
  const data = readSchedulerSessions()
  const entry = data.find((e) => e.projectPath === projectPath)
  if (entry) {
    entry.claudeId = claudeId
    writeSchedulerSessions(data)
  }
}
