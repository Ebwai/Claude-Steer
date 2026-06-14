// 使用方法：import { createSubagentHandler } from '@renderer/business/subagentHandler'
// 编译说明：renderer 进程 browser bundle
// 代码说明：BL-5 Subagent 生命周期处理——SubagentStart / SubagentStop Hook 事件

import { IPC } from '@shared/events/ipc-channels'
import type { HookEvent, HookPayloadSubagent } from '@shared/types/index'
import { showSubagent, hideSubagent } from '@renderer/capabilities/agentActivity'
import { pendingBtwAtom } from '@renderer/atoms/agent-block.atom'
import { patchInsertion } from '@renderer/capabilities/timelineStore'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

export function createSubagentHandler(store: Store) {
  function handleSubagentStart(hookEvent: HookEvent): void {
    const payload = hookEvent.payload as { subagent_id?: string }
    showSubagent(store, hookEvent.sessionId, {
      subagentId: payload.subagent_id ?? hookEvent.sessionId,
      description: 'Subagent 执行中…',
      startedAt: hookEvent.receivedAt,
    })
  }

  function handleSubagentStop(hookEvent: HookEvent): void {
    hideSubagent(store, hookEvent.sessionId)

    // /btw 回填：若该 session 有待回填的 btw insertion，写入 last_assistant_message
    const pendingMap = store.get(pendingBtwAtom)
    const insertionId = pendingMap.get(hookEvent.sessionId)
    if (!insertionId) return

    const payload = hookEvent.payload as HookPayloadSubagent
    const answer = payload.last_assistant_message
    if (!answer) return

    // 从 pending map 中移除
    store.set(pendingBtwAtom, (prev) => {
      const next = new Map(prev)
      next.delete(hookEvent.sessionId)
      return next
    })

    // 更新插入线并持久化：追加 answer 到 badgeContent，状态改为 done
    patchInsertion(store, hookEvent.sessionId, insertionId, {
      status: 'done',
      isAnimating: false,
      badgeContent: { answer },
    })
    console.log(`[subagentHandler] /btw answer backfilled insertionId=${insertionId} len=${answer.length}`)
  }

  function register(): Array<() => void> {
    return [
      window.api.on(IPC.HOOK_EVENT, (event: unknown) => {
        const hookEvent = event as HookEvent
        if (hookEvent.eventName === 'SubagentStart') handleSubagentStart(hookEvent)
        if (hookEvent.eventName === 'SubagentStop') handleSubagentStop(hookEvent)
      }),
    ]
  }

  return { register, handleSubagentStart, handleSubagentStop }
}
