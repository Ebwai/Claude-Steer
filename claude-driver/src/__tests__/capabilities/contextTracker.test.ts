// 使用方法：npm test src/__tests__/capabilities/contextTracker.test.ts
// 编译说明：仅测试环境
// 代码说明：Phase 3-N 上下文追踪能力组单元测试

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import { addContextComponent, clearDynamicContext, getContext } from '@renderer/capabilities/contextTracker'
import { contextPanelAtom } from '@renderer/atoms/context-panel.atom'
import type { ContextComponent } from '@renderer/atoms/context-panel.atom'

function makeComp(override: Partial<ContextComponent> = {}): ContextComponent {
  return {
    id: 'file:/proj/a.ts',
    type: 'file',
    label: 'a.ts',
    tokenEstimate: 100,
    persistent: false,
    ...override,
  }
}

let store: TestStore

beforeEach(() => { store = createTestStore() })

describe('N1: addContextComponent', () => {
  it('追加组件', () => {
    addContextComponent(store, 'c1', makeComp())
    expect(store.get(contextPanelAtom('c1'))).toHaveLength(1)
  })

  it('相同 id 不重复追加', () => {
    addContextComponent(store, 'c1', makeComp({ id: 'x' }))
    addContextComponent(store, 'c1', makeComp({ id: 'x' }))
    expect(store.get(contextPanelAtom('c1'))).toHaveLength(1)
  })

  it('不同 id 均追加', () => {
    addContextComponent(store, 'c1', makeComp({ id: 'a' }))
    addContextComponent(store, 'c1', makeComp({ id: 'b' }))
    expect(store.get(contextPanelAtom('c1'))).toHaveLength(2)
  })
})

describe('N2: clearDynamicContext', () => {
  it('清除 persistent=false 的组件', () => {
    addContextComponent(store, 'c1', makeComp({ id: 'dyn', persistent: false }))
    addContextComponent(store, 'c1', makeComp({ id: 'persist', persistent: true }))
    clearDynamicContext(store, 'c1')
    const ctx = store.get(contextPanelAtom('c1'))
    expect(ctx).toHaveLength(1)
    expect(ctx[0].id).toBe('persist')
  })

  it('全为 persistent 时保留所有', () => {
    addContextComponent(store, 'c1', makeComp({ id: 'p1', persistent: true }))
    clearDynamicContext(store, 'c1')
    expect(store.get(contextPanelAtom('c1'))).toHaveLength(1)
  })
})

describe('N3: getContext', () => {
  it('返回当前列表', () => {
    addContextComponent(store, 'c1', makeComp())
    expect(getContext(store, 'c1')).toHaveLength(1)
  })

  it('空 session 返回空数组', () => {
    expect(getContext(store, 'nonexist')).toEqual([])
  })
})
