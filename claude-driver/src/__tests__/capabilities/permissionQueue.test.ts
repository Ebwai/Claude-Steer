// 使用方法：npm test src/__tests__/capabilities/permissionQueue.test.ts
// 编译说明：仅测试环境
// 代码说明：Phase 3-O 权限请求能力组单元测试

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import { enqueueRequest, dequeueRequest, getPendingRequests } from '@renderer/capabilities/permissionQueue'
import { permissionRequestsAtom } from '@renderer/atoms/permission.atom'
import type { PermissionRequest } from '@renderer/atoms/permission.atom'

function makeReq(override: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'req-1',
    sessionId: 'c1',
    ptySessionId: 'p1',
    agentName: 'claude',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    description: '执行命令',
    receivedAt: 1000,
    ...override,
  }
}

let store: TestStore

beforeEach(() => { store = createTestStore() })

describe('O1: enqueueRequest', () => {
  it('加入队列', () => {
    enqueueRequest(store, makeReq())
    expect(store.get(permissionRequestsAtom)).toHaveLength(1)
  })

  it('相同 requestId 不重复入队', () => {
    enqueueRequest(store, makeReq({ requestId: 'r1' }))
    enqueueRequest(store, makeReq({ requestId: 'r1' }))
    expect(store.get(permissionRequestsAtom)).toHaveLength(1)
  })

  it('不同 requestId 均入队', () => {
    enqueueRequest(store, makeReq({ requestId: 'r1' }))
    enqueueRequest(store, makeReq({ requestId: 'r2' }))
    expect(store.get(permissionRequestsAtom)).toHaveLength(2)
  })
})

describe('O2: dequeueRequest', () => {
  it('移除指定 requestId', () => {
    enqueueRequest(store, makeReq({ requestId: 'r1' }))
    dequeueRequest(store, 'r1')
    expect(store.get(permissionRequestsAtom)).toHaveLength(0)
  })

  it('不影响其他请求', () => {
    enqueueRequest(store, makeReq({ requestId: 'r1' }))
    enqueueRequest(store, makeReq({ requestId: 'r2' }))
    dequeueRequest(store, 'r1')
    expect(store.get(permissionRequestsAtom)).toHaveLength(1)
    expect(store.get(permissionRequestsAtom)[0].requestId).toBe('r2')
  })

  it('不存在的 requestId 无副作用', () => {
    enqueueRequest(store, makeReq())
    dequeueRequest(store, 'nonexist')
    expect(store.get(permissionRequestsAtom)).toHaveLength(1)
  })
})

describe('O3: getPendingRequests', () => {
  it('返回当前队列', () => {
    enqueueRequest(store, makeReq())
    expect(getPendingRequests(store)).toHaveLength(1)
  })

  it('初始为空', () => {
    expect(getPendingRequests(store)).toEqual([])
  })
})
