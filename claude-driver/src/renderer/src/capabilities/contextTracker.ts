// 使用方法：import { addContextComponent, clearDynamicContext, ... } from '@renderer/capabilities/contextTracker'
// 编译说明：renderer 进程 browser bundle
// 代码说明：N. 上下文追踪能力组——contextPanelAtom 的读写操作

import { contextPanelAtom } from '@renderer/atoms/context-panel.atom'
import type { ContextComponent } from '@renderer/atoms/context-panel.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

/** N1: 追加上下文组件（相同 id 去重） */
export function addContextComponent(store: Store, claudeId: string, comp: ContextComponent): void {
  store.set(contextPanelAtom(claudeId), (prev) => {
    if (prev.some((c) => c.id === comp.id)) return prev
    return [...prev, comp]
  })
}

/** N2: 清空非持久化组件（persistent=false）——PostCompact 时调用 */
export function clearDynamicContext(store: Store, claudeId: string): void {
  store.set(contextPanelAtom(claudeId), (prev) => prev.filter((c) => c.persistent))
}

/** N3: 查询当前上下文组件列表 */
export function getContext(store: Store, claudeId: string): ContextComponent[] {
  return store.get(contextPanelAtom(claudeId))
}
