// 使用方法：npx vitest run src/__tests__/hooks/useIpcBridgeStartup.test.ts
// 编译说明：Vitest jsdom 环境
// 代码说明：React StrictMode 双挂载必须复用同一启动库存任务
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import { IPC } from '@shared/events/ipc-channels'

describe('useIpcBridge startup inventory coordinator', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('coalesces concurrent StrictMode initialization into one project/token scan', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC.PROJECT_LIST) {
        return [{
          id: 'project-1',
          name: 'Project 1',
          path: 'F:\\project-1',
          claimStatus: 1,
        }]
      }
      if (channel === IPC.HISTORY_TOKEN_INVENTORY) {
        return { ok: true, requestId: 'token-request', entries: [] }
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { invoke },
    })
    const { ensureStartupTokenInventory } = await import('@renderer/hooks/useIpcBridge')
    const store = createTestStore()

    await Promise.all([
      ensureStartupTokenInventory(store),
      ensureStartupTokenInventory(store),
    ])

    expect(invoke.mock.calls.filter(([channel]) => channel === IPC.PROJECT_LIST)).toHaveLength(1)
    expect(invoke.mock.calls.filter(([channel]) => channel === IPC.HISTORY_TOKEN_INVENTORY)).toHaveLength(1)
  })
})
