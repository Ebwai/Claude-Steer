// 使用方法：import { createPermissionHandler } from '@renderer/business/permissionHandler'
// 编译说明：renderer 进程 browser bundle
// 代码说明：BL-11 权限请求处理——PermissionRequest / PermissionDenied Hook 事件

import { IPC } from '@shared/events/ipc-channels'
import type { HookEvent } from '@shared/types/index'
import { enqueueRequest, dequeueRequest } from '@renderer/capabilities/permissionQueue'
import { resolvePtyId } from '@renderer/capabilities/ptyBindings'
import type { PermissionRequest } from '@renderer/atoms/permission.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

export function createPermissionHandler(store: Store) {
  function handlePermissionRequest(hookEvent: HookEvent): void {
    const p = hookEvent.payload as {
      tool_name?: string
      tool_input?: Record<string, unknown>
      tool_use_id?: string
      description?: string
      agent_id?: string
    }
    const requestId = p.tool_use_id ?? `${hookEvent.sessionId}-${hookEvent.receivedAt}`
    const agentName = p.agent_id ? `Agent (${p.agent_id.slice(0, 6)})` : '主线程'
    const ptySessionId = resolvePtyId(store, hookEvent.sessionId) ?? hookEvent.sessionId

    const req: PermissionRequest = {
      requestId,
      sessionId: hookEvent.sessionId,
      ptySessionId,
      agentName,
      toolName: p.tool_name ?? 'Unknown',
      toolInput: p.tool_input ?? {},
      description: p.description ?? `请求执行 ${p.tool_name ?? '操作'}`,
      receivedAt: hookEvent.receivedAt,
    }
    enqueueRequest(store, req)
    console.log(`[BL-11] PermissionRequest: ${req.toolName} from ${req.agentName}`)
  }

  function handlePermissionDenied(hookEvent: HookEvent): void {
    const p = hookEvent.payload as { tool_use_id?: string }
    if (p.tool_use_id) {
      dequeueRequest(store, p.tool_use_id)
    }
  }

  function register(): Array<() => void> {
    return [
      window.api.on(IPC.HOOK_EVENT, (event: unknown) => {
        const hookEvent = event as HookEvent
        if (hookEvent.eventName === 'PermissionRequest') handlePermissionRequest(hookEvent)
        if (hookEvent.eventName === 'PermissionDenied') handlePermissionDenied(hookEvent)
      }),
    ]
  }

  return { register, handlePermissionRequest, handlePermissionDenied }
}
