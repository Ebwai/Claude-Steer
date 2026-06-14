// 使用方法：npm test src/__tests__/business/sessionLifecycle.test.ts
// 编译说明：仅测试环境
// 代码说明：BL-2 Session 生命周期业务单元测试

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import { createSessionLifecycle } from '@renderer/business/sessionLifecycle'
import { createSession } from '@renderer/capabilities/sessionRegistry'
import { addToRealtime } from '@renderer/capabilities/realtimeVisibility'
import { activeSessionsAtom, ptySessionIdsAtom } from '@renderer/atoms/session-core.atom'
import { agentBlocksAtom } from '@renderer/atoms/agent-block.atom'
import { pendingPtyStartsAtom } from '@renderer/atoms/pending-starts.atom'
import type { Session } from '@shared/types/index'
import { toolStart } from '@renderer/capabilities/agentActivity'

function makeSession(override: Partial<Session> = {}): Session {
  return {
    id: 'p1', claudeId: 'c1', projectId: 'proj-1', status: 'Running',
    currentModel: null, tokenUsage: { current: null, max: null, usedPercentage: null },
    transcriptPath: null, cwd: '/proj', startedAt: 1000, endedAt: null, worktreePath: null,
    ...override,
  }
}

let store: TestStore
let lifecycle: ReturnType<typeof createSessionLifecycle>

beforeEach(() => {
  store = createTestStore()
  lifecycle = createSessionLifecycle(store)
})

// ── SessionStart ─────────────────────────────────────────────────────────────

describe('BL-2: handleSessionStart', () => {
  it('情况A：claudeId 已存在，更新 transcriptPath 和 status', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1', transcriptPath: null }))
    lifecycle.handleSessionStart({ sessionId: 'c1', cwd: '/proj', transcriptPath: '/t.jsonl', receivedAt: 2000 })
    expect(store.get(activeSessionsAtom).get('c1')?.transcriptPath).toBe('/t.jsonl')
    expect(store.get(activeSessionsAtom).get('c1')?.status).toBe('Running')
  })

  it('情况A：从 pending 补全 projectId', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1', projectId: '' }))
    store.set(pendingPtyStartsAtom, new Map([['/proj', { ptyId: 'p1', projectId: 'proj-42' }]]))
    lifecycle.handleSessionStart({ sessionId: 'c1', cwd: '/proj', receivedAt: 2000 })
    expect(store.get(activeSessionsAtom).get('c1')?.projectId).toBe('proj-42')
  })

  it('情况B：claudeId 不存在，从 pending 创建 entry（正常路径）', () => {
    store.set(pendingPtyStartsAtom, new Map([['/proj', { ptyId: 'p1', projectId: 'proj-x' }]]))
    lifecycle.handleSessionStart({ sessionId: 'c1', cwd: '/proj', transcriptPath: '/t.jsonl', receivedAt: 2000 })
    const sess = store.get(activeSessionsAtom).get('c1')
    expect(sess).toBeDefined()
    expect(sess?.id).toBe('p1')
    expect(sess?.projectId).toBe('proj-x')
    expect(store.get(ptySessionIdsAtom).has('c1')).toBe(true)
    // pending 消费后清除
    expect(store.get(pendingPtyStartsAtom).has('/proj')).toBe(false)
  })

  it('情况B：外部启动（无 pending），新建外部 entry', () => {
    lifecycle.handleSessionStart({ sessionId: 'c-ext', cwd: '/ext', receivedAt: 1000 })
    const sess = store.get(activeSessionsAtom).get('c-ext')
    expect(sess).toBeDefined()
    expect(sess?.id).toBe('c-ext')  // 无 ptyId 时用 claudeId 占位
    expect(store.get(ptySessionIdsAtom).has('c-ext')).toBe(true)
  })
})

// ── SessionEnd ───────────────────────────────────────────────────────────────

describe('BL-2: handleSessionEnd', () => {
  it('正常结束：status→Completed，endedAt 设置', () => {
    createSession(store, 'c1', makeSession({ status: 'Running' }))
    lifecycle.handleSessionEnd({ sessionId: 'c1', cwd: '/proj', receivedAt: 9999 })
    const s = store.get(activeSessionsAtom).get('c1')!
    expect(s.status).toBe('Completed')
    expect(s.endedAt).toBe(9999)
  })

  it('正常结束后从实时面板移除', () => {
    createSession(store, 'c1', makeSession())
    addToRealtime(store, 'c1')
    lifecycle.handleSessionEnd({ sessionId: 'c1', cwd: '/proj', receivedAt: 9999 })
    expect(store.get(ptySessionIdsAtom).has('c1')).toBe(false)
  })

  it('claudeId 不存在时无副作用', () => {
    lifecycle.handleSessionEnd({ sessionId: 'nonexist', cwd: '/no', receivedAt: 1 })
    expect(store.get(activeSessionsAtom).size).toBe(0)
  })
})

// ── Stop ─────────────────────────────────────────────────────────────────────

describe('BL-2: handleStop', () => {
  it('Running → Paused', () => {
    createSession(store, 'c1', makeSession({ status: 'Running' }))
    lifecycle.handleStop({ sessionId: 'c1', cwd: '/proj' })
    expect(store.get(activeSessionsAtom).get('c1')?.status).toBe('Paused')
  })

  it('非 Running 状态不改变', () => {
    createSession(store, 'c1', makeSession({ status: 'Paused' }))
    lifecycle.handleStop({ sessionId: 'c1', cwd: '/proj' })
    expect(store.get(activeSessionsAtom).get('c1')?.status).toBe('Paused')
  })

  it('Stop 后 agentBlock workStatusText 清空', () => {
    toolStart(store, 'c1', '/proj', { id: 't1', toolName: 'Read', displayText: '读取', category: 'tool', startedAt: 1000 })
    lifecycle.handleStop({ sessionId: 'c1', cwd: '/proj' })
    expect(store.get(agentBlocksAtom).get('c1')?.workStatusText).toBe('')
  })
})
