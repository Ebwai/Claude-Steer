// 使用方法：npm test src/__tests__/capabilities/ptyBindings.test.ts
// 编译说明：仅测试环境
// 代码说明：Phase 3-I PTY 绑定表能力组单元测试

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import { bindPty, unbindPty, resolveClaudeId, resolvePtyId } from '@renderer/capabilities/ptyBindings'
import { ptyBindingsAtom } from '@renderer/atoms/pty-binding.atom'

let store: TestStore

beforeEach(() => { store = createTestStore() })

// ── I1: bindPty ──────────────────────────────────────────────────────────────

describe('I1: bindPty', () => {
  it('建立双向绑定', () => {
    bindPty(store, 'p1', 'c1')
    const b = store.get(ptyBindingsAtom)
    expect(b.ptyToClaudeMap.get('p1')).toBe('c1')
    expect(b.claudeToPtyMap.get('c1')).toBe('p1')
  })

  it('多次绑定互不干扰', () => {
    bindPty(store, 'p1', 'c1')
    bindPty(store, 'p2', 'c2')
    const b = store.get(ptyBindingsAtom)
    expect(b.ptyToClaudeMap.size).toBe(2)
    expect(b.claudeToPtyMap.size).toBe(2)
  })

  it('同一 ptyId 重新绑定到新 claudeId（覆盖）', () => {
    bindPty(store, 'p1', 'c1')
    bindPty(store, 'p1', 'c2')
    const b = store.get(ptyBindingsAtom)
    expect(b.ptyToClaudeMap.get('p1')).toBe('c2')
    // c1 的旧映射未主动清除（unbindPty 负责清理旧 claudeId 条目）
  })
})

// ── I2: unbindPty ────────────────────────────────────────────────────────────

describe('I2: unbindPty', () => {
  it('解除绑定后双向表均移除', () => {
    bindPty(store, 'p1', 'c1')
    unbindPty(store, 'p1', 'c1')
    const b = store.get(ptyBindingsAtom)
    expect(b.ptyToClaudeMap.has('p1')).toBe(false)
    expect(b.claudeToPtyMap.has('c1')).toBe(false)
  })

  it('不影响其他绑定对', () => {
    bindPty(store, 'p1', 'c1')
    bindPty(store, 'p2', 'c2')
    unbindPty(store, 'p1', 'c1')
    const b = store.get(ptyBindingsAtom)
    expect(b.ptyToClaudeMap.get('p2')).toBe('c2')
    expect(b.claudeToPtyMap.get('c2')).toBe('p2')
  })

  it('ptyId 不存在时无副作用', () => {
    bindPty(store, 'p1', 'c1')
    unbindPty(store, 'nonexist', 'c1')
    expect(store.get(ptyBindingsAtom).ptyToClaudeMap.size).toBe(1)
  })

  it('claudeId 不存在时无副作用', () => {
    bindPty(store, 'p1', 'c1')
    unbindPty(store, 'p1', 'nonexist')
    expect(store.get(ptyBindingsAtom).claudeToPtyMap.size).toBe(1)
  })
})

// ── I3: resolveClaudeId ──────────────────────────────────────────────────────

describe('I3: resolveClaudeId', () => {
  it('存在时返回 claudeId', () => {
    bindPty(store, 'p1', 'c1')
    expect(resolveClaudeId(store, 'p1')).toBe('c1')
  })

  it('不存在时返回 undefined', () => {
    expect(resolveClaudeId(store, 'nonexist')).toBeUndefined()
  })
})

// ── I4: resolvePtyId ─────────────────────────────────────────────────────────

describe('I4: resolvePtyId', () => {
  it('存在时返回 ptyId', () => {
    bindPty(store, 'p1', 'c1')
    expect(resolvePtyId(store, 'c1')).toBe('p1')
  })

  it('不存在时返回 undefined', () => {
    expect(resolvePtyId(store, 'nonexist')).toBeUndefined()
  })
})
