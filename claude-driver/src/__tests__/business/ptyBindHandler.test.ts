// 使用方法：npm test src/__tests__/business/ptyBindHandler.test.ts
// 编译说明：仅测试环境
// 代码说明：BL-1 PTY_BIND / PTY_UNBIND 业务处理单元测试
//           activeSessionsAtom entry 以 claudeId 为 key（SessionStart Hook 创建），
//           PTY_BIND 只走路径 B（claudeId 存在）或路径 C（外部启动）

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import { createPtyBindHandler } from '@renderer/business/ptyBindHandler'
import { ptyBindingsAtom } from '@renderer/atoms/pty-binding.atom'
import { activeSessionsAtom, ptySessionIdsAtom } from '@renderer/atoms/session-core.atom'
import { pendingPtyStartsAtom } from '@renderer/atoms/pending-starts.atom'
import { createSession } from '@renderer/capabilities/sessionRegistry'
import { addToRealtime } from '@renderer/capabilities/realtimeVisibility'
import type { Session } from '@shared/types/index'

function makeSession(override: Partial<Session> = {}): Session {
  return {
    id: 'p1',
    claudeId: 'c1',
    projectId: 'proj-1',
    status: 'Running',
    currentModel: null,
    tokenUsage: { current: null, max: null, usedPercentage: null },
    transcriptPath: null,
    cwd: '/proj',
    startedAt: 1000,
    endedAt: null,
    worktreePath: null,
    ...override,
  }
}

let store: TestStore
let handler: ReturnType<typeof createPtyBindHandler>

beforeEach(() => {
  store = createTestStore()
  handler = createPtyBindHandler(store)
})

// ── PTY_BIND 路径 B：byClaude 存在（SessionStart Hook 已创建 entry）──────────

describe('PTY_BIND 路径B: claudeId entry 已存在', () => {
  it('claudeId entry 的 id 字段更新为 ptyId', () => {
    createSession(store, 'c1', makeSession({ id: 'c1', claudeId: 'c1' }))
    handler.handleBind({ ptyId: 'p1', claudeId: 'c1' })
    expect(store.get(activeSessionsAtom).get('c1')?.id).toBe('p1')
  })

  it('Map size 不变（不新增 entry）', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    handler.handleBind({ ptyId: 'p1', claudeId: 'c1' })
    expect(store.get(activeSessionsAtom).size).toBe(1)
  })

  it('claudeId 不在可见集合时自动加入', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    handler.handleBind({ ptyId: 'p1', claudeId: 'c1' })
    expect(store.get(ptySessionIdsAtom).has('c1')).toBe(true)
  })

  it('claudeId 已在可见集合时不重复加入（幂等）', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    addToRealtime(store, 'c1')
    handler.handleBind({ ptyId: 'p1', claudeId: 'c1' })
    expect(store.get(ptySessionIdsAtom).size).toBe(1)
  })

  it('transcriptPath 更新到 entry', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1', transcriptPath: null }))
    handler.handleBind({ ptyId: 'p1', claudeId: 'c1', transcriptPath: '/path/session.jsonl' })
    expect(store.get(activeSessionsAtom).get('c1')?.transcriptPath).toBe('/path/session.jsonl')
  })

  it('双向绑定表建立', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    handler.handleBind({ ptyId: 'p1', claudeId: 'c1' })
    expect(store.get(ptyBindingsAtom).ptyToClaudeMap.get('p1')).toBe('c1')
    expect(store.get(ptyBindingsAtom).claudeToPtyMap.get('c1')).toBe('p1')
  })

  it('resume 场景：id 更新为新 ptyId', () => {
    createSession(store, 'c1', makeSession({ id: 'p-old', claudeId: 'c1' }))
    handler.handleBind({ ptyId: 'p-new', claudeId: 'c1', transcriptPath: '/new.jsonl', cwd: '/proj' })
    expect(store.get(activeSessionsAtom).get('c1')?.id).toBe('p-new')
  })
})

// ── PTY_BIND 路径 C：entry 不存在（SessionStart Hook 尚未到达）──────────────

describe('PTY_BIND 路径C: entry 不存在', () => {
  it('新建 claudeId-keyed entry（外部启动，无 pending）', () => {
    handler.handleBind({ ptyId: 'p-ext', claudeId: 'c-ext', cwd: '/ext' })
    const sess = store.get(activeSessionsAtom).get('c-ext')
    expect(sess).toBeDefined()
    expect(sess?.id).toBe('p-ext')
    expect(sess?.claudeId).toBe('c-ext')
  })

  it('加入实时面板可见集合', () => {
    handler.handleBind({ ptyId: 'p-ext', claudeId: 'c-ext' })
    expect(store.get(ptySessionIdsAtom).has('c-ext')).toBe(true)
  })

  it('有 pending 时补全 projectId 并消费 pending', () => {
    store.set(pendingPtyStartsAtom, new Map([['/myproj', { ptyId: 'p-ext', projectId: 'proj-42' }]]))
    handler.handleBind({ ptyId: 'p-ext', claudeId: 'c-ext', cwd: '/myproj' })
    expect(store.get(activeSessionsAtom).get('c-ext')?.projectId).toBe('proj-42')
    // pending 消费后清除
    expect(store.get(pendingPtyStartsAtom).has('/myproj')).toBe(false)
  })
})

// ── PTY_UNBIND ───────────────────────────────────────────────────────────────

describe('PTY_UNBIND: 仅清绑定表', () => {
  it('清除双向绑定', () => {
    createSession(store, 'c1', makeSession())
    handler.handleBind({ ptyId: 'p1', claudeId: 'c1' })
    handler.handleUnbind({ ptyId: 'p1', claudeId: 'c1' })
    expect(store.get(ptyBindingsAtom).ptyToClaudeMap.has('p1')).toBe(false)
  })

  it('不改变 session 状态（/branch 时父 session 不能消失）', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1', status: 'Running' }))
    handler.handleBind({ ptyId: 'p1', claudeId: 'c1' })
    handler.handleUnbind({ ptyId: 'p1', claudeId: 'c1' })
    expect(store.get(activeSessionsAtom).get('c1')?.status).toBe('Running')
  })
})
