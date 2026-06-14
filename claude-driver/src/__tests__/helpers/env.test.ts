// 使用方法：npm test
// 编译说明：仅测试环境
// 代码说明：Phase 0 验收——确认 Vitest + jsdom + createTestStore 可正常运行

import { describe, it, expect } from 'vitest'
import { createStore } from 'jotai'
import { atom } from 'jotai'
import { createTestStore, createStoreWith, collectAtomValues } from './createTestStore'

describe('Phase 0: 测试环境', () => {
  it('createTestStore 返回独立 store', () => {
    const s1 = createTestStore()
    const s2 = createTestStore()
    expect(s1).not.toBe(s2)
  })

  it('store.get / store.set 正常工作', () => {
    const store = createTestStore()
    const a = atom(0)
    expect(store.get(a)).toBe(0)
    store.set(a, 42)
    expect(store.get(a)).toBe(42)
  })

  it('createStoreWith 设置初始值', () => {
    const a = atom('')
    const store = createStoreWith([[a, 'hello']])
    expect(store.get(a)).toBe('hello')
  })

  it('collectAtomValues 收集变化历史', () => {
    const store = createTestStore()
    const a = atom(0)
    const { values, unsub } = collectAtomValues(store, a)
    store.set(a, 1)
    store.set(a, 2)
    unsub()
    store.set(a, 3) // unsub 后不再收集
    expect(values).toEqual([0, 1, 2])
  })

  it('node 环境可用（window 对象不存在，因 atom/capability 层无需 DOM）', () => {
    expect(typeof window).toBe('undefined')
  })

  it('独立 store 不共享状态', () => {
    const a = atom(0)
    const s1 = createStore()
    const s2 = createStore()
    s1.set(a, 99)
    expect(s2.get(a)).toBe(0)
  })
})
