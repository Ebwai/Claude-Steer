// 使用方法：npm test -- src/__tests__/hooks/historyWorkingSet.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：Cluster 热/温/冷工作集和 Branch 原子性边界测试

import { describe, expect, it } from 'vitest'
import type { HistoryClusterSummary } from '@shared/types/history'
import { computeHistoryWorkingSet } from '@renderer/hooks/historyWorkingSet'

function clusters(count: number): HistoryClusterSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    clusterId: `c${index}`,
    rootSessionId: `main${index}`,
    sessions: [
      {
        sessionId: `main${index}`,
        projectId: 'p',
        cwd: 'F:\\p',
        startedAt: index,
        endedAt: index + 1,
        parentSessionId: null,
        forkMessageUuid: null,
        clusterId: `c${index}`,
        sidecarFlags: { meta: false, insertions: false, milestones: false, gitMarks: false, sessionDirectory: false },
        subagentCount: 0,
      },
      {
        sessionId: `branch${index}`,
        projectId: 'p',
        cwd: 'F:\\p',
        startedAt: index + 0.5,
        endedAt: index + 1,
        parentSessionId: `main${index}`,
        forkMessageUuid: `fork${index}`,
        clusterId: `c${index}`,
        sidecarFlags: { meta: false, insertions: false, milestones: false, gitMarks: false, sessionDirectory: false },
        subagentCount: 0,
      },
    ],
    startedAt: index,
    endedAt: index + 1,
    isOrphaned: false,
  }))
}

describe('history working set', () => {
  it('合并最近 5、锚点 ±2、温区 ±3～4 与实时 Cluster', () => {
    const result = computeHistoryWorkingSet({
      clusters: clusters(15),
      anchorSessionId: 'main5',
      realtimeClusterIds: ['c0'],
    })
    expect([...result.hot]).toEqual(expect.arrayContaining(['c0', 'c3', 'c5', 'c7', 'c10', 'c14']))
    expect([...result.warm].sort()).toEqual(['c1', 'c2', 'c8', 'c9'])
    expect(result.cold.has('c6')).toBe(false)
  })

  it('远距离目标立即成为新的工作集中心', () => {
    const result = computeHistoryWorkingSet({
      clusters: clusters(20),
      anchorSessionId: 'main18',
      targetSessionId: 'main3',
      direction: 'left',
    })
    expect(result.targetClusterId).toBe('c3')
    expect(result.hot.has('c1')).toBe(true)
    expect(result.hot.has('c5')).toBe(true)
    expect(result.hot.has('c0')).toBe(false)
    expect(result.warm.has('c6')).toBe(true)
    expect(result.warm.has('c7')).toBe(true)
    expect(result.warm.has('c8')).toBe(false)
  })

  it('Branch 命中映射到完整 Cluster，不产生 Branch 级集合元素', () => {
    const result = computeHistoryWorkingSet({
      clusters: clusters(12),
      anchorSessionId: 'branch4',
    })
    expect(result.anchorClusterId).toBe('c4')
    expect([...result.hot].some((id) => id.startsWith('branch'))).toBe(false)
  })

  it('方向决定温区预热顺序', () => {
    const input = { clusters: clusters(20), anchorSessionId: 'main10' }
    const left = computeHistoryWorkingSet({ ...input, direction: 'left' })
    const right = computeHistoryWorkingSet({ ...input, direction: 'right' })
    expect(left.warmPriority[0]).toBe('c6')
    // c15-c19 属于“最近 5”热区，右向温区中最靠右的剩余项是 c14。
    expect(right.warmPriority[0]).toBe('c14')
  })
})
