// 使用方法：npm test src/__tests__/atoms/
// 编译说明：仅测试环境
// 代码说明：Phase 2 验收——各 atom 初始值正确，re-export 壳正常工作

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'

// 从拆分后的子文件导入
import { activeSessionsAtom, ptySessionIdsAtom } from '@renderer/atoms/session-core.atom'
import { ptyBindingsAtom } from '@renderer/atoms/pty-binding.atom'
import { sessionRelationsAtom, branchCountAtom } from '@renderer/atoms/branch.atom'
import { agentBlocksAtom } from '@renderer/atoms/agent-block.atom'
import { contextPanelAtom } from '@renderer/atoms/context-panel.atom'
import { permissionRequestsAtom } from '@renderer/atoms/permission.atom'
import { pendingPtyStartsAtom } from '@renderer/atoms/pending-starts.atom'

// 从 re-export 壳导入（验证向后兼容）
import {
  activeSessionsAtom as activeSessions2,
  ptySessionIdsAtom as ptySessionIds2,
  ptyBindingsAtom as ptyBindings2,
  sessionRelationsAtom as sessionRelations2,
  agentBlocksAtom as agentBlocks2,
  permissionRequestsAtom as permRequests2,
} from '@renderer/atoms/sessions.atom'

let store: TestStore

beforeEach(() => { store = createTestStore() })

describe('Phase 2: atom 初始值', () => {
  it('activeSessionsAtom 初始为空 Map', () => {
    expect(store.get(activeSessionsAtom)).toBeInstanceOf(Map)
    expect(store.get(activeSessionsAtom).size).toBe(0)
  })

  it('ptySessionIdsAtom 初始为空 Set', () => {
    expect(store.get(ptySessionIdsAtom)).toBeInstanceOf(Set)
    expect(store.get(ptySessionIdsAtom).size).toBe(0)
  })

  it('ptyBindingsAtom 初始双 Map 为空', () => {
    const b = store.get(ptyBindingsAtom)
    expect(b.ptyToClaudeMap.size).toBe(0)
    expect(b.claudeToPtyMap.size).toBe(0)
  })

  it('sessionRelationsAtom 初始为空 Map', () => {
    expect(store.get(sessionRelationsAtom).size).toBe(0)
  })

  it('branchCountAtom 初始为空 Map', () => {
    expect(store.get(branchCountAtom).size).toBe(0)
  })

  it('agentBlocksAtom 初始为空 Map', () => {
    expect(store.get(agentBlocksAtom).size).toBe(0)
  })

  it('contextPanelAtom 初始为空数组', () => {
    expect(store.get(contextPanelAtom('c1'))).toEqual([])
  })

  it('permissionRequestsAtom 初始为空数组', () => {
    expect(store.get(permissionRequestsAtom)).toEqual([])
  })

  it('pendingPtyStartsAtom 初始为空 Map', () => {
    expect(store.get(pendingPtyStartsAtom).size).toBe(0)
  })
})

describe('Phase 2: re-export 壳向后兼容', () => {
  it('activeSessionsAtom 是同一 atom 实例', () => {
    expect(activeSessions2).toBe(activeSessionsAtom)
  })

  it('ptySessionIdsAtom 是同一 atom 实例', () => {
    expect(ptySessionIds2).toBe(ptySessionIdsAtom)
  })

  it('ptyBindingsAtom 是同一 atom 实例', () => {
    expect(ptyBindings2).toBe(ptyBindingsAtom)
  })

  it('sessionRelationsAtom 是同一 atom 实例', () => {
    expect(sessionRelations2).toBe(sessionRelationsAtom)
  })

  it('agentBlocksAtom 是同一 atom 实例', () => {
    expect(agentBlocks2).toBe(agentBlocksAtom)
  })

  it('permissionRequestsAtom 是同一 atom 实例', () => {
    expect(permRequests2).toBe(permissionRequestsAtom)
  })

  it('re-export 的 set 操作与子文件 atom 共享同一 store 状态', () => {
    store.set(activeSessions2, (prev) => {
      const next = new Map(prev)
      next.set('c1', { id: 'p1', claudeId: 'c1' } as never)
      return next
    })
    expect(store.get(activeSessionsAtom).has('c1')).toBe(true)
  })
})
