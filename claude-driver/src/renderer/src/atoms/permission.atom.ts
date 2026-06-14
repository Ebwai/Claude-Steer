// 使用方法：import { permissionRequestsAtom } from '@renderer/atoms/permission.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：权限请求队列 atom

import { atom } from 'jotai'

export interface PermissionRequest {
  requestId: string
  sessionId: string
  ptySessionId: string
  agentName: string
  toolName: string
  toolInput: Record<string, unknown>
  description: string
  receivedAt: number
}

/**
 * 全局权限请求队列（FIFO）
 * PermissionRequest Hook 追加，用户审批/拒绝后移除
 */
export const permissionRequestsAtom = atom<PermissionRequest[]>([])
