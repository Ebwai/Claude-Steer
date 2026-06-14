// 使用方法：import { createTestStore, createStoreWith } from '../helpers/createTestStore'
// 编译说明：仅测试环境
// 代码说明：Jotai store 测试工厂——每个测试用例创建独立 store，避免状态污染

import { createStore, type Atom, type WritableAtom } from 'jotai'

export type TestStore = ReturnType<typeof createStore>

/** 创建空白测试 store（每个 test 调用一次，防止状态共享） */
export function createTestStore(): TestStore {
  return createStore()
}

type AnyWritableAtom = WritableAtom<unknown, unknown[], unknown>

/** 创建带初始 atom 值的测试 store */
export function createStoreWith(
  init: Array<[atom: AnyWritableAtom, value: unknown]>
): TestStore {
  const store = createStore()
  for (const [a, v] of init) {
    store.set(a as WritableAtom<unknown, [unknown], void>, v)
  }
  return store
}

/** 订阅 atom 变化并收集历史值（用于验证副作用顺序） */
export function collectAtomValues<T>(
  store: TestStore,
  atom: Atom<T>
): { values: T[]; unsub: () => void } {
  const values: T[] = [store.get(atom)]
  const unsub = store.sub(atom, () => {
    values.push(store.get(atom))
  })
  return { values, unsub }
}
