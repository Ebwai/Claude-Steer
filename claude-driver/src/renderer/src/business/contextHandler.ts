// 使用方法：import { createContextHandler } from '@renderer/business/contextHandler'
// 编译说明：renderer 进程 browser bundle
// 代码说明：BL-12 上下文追踪处理——PostToolUse(Read/Glob/Grep/WebFetch) / PostCompact

import { IPC } from '@shared/events/ipc-channels'
import type { HookEvent } from '@shared/types/index'
import { addContextComponent, clearDynamicContext } from '@renderer/capabilities/contextTracker'
import { resolvePtyId } from '@renderer/capabilities/ptyBindings'
import type { ContextComponent } from '@renderer/atoms/context-panel.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

export function createContextHandler(store: Store) {
  function handlePostToolUseContext(hookEvent: HookEvent): void {
    const payload = hookEvent.payload as {
      tool_name?: string
      tool_input?: Record<string, unknown>
      agent_id?: string
    }
    const toolName = payload.tool_name ?? ''
    const toolInput = payload.tool_input ?? {}

    // 仅追踪主 session（非 subagent）工具调用
    if (payload.agent_id) return

    const ctxId = resolvePtyId(store, hookEvent.sessionId) ?? hookEvent.sessionId

    if (['Read', 'Glob', 'Grep'].includes(toolName)) {
      const filePath = (toolInput['file_path'] as string)
        || (toolInput['path'] as string)
        || (toolInput['pattern'] as string)
        || ''
      if (filePath) {
        const fileName = filePath.split('/').pop() ?? filePath
        const comp: ContextComponent = {
          id: `file:${filePath}`,
          type: 'file',
          label: fileName,
          tokenEstimate: 0,
          persistent: false,
        }
        addContextComponent(store, ctxId, comp)
      }
    }

    if (toolName === 'WebFetch') {
      const url = (toolInput['url'] as string) ?? ''
      if (url) {
        let urlLabel = url
        try { urlLabel = new URL(url).hostname + new URL(url).pathname } catch { /* 无法解析时保留原始值 */ }
        const comp: ContextComponent = {
          id: `webfetch:${url}`,
          type: 'WebFetch',
          label: urlLabel,
          url,
          tokenEstimate: 0,
          persistent: false,
        }
        addContextComponent(store, ctxId, comp)
      }
    }
  }

  function handlePostCompact(hookEvent: HookEvent): void {
    const ctxId = resolvePtyId(store, hookEvent.sessionId) ?? hookEvent.sessionId
    clearDynamicContext(store, ctxId)
    console.log(`[BL-12] PostCompact: cleared dynamic context for session ${ctxId}`)
  }

  function register(): Array<() => void> {
    return [
      window.api.on(IPC.HOOK_EVENT, (event: unknown) => {
        const hookEvent = event as HookEvent
        if (hookEvent.eventName === 'PostToolUse') handlePostToolUseContext(hookEvent)
        if (hookEvent.eventName === 'PostCompact') handlePostCompact(hookEvent)
      }),
    ]
  }

  return { register, handlePostToolUseContext, handlePostCompact }
}
