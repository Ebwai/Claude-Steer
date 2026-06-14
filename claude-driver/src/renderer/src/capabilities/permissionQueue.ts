// 使用方法：import { enqueueRequest, dequeueRequest, getPendingRequests } from '@renderer/capabilities/permissionQueue'
// 编译说明：renderer 进程 browser bundle
// 代码说明：O. 权限请求能力组——permissionRequestsAtom 的队列操作

import { permissionRequestsAtom } from '@renderer/atoms/permission.atom'
import type { PermissionRequest } from '@renderer/atoms/permission.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

/** O1: 入队权限请求（同 requestId 去重） */
export function enqueueRequest(store: Store, req: PermissionRequest): void {
  store.set(permissionRequestsAtom, (prev) => {
    if (prev.some((r) => r.requestId === req.requestId)) return prev
    return [...prev, req]
  })
}

/** O2: 出队（批准/拒绝后移除） */
export function dequeueRequest(store: Store, requestId: string): void {
  store.set(permissionRequestsAtom, (prev) => prev.filter((r) => r.requestId !== requestId))
}

/** O3: 查询当前待审批请求列表 */
export function getPendingRequests(store: Store): PermissionRequest[] {
  return store.get(permissionRequestsAtom)
}
