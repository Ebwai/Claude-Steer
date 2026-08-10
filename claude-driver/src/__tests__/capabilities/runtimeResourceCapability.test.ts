// 使用方法：npm test -- src/__tests__/capabilities/runtimeResourceCapability.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：验证 Session handoff 与项目卸载会精确释放大对象，同时保留运行中 PTY 能力

import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types/index'
import { createTestStore } from '../helpers/createTestStore'
import { activeSessionsAtom, ptySessionIdsAtom } from '@renderer/atoms/session-core.atom'
import {
  agentBlocksAtom,
  allFrameHeightsAtom,
  subagentIdsAtom,
} from '@renderer/atoms/agent-block.atom'
import { contextPanelAtom } from '@renderer/atoms/context-panel.atom'
import { permissionRequestsAtom } from '@renderer/atoms/permission.atom'
import {
  lineInsertionsBySessionAtom,
  subagentTimelineAtom,
  timelineBySessionAtom,
} from '@renderer/atoms/timeline.atom'
import { historyResidentManifestAtom } from '@renderer/atoms/history.atom'
import {
  releaseProjectRuntime,
  releaseSessionRuntime,
} from '@renderer/capabilities/runtimeResourceCapability'

const PROJECT_ID = 'project-runtime'

function session(id: string, status: Session['status']): Session {
  return {
    id: `pty-${id}`,
    claudeId: id,
    projectId: PROJECT_ID,
    status,
    currentModel: null,
    tokenUsage: { current: null, max: null, usedPercentage: null },
    transcriptPath: `F:\\work\\${id}.jsonl`,
    cwd: 'F:\\work',
    startedAt: 1,
    endedAt: status === 'Running' ? null : 2,
    worktreePath: null,
  }
}

describe('runtimeResourceCapability', () => {
  it('handoff preserves resident history projection while releasing realtime-only state', () => {
    const store = createTestStore()
    const id = 'history-owned'
    store.set(activeSessionsAtom, new Map([[id, session(id, 'Completed')]]))
    store.set(timelineBySessionAtom(id), [{ id: 'node-1', type: 'user_input', content: 'hello', timestamp: 1 }])
    store.set(agentBlocksAtom, new Map([[id, {
      sessionId: id,
      sessionCwd: 'F:\\work',
      workStatusText: 'working',
      activeTools: [],
      activeExperiences: [],
      activeSubagent: null,
      activeInsight: 'large insight',
    }]]))
    store.set(historyResidentManifestAtom, new Map([['cluster', {
      generation: 'g1',
      clusterId: 'cluster',
      sessionIds: [id],
      subagentIdsBySession: new Map([[id, []]]),
      triggerNodeIndexBySession: new Map([[id, null]]),
      frozenHeightBySession: new Map([[id, 400]]),
    }]]))

    const result = releaseSessionRuntime(store, id, { mode: 'handoff', reason: 'test' })

    expect(result.historyOwned).toBe(true)
    expect(store.get(timelineBySessionAtom(id))).toHaveLength(1)
    expect(store.get(agentBlocksAtom).has(id)).toBe(false)
    expect(store.get(activeSessionsAtom).has(id)).toBe(false)
  })

  it('project release clears heavy keyed state but preserves a running Session and realtime input visibility', () => {
    const store = createTestStore()
    const completedId = 'completed-session'
    const runningId = 'running-session'
    store.set(activeSessionsAtom, new Map([
      [completedId, session(completedId, 'Completed')],
      [runningId, session(runningId, 'Running')],
    ]))
    store.set(ptySessionIdsAtom, new Set([runningId]))
    store.set(timelineBySessionAtom(completedId), [{ id: 'completed-node', type: 'assistant', content: 'done', timestamp: 1 }])
    store.set(timelineBySessionAtom(runningId), [{ id: 'running-node', type: 'assistant', content: 'busy', timestamp: 1 }])
    store.set(lineInsertionsBySessionAtom(completedId), [{ id: 'line', type: 'thinking', sessionId: completedId, timestamp: 1 }])
    store.set(subagentIdsAtom(completedId), ['agent-1'])
    store.set(subagentTimelineAtom(`${completedId}::agent-1`), [{ id: 'sub-node', type: 'assistant', content: 'sub', timestamp: 1 }])
    store.set(contextPanelAtom(completedId), [{
      id: 'context',
      type: 'file',
      label: 'large file',
      tokenEstimate: 1000,
      persistent: false,
    }])
    store.set(allFrameHeightsAtom, new Map([[completedId, 800], [runningId, 900]]))
    store.set(permissionRequestsAtom, [{
      requestId: 'permission',
      sessionId: completedId,
      ptySessionId: 'pty',
      agentName: 'Agent',
      toolName: 'Bash',
      toolInput: {},
      description: 'test',
      receivedAt: 1,
    }])

    const result = releaseProjectRuntime(store, PROJECT_ID, { reason: 'test-project-unmount' })

    expect(result.sessionCount).toBe(2)
    expect(result.runningSessionsPreserved).toBe(1)
    expect(store.get(activeSessionsAtom).has(completedId)).toBe(false)
    expect(store.get(activeSessionsAtom).has(runningId)).toBe(true)
    expect(store.get(ptySessionIdsAtom).has(runningId)).toBe(true)
    expect(store.get(timelineBySessionAtom(completedId))).toEqual([])
    expect(store.get(timelineBySessionAtom(runningId))).toEqual([])
    expect(store.get(subagentTimelineAtom(`${completedId}::agent-1`))).toEqual([])
    expect(store.get(contextPanelAtom(completedId))).toEqual([])
    expect(store.get(allFrameHeightsAtom).has(completedId)).toBe(false)
    expect(store.get(allFrameHeightsAtom).has(runningId)).toBe(false)
    expect(store.get(permissionRequestsAtom)).toEqual([])
  })
})
