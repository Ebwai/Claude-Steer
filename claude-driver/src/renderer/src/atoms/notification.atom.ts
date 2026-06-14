// 使用方法：import { notificationQueueAtom, unreadCountAtom } from '@renderer/atoms/notification.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：通知队列 Jotai 原子状态——权限请求、Agent 通知的 FIFO 队列

import { atom } from 'jotai'
import type { Notification } from '@shared/types/index'

/** 通知队列（FIFO，新通知 push 到末尾） */
export const notificationQueueAtom = atom<Notification[]>([])

/** 未读/待处理通知数量（用于底栏角标） */
export const unreadCountAtom = atom<number>((get) => {
  return get(notificationQueueAtom).filter((n) => !n.resolved).length
})

/** 待处理权限请求数量（底栏右侧"N 待处理请求"） */
export const pendingRequestCountAtom = atom<number>((get) => {
  return get(notificationQueueAtom).filter(
    (n) => n.type === 'permission_request' && !n.resolved
  ).length
})
