// 使用方法：npm test src/__tests__/business/branchHandler.test.ts
// 编译说明：仅测试环境
// 代码说明：BL-3 Branch 处理业务单元测试（状态机版本）

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import { createBranchHandler } from '@renderer/business/branchHandler'
import { createSession } from '@renderer/capabilities/sessionRegistry'
import { addToRealtime, isRealtimeVisible } from '@renderer/capabilities/realtimeVisibility'
import { bindPty } from '@renderer/capabilities/ptyBindings'
import { sessionRelationsAtom } from '@renderer/atoms/branch.atom'
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import type { Session } from '@shared/types/index'
import { cachePendingSnapshot } from '@renderer/capabilities/branchRegistry'

function makeSession(override: Partial<Session> = {}): Session {
  return {
    id: 'p1', claudeId: 'c1', projectId: 'proj-1', status: 'Running',
    currentModel: null, tokenUsage: { current: null, max: null, usedPercentage: null },
    transcriptPath: null, cwd: '/proj', startedAt: 1000, endedAt: null, worktreePath: null,
    ...override,
  }
}

let store: TestStore
let handler: ReturnType<typeof createBranchHandler>

beforeEach(() => {
  store = createTestStore()
  handler = createBranchHandler(store)
})

// ── handlePreNotify ───────────────────────────────────────────────────────────

describe('BL-3: handlePreNotify', () => {
  it('有 parentClaudeId 时直接存入状态机', () => {
    // preNotify 后 state = PENDING_CONFIRM；后续 handleConfirm 能进入
    handler.handlePreNotify('p1', 'c1')
    // 验证：confirm 可以成功（不 warn）
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    addToRealtime(store, 'c1')
    handler.handleConfirm('p1', 'old-branch-id')
    expect(isRealtimeVisible(store, 'c1')).toBe(false)
  })

  it('ptyId 有绑定时从绑定表解析 claudeId', () => {
    bindPty(store, 'p1', 'c1')
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    addToRealtime(store, 'c1')
    handler.handlePreNotify('p1')  // 无显式 parentClaudeId，靠绑定表
    handler.handleConfirm('p1', 'old-branch-id')
    expect(isRealtimeVisible(store, 'c1')).toBe(false)
  })
})

// ── handleConfirm ─────────────────────────────────────────────────────────────

describe('BL-3: handleConfirm', () => {
  it('parent 从实时面板移除', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    addToRealtime(store, 'c1')
    handler.handlePreNotify('p1', 'c1')
    handler.handleConfirm('p1', 'old-branch-id')
    expect(isRealtimeVisible(store, 'c1')).toBe(false)
  })

  it('parent status → Completed', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1', status: 'Running' }))
    handler.handlePreNotify('p1', 'c1')
    handler.handleConfirm('p1', 'old-branch-id')
    expect(store.get(activeSessionsAtom).get('c1')?.status).toBe('Completed')
  })

  it('未经 preNotify 直接 confirm 无副作用（warn）', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    addToRealtime(store, 'c1')
    // 没有 handlePreNotify，state 是 IDLE
    handler.handleConfirm('p1', 'old-branch-id')
    // parent 不应被移除
    expect(isRealtimeVisible(store, 'c1')).toBe(true)
  })
})

// ── handlePtyBind ─────────────────────────────────────────────────────────────

describe('BL-3: handlePtyBind', () => {
  it('PENDING_BIND 时创建子 session 并加入实时面板', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1', projectId: 'proj-x' }))
    handler.handlePreNotify('p1', 'c1')
    handler.handleConfirm('p1', 'old-branch-id')
    handler.handlePtyBind('p1', 'c-new', null, '/proj')
    const child = store.get(activeSessionsAtom).get('c-new')
    expect(child).toBeDefined()
    expect(child?.projectId).toBe('proj-x')
    expect(child?.status).toBe('Running')
    expect(isRealtimeVisible(store, 'c-new')).toBe(true)
  })

  it('注册 branch 关系', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    handler.handlePreNotify('p1', 'c1')
    handler.handleConfirm('p1', 'old-branch-id')
    handler.handlePtyBind('p1', 'c-new', null, '/proj')
    const rel = store.get(sessionRelationsAtom).get('c-new')
    expect(rel?.type).toBe('branch')
    expect(rel?.parentSessionId).toBe('c1')
  })

  it('ptyId 不匹配时无操作', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    handler.handlePreNotify('p1', 'c1')
    handler.handleConfirm('p1', 'old-branch-id')
    handler.handlePtyBind('p-other', 'c-new', null, '/proj')
    expect(store.get(activeSessionsAtom).has('c-new')).toBe(false)
  })

  it('消费 pendingSnapshot（竞态：snapshot 早于 PTY_BIND）', () => {
    cachePendingSnapshot('old-branch-id', 'uuid-early')
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    handler.handlePreNotify('p1', 'c1')
    handler.handleConfirm('p1', 'old-branch-id')
    handler.handlePtyBind('p1', 'c-new', null, '/proj')
    expect(store.get(sessionRelationsAtom).get('c-new')?.branchStartUuid).toBe('uuid-early')
  })
})

// ── handleBranchSnapshot ──────────────────────────────────────────────────────

describe('BL-3: handleBranchSnapshot', () => {
  it('relation 已存在时直接更新 branchStartUuid', () => {
    createSession(store, 'c1', makeSession())
    handler.handlePreNotify('p1', 'c1')
    handler.handleConfirm('p1', 'old-branch-id')
    handler.handlePtyBind('p1', 'c-new', null, '/proj')
    handler.handleBranchSnapshot('c-new', 'uuid-late')
    expect(store.get(sessionRelationsAtom).get('c-new')?.branchStartUuid).toBe('uuid-late')
  })

  it('relation 不存在时缓存到 pendingSnapshots，PTY_BIND 后合并', () => {
    handler.handleBranchSnapshot('old-branch-id', 'uuid-cache')
    createSession(store, 'c1', makeSession())
    handler.handlePreNotify('p1', 'c1')
    handler.handleConfirm('p1', 'old-branch-id')
    handler.handlePtyBind('p1', 'c-new', null, '/proj')
    expect(store.get(sessionRelationsAtom).get('c-new')?.branchStartUuid).toBe('uuid-cache')
  })
})
