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

/** 预览截断长度 */
const PREVIEW_MAX = 200

/**
 * 从 toolInput 中只提取 buildDetailText 所需的轻量字段。
 * 避免将完整 tool_input（可含大段文件内容/JSON）常驻 permissionRequestsAtom。
 */
function slimToolInput(toolName: string, raw: Record<string, unknown>): Record<string, unknown> {
  const pick = (...keys: string[]) => {
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      const v = raw[k]
      if (v !== undefined) {
        out[k] = typeof v === 'string' && v.length > PREVIEW_MAX ? v.slice(0, PREVIEW_MAX) + '…' : v
      }
    }
    return out
  }
  switch (toolName) {
    case 'Read': return pick('file_path', 'offset', 'limit')
    case 'Write': return pick('file_path')
    case 'Edit': return pick('file_path', 'replace_all')
    case 'MultiEdit': return pick('file_path', 'editCount')
    case 'Bash': return pick('command', 'description', 'dangerouslyDisableSandbox')
    case 'Grep': return pick('pattern', 'path', 'include')
    case 'Glob': return pick('pattern', 'path')
    case 'WebFetch': return pick('url')
    case 'WebSearch': return pick('query', 'allowed_domains')
    default: {
      // 通用工具/MCP：保留 displayName + description + 摘要
      const out: Record<string, unknown> = {}
      if (raw['displayName']) out['displayName'] = raw['displayName']
      if (raw['description']) {
        const desc = String(raw['description'])
        out['description'] = desc.length > PREVIEW_MAX ? desc.slice(0, PREVIEW_MAX) + '…' : desc
      }
      return out
    }
  }
}

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
      toolInput: slimToolInput(p.tool_name ?? 'Unknown', (p.tool_input ?? {}) as Record<string, unknown>),
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
