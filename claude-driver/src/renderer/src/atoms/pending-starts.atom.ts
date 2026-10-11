// 使用方法：import { pendingPtyStartsAtom } from '@renderer/atoms/pending-starts.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：等待 SessionStart Hook 到达的临时启动记录 atom
//           托管启动以 launchId 为 key，value = { ptyId, projectId }
//           Main 托管事件负责写入/确认/结束；旧非托管入口保留兼容读取

import { atom } from 'jotai'

export interface PendingPtyStart {
  ptyId: string
  projectId: string
}

/** 按独立 launchId 记录等待身份确认的托管启动；同项目多条记录互不覆盖。 */
export const pendingPtyStartsAtom = atom<Map<string, PendingPtyStart>>(new Map())
