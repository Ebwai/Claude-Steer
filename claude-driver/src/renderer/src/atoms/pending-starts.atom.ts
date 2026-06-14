// 使用方法：import { pendingPtyStartsAtom } from '@renderer/atoms/pending-starts.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：等待 SessionStart Hook 到达的临时启动记录 atom
//           key = projectPath，value = { ptyId, projectId }
//           SESSION_START 后写入，SessionStart Hook 到达时由 sessionLifecycle 消费并删除

import { atom } from 'jotai'

export interface PendingPtyStart {
  ptyId: string
  projectId: string
}

/**
 * 等待 SessionStart Hook 的临时记录（projectPath → {ptyId, projectId}）
 * LeftPanel / ProjectSettingsBar 在 SESSION_START 返回后写入
 * SessionStart Hook 到达时由 sessionLifecycle.handleSessionStart 消费后删除
 */
export const pendingPtyStartsAtom = atom<Map<string, PendingPtyStart>>(new Map())
