// 使用方法：import { createDetailHandler } from '@renderer/business/detailHandler'
// 编译说明：renderer 进程 browser bundle
// 代码说明：统一详情 IPC 推送处理——DETAIL_INVALIDATED / DETAIL_CHUNK

import { IPC } from '@shared/events/ipc-channels'
import { handleDetailInvalidation, handleDetailChunk } from '@renderer/capabilities/detailCapability'
import type { DetailInvalidation, DetailChunk } from '@shared/types/detail'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

export function createDetailHandler(store: Store) {
  function register(): Array<() => void> {
    return [
      window.api.on(IPC.DETAIL_INVALIDATED, (payload: unknown) => {
        const invalidation = payload as DetailInvalidation
        console.info(`[detailHandler] DETAIL_INVALIDATED key=${invalidation.detailKey}`)
        handleDetailInvalidation(store, invalidation)
      }),
      window.api.on(IPC.DETAIL_CHUNK, (payload: unknown) => {
        const chunk = payload as DetailChunk
        handleDetailChunk(store, chunk)
      }),
    ]
  }

  return { register }
}
