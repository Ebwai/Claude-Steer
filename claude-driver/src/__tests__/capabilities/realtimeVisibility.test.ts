// 使用方法：npm test src/__tests__/capabilities/realtimeVisibility.test.ts
// 编译说明：仅测试环境
// 代码说明：Phase 3-J 实时面板可见性能力组单元测试

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import {
  addToRealtime,
  removeFromRealtime,
  isRealtimeVisible,
  getRealtimeVisible,
} from '@renderer/capabilities/realtimeVisibility'
import { ptySessionIdsAtom } from '@renderer/atoms/session-core.atom'

let store: TestStore

beforeEach(() => { store = createTestStore() })

// ── J1: addToRealtime ────────────────────────────────────────────────────────

describe('J1: addToRealtime', () => {
  it('加入后 Set 包含该 claudeId', () => {
    addToRealtime(store, 'c1')
    expect(store.get(ptySessionIdsAtom).has('c1')).toBe(true)
  })

  it('重复加入不增加 size', () => {
    addToRealtime(store, 'c1')
    addToRealtime(store, 'c1')
    expect(store.get(ptySessionIdsAtom).size).toBe(1)
  })

  it('多个 session 独立加入', () => {
    addToRealtime(store, 'c1')
    addToRealtime(store, 'c2')
    expect(store.get(ptySessionIdsAtom).size).toBe(2)
  })
})

// ── J2: removeFromRealtime ───────────────────────────────────────────────────

describe('J2: removeFromRealtime', () => {
  it('移除后 Set 不包含该 claudeId', () => {
    addToRealtime(store, 'c1')
    removeFromRealtime(store, 'c1')
    expect(store.get(ptySessionIdsAtom).has('c1')).toBe(false)
  })

  it('不存在的 claudeId 移除无副作用', () => {
    addToRealtime(store, 'c1')
    removeFromRealtime(store, 'nonexist')
    expect(store.get(ptySessionIdsAtom).size).toBe(1)
  })

  it('移除不影响其他 session', () => {
    addToRealtime(store, 'c1')
    addToRealtime(store, 'c2')
    removeFromRealtime(store, 'c1')
    expect(store.get(ptySessionIdsAtom).has('c2')).toBe(true)
  })
})

// ── J3: isRealtimeVisible ────────────────────────────────────────────────────

describe('J3: isRealtimeVisible', () => {
  it('存在时返回 true', () => {
    addToRealtime(store, 'c1')
    expect(isRealtimeVisible(store, 'c1')).toBe(true)
  })

  it('不存在时返回 false', () => {
    expect(isRealtimeVisible(store, 'nonexist')).toBe(false)
  })

  it('移除后返回 false', () => {
    addToRealtime(store, 'c1')
    removeFromRealtime(store, 'c1')
    expect(isRealtimeVisible(store, 'c1')).toBe(false)
  })
})

// ── J4: getRealtimeVisible ───────────────────────────────────────────────────

describe('J4: getRealtimeVisible', () => {
  it('返回当前可见集合快照', () => {
    addToRealtime(store, 'c1')
    addToRealtime(store, 'c2')
    const visible = getRealtimeVisible(store)
    expect(visible.has('c1')).toBe(true)
    expect(visible.has('c2')).toBe(true)
    expect(visible.size).toBe(2)
  })

  it('初始为空集合', () => {
    expect(getRealtimeVisible(store).size).toBe(0)
  })
})
