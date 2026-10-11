// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryClusterSummary, HistoryDetailsState } from '@shared/types/history'
import { useHistoryWorkingSet } from '@renderer/hooks/useHistoryWorkingSet'

const clusters: HistoryClusterSummary[] = Array.from({ length: 30 }, (_, i) => ({
  clusterId: `session-${i}`, rootSessionId: `session-${i}`, startedAt: i, endedAt: i,
  isOrphaned: false, sessions: [{ sessionId: `session-${i}`, projectId: 'project', cwd: '/project', startedAt: i, endedAt: i, parentSessionId: null, forkMessageUuid: null, clusterId: `session-${i}`, subagentCount: 0, sidecarFlags: { meta: false, insertions: false, milestones: false, gitMarks: false, sessionDirectory: false } }],
}))

describe('history hydration retry scheduling', () => {
  it('does not loop on failure and retries after leaving the working set', async () => {
    const hydrateClusters = vi.fn().mockResolvedValue(undefined)
    const loader = { hydrateClusters, releaseClusters: vi.fn(), setInteractionBlocked: vi.fn(), cancelDetailRequests: vi.fn() }
    const base = { clusters, loader, generation: 'g1', targetSessionId: null, realtimeClusterIds: [], direction: 'none' as const, interactionPhase: 'idle' as const }
    const states = (first: HistoryDetailsState): Map<string, HistoryDetailsState> => new Map(clusters.map(c => [c.clusterId, c.clusterId === 'session-0' ? first : 'resident']))
    const { rerender } = renderHook(({ anchor, state }) => useHistoryWorkingSet({ ...base, anchorSessionId: anchor, detailsStateByCluster: states(state) }), {
      initialProps: { anchor: 'session-0', state: 'shell' as HistoryDetailsState },
    })
    await waitFor(() => expect(hydrateClusters).toHaveBeenCalledTimes(1))
    await act(async () => { rerender({ anchor: 'session-0', state: 'error' }) })
    expect(hydrateClusters).toHaveBeenCalledTimes(1)
    await act(async () => { rerender({ anchor: 'session-20', state: 'error' }) })
    await act(async () => { rerender({ anchor: 'session-0', state: 'error' }) })
    expect(hydrateClusters).toHaveBeenCalledTimes(2)
  })

  it('does not request missing histories or an empty project', async () => {
    const hydrateClusters = vi.fn().mockResolvedValue(undefined)
    const loader = { hydrateClusters, releaseClusters: vi.fn(), setInteractionBlocked: vi.fn(), cancelDetailRequests: vi.fn() }
    const input = { loader, targetSessionId: null, anchorSessionId: null, realtimeClusterIds: [], direction: 'none' as const, interactionPhase: 'idle' as const }
    const { rerender } = renderHook(({ catalog }) => useHistoryWorkingSet({ ...input, clusters: catalog, detailsStateByCluster: new Map(catalog.map(c => [c.clusterId, 'unavailable' as const])) }), { initialProps: { catalog: [] as HistoryClusterSummary[] } })
    await act(async () => { rerender({ catalog: clusters }) })
    expect(hydrateClusters).not.toHaveBeenCalled()
  })
})
