// 使用方法：npm test src/__tests__/capabilities/sessionRegistry.test.ts
// 编译说明：仅测试环境
// 代码说明：Phase 3-H Session 注册表能力组单元测试

import { describe, it, expect, beforeEach } from 'vitest'
import { createTestStore } from '../helpers/createTestStore'
import type { TestStore } from '../helpers/createTestStore'
import {
  createSession,
  patchSession,
  completeSession,
  getSession,
  findSessionByCwd,
  findSessionByPtyId,
} from '@renderer/capabilities/sessionRegistry'
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import type { Session } from '@shared/types/index'
import type { PtyBindings } from '@renderer/atoms/pty-binding.atom'

function makeSession(override: Partial<Session> = {}): Session {
  return {
    id: 'pty-1',
    claudeId: 'claude-1',
    projectId: 'proj-1',
    status: 'Running',
    currentModel: null,
    tokenUsage: { current: null, max: null, usedPercentage: null },
    transcriptPath: null,
    cwd: '/home/tony/proj',
    startedAt: 1000,
    endedAt: null,
    worktreePath: null,
    ...override,
  }
}

function makeBindings(map: Record<string, string> = {}): PtyBindings {
  return {
    ptyToClaudeMap: new Map(Object.entries(map)),
    claudeToPtyMap: new Map(Object.entries(map).map(([k, v]) => [v, k])),
  }
}

let store: TestStore

beforeEach(() => { store = createTestStore() })

// ── H1: createSession ───────────────────────────────────────────────────────

describe('H1: createSession', () => {
  it('以指定 key 写入 Map', () => {
    const sess = makeSession()
    createSession(store, 'c1', sess)
    expect(store.get(activeSessionsAtom).get('c1')).toEqual(sess)
  })

  it('多次调用写入多条 entry', () => {
    createSession(store, 'c1', makeSession({ claudeId: 'c1' }))
    createSession(store, 'c2', makeSession({ claudeId: 'c2' }))
    expect(store.get(activeSessionsAtom).size).toBe(2)
  })

  it('覆盖相同 key 的旧 entry', () => {
    createSession(store, 'c1', makeSession({ status: 'Running' }))
    createSession(store, 'c1', makeSession({ status: 'Paused' }))
    expect(store.get(activeSessionsAtom).get('c1')?.status).toBe('Paused')
  })
})

// ── H3: patchSession ────────────────────────────────────────────────────────

describe('H3: patchSession', () => {
  it('部分更新 status 字段', () => {
    createSession(store, 'c1', makeSession({ status: 'Running' }))
    patchSession(store, 'c1', { status: 'Paused' })
    expect(store.get(activeSessionsAtom).get('c1')?.status).toBe('Paused')
  })

  it('其他字段不受影响', () => {
    createSession(store, 'c1', makeSession({ projectId: 'proj-x', status: 'Running' }))
    patchSession(store, 'c1', { status: 'Paused' })
    expect(store.get(activeSessionsAtom).get('c1')?.projectId).toBe('proj-x')
  })

  it('key 不存在时无副作用', () => {
    patchSession(store, 'nonexist', { status: 'Paused' })
    expect(store.get(activeSessionsAtom).size).toBe(0)
  })

  it('可更新 transcriptPath', () => {
    createSession(store, 'c1', makeSession())
    patchSession(store, 'c1', { transcriptPath: '/new/path.jsonl' })
    expect(store.get(activeSessionsAtom).get('c1')?.transcriptPath).toBe('/new/path.jsonl')
  })
})

// ── H4: completeSession ─────────────────────────────────────────────────────

describe('H4: completeSession', () => {
  it('status → Completed，endedAt 被设置', () => {
    createSession(store, 'c1', makeSession({ status: 'Running' }))
    completeSession(store, 'c1', 9999)
    const s = store.get(activeSessionsAtom).get('c1')!
    expect(s.status).toBe('Completed')
    expect(s.endedAt).toBe(9999)
  })

  it('其他字段不丢失', () => {
    createSession(store, 'c1', makeSession({ cwd: '/proj/foo' }))
    completeSession(store, 'c1', 1)
    expect(store.get(activeSessionsAtom).get('c1')?.cwd).toBe('/proj/foo')
  })
})

// ── H5: getSession ──────────────────────────────────────────────────────────

describe('H5: getSession', () => {
  it('存在时返回 Session', () => {
    const sess = makeSession()
    createSession(store, 'c1', sess)
    expect(getSession(store, 'c1')).toEqual(sess)
  })

  it('不存在时返回 undefined', () => {
    expect(getSession(store, 'nonexist')).toBeUndefined()
  })
})

// ── H6: findSessionByCwd ────────────────────────────────────────────────────

describe('H6: findSessionByCwd', () => {
  it('精确 cwd 匹配', () => {
    createSession(store, 'c1', makeSession({ cwd: '/proj' }))
    const result = findSessionByCwd(store, '/proj')
    expect(result).toBeDefined()
    expect(result![0]).toBe('c1')
  })

  it('子路径 startsWith 匹配', () => {
    createSession(store, 'c1', makeSession({ cwd: '/proj' }))
    const result = findSessionByCwd(store, '/proj/sub/deep')
    expect(result).toBeDefined()
    expect(result![0]).toBe('c1')
  })

  it('不匹配时返回 undefined', () => {
    createSession(store, 'c1', makeSession({ cwd: '/proj' }))
    expect(findSessionByCwd(store, '/other')).toBeUndefined()
  })

  it('不把 /proj2 误匹配为 /proj 的子路径', () => {
    createSession(store, 'c1', makeSession({ cwd: '/proj' }))
    expect(findSessionByCwd(store, '/proj2')).toBeUndefined()
  })

  it('多个 session 时返回第一个匹配', () => {
    createSession(store, 'c1', makeSession({ cwd: '/proj' }))
    createSession(store, 'c2', makeSession({ cwd: '/other' }))
    const result = findSessionByCwd(store, '/proj')
    expect(result![0]).toBe('c1')
  })
})

// ── H7: findSessionByPtyId ──────────────────────────────────────────────────

describe('H7: findSessionByPtyId', () => {
  it('通过绑定表查到 claudeId 再查 Session', () => {
    const sess = makeSession({ claudeId: 'c1' })
    createSession(store, 'c1', sess)
    const bindings = makeBindings({ 'p1': 'c1' })
    expect(findSessionByPtyId(store, 'p1', bindings)).toEqual(sess)
  })

  it('ptyId 未绑定时返回 undefined', () => {
    const bindings = makeBindings({})
    expect(findSessionByPtyId(store, 'p-unknown', bindings)).toBeUndefined()
  })

  it('ptyId 绑定了 claudeId 但 session 不存在时返回 undefined', () => {
    const bindings = makeBindings({ 'p1': 'c-missing' })
    expect(findSessionByPtyId(store, 'p1', bindings)).toBeUndefined()
  })
})
