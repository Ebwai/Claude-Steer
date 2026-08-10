import { describe, expect, it } from 'vitest'
import { resolveHistoryHorizontalTarget } from '@renderer/hooks/historyHorizontalNavigation'
import type { RelationsMap } from '@renderer/hooks/useSessionFrameLayout'

const layouts = [
  { sessionId: 'older', x: -3080, y: 24, width: 1500 },
  { sessionId: 'main', x: -1540, y: 24, width: 1500 },
  { sessionId: 'branch', x: 0, y: 300, width: 1500 },
  { sessionId: 'newer', x: 1540, y: 24, width: 1500 },
]

describe('history horizontal navigation', () => {
  it('主线向 Branch 一侧先进入 Branch', () => {
    const relations: RelationsMap = new Map([
      ['branch', { type: 'branch', parentSessionId: 'main', side: 'right', branchIndex: 1 }],
    ])
    expect(resolveHistoryHorizontalTarget('main', 'right', layouts, relations)).toBe('branch')
  })

  it('Branch 向内回父框，向外进入相邻 Cluster', () => {
    const relations: RelationsMap = new Map([
      ['branch', { type: 'branch', parentSessionId: 'main', side: 'right', branchIndex: 1 }],
    ])
    expect(resolveHistoryHorizontalTarget('branch', 'left', layouts, relations)).toBe('main')
    expect(resolveHistoryHorizontalTarget('branch', 'right', layouts, relations)).toBe('newer')
  })

  it('多级 Branch 按完整父链找到相邻 Cluster，不会静默卡在中间层', () => {
    const nestedLayouts = [
      { sessionId: 'older', x: -3080, y: 24, width: 1500 },
      { sessionId: 'main', x: -1540, y: 24, width: 1500 },
      { sessionId: 'branch', x: 0, y: 300, width: 1500 },
      { sessionId: 'nested', x: 1540, y: 600, width: 1500 },
      { sessionId: 'newer', x: 3080, y: 24, width: 1500 },
    ]
    const relations: RelationsMap = new Map([
      ['branch', { type: 'branch', parentSessionId: 'main', side: 'right', branchIndex: 1 }],
      ['nested', { type: 'branch', parentSessionId: 'branch', side: 'right', branchIndex: 1 }],
    ])
    expect(resolveHistoryHorizontalTarget('nested', 'left', nestedLayouts, relations)).toBe('branch')
    expect(resolveHistoryHorizontalTarget('nested', 'right', nestedLayouts, relations)).toBe('newer')
    expect(resolveHistoryHorizontalTarget('branch', 'right', nestedLayouts, relations)).toBe('nested')
  })
})
