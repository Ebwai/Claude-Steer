// 使用方法：import { bindPty, unbindPty, ... } from '@renderer/capabilities/ptyBindings'
// 编译说明：renderer 进程 browser bundle
// 代码说明：I. PTY 绑定表能力组——ptyBindingsAtom 的所有写/读操作，纯函数形式（接受 store 参数）

import { ptyBindingsAtom } from '@renderer/atoms/pty-binding.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

/** I1: 建立 ptyId ↔ claudeId 双向绑定 */
export function bindPty(store: Store, ptyId: string, claudeId: string): void {
  store.set(ptyBindingsAtom, (prev) => ({
    ptyToClaudeMap: new Map(prev.ptyToClaudeMap).set(ptyId, claudeId),
    claudeToPtyMap: new Map(prev.claudeToPtyMap).set(claudeId, ptyId),
  }))
}

/** I2: 解除 ptyId ↔ claudeId 双向绑定；若任一 id 不存在则无副作用 */
export function unbindPty(store: Store, ptyId: string, claudeId: string): void {
  store.set(ptyBindingsAtom, (prev) => {
    const p2c = new Map(prev.ptyToClaudeMap)
    const c2p = new Map(prev.claudeToPtyMap)
    p2c.delete(ptyId)
    c2p.delete(claudeId)
    return { ptyToClaudeMap: p2c, claudeToPtyMap: c2p }
  })
}

/** I3: ptyId → claudeId；不存在时返回 undefined */
export function resolveClaudeId(store: Store, ptyId: string): string | undefined {
  return store.get(ptyBindingsAtom).ptyToClaudeMap.get(ptyId)
}

/** I4: claudeId → ptyId；不存在时返回 undefined */
export function resolvePtyId(store: Store, claudeId: string): string | undefined {
  return store.get(ptyBindingsAtom).claudeToPtyMap.get(claudeId)
}
