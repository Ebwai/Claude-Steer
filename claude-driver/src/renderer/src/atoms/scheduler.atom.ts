// 使用方法：import { schedulerTasksAtom } from '@renderer/atoms/scheduler.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：定时触发任务列表 atom（由 SchedulerModal 挂载时填充，操作后刷新）

import { atom } from 'jotai'

export interface SchedulerTask {
  taskId: string
  projectPath: string
  claudeId: string
  interval: string
  prompt: string
  createdAt: number
  isActive: boolean
  isExpired: boolean
}

export const schedulerTasksAtom = atom<SchedulerTask[]>([])
