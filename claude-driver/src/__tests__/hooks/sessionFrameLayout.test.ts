import { describe, expect, it } from 'vitest'
import {
  FRAME_GAP_X,
  FRAME_WIDTH,
  computeSessionFrameLayout,
  type RelationsMap,
} from '@renderer/hooks/useSessionFrameLayout'

describe('session frame recursive layout', () => {
  it('递归展开多级 Branch，任何目录中的框都不会被静默遗漏', () => {
    const ids = ['older', 'main', 'branch', 'nested', 'newer']
    const relations: RelationsMap = new Map([
      ['branch', {
        type: 'branch', parentSessionId: 'main', side: 'right', branchIndex: 1,
        lineLength: FRAME_GAP_X,
      }],
      ['nested', {
        type: 'branch', parentSessionId: 'branch', side: 'right', branchIndex: 1,
        lineLength: FRAME_GAP_X,
      }],
    ])
    const starts = new Map(ids.map((id, index) => [id, index]))

    const layouts = computeSessionFrameLayout(ids, new Map(), relations, undefined, starts)
    const byId = new Map(layouts.map((layout) => [layout.sessionId, layout]))

    expect(layouts.map((layout) => layout.sessionId).sort()).toEqual([...ids].sort())
    expect(byId.get('branch')!.x - byId.get('main')!.x).toBe(FRAME_WIDTH + FRAME_GAP_X)
    expect(byId.get('nested')!.x - byId.get('branch')!.x).toBe(FRAME_WIDTH + FRAME_GAP_X)
    expect(byId.get('newer')!.x).toBeGreaterThan(byId.get('nested')!.x)
  })

  it('删去一个同级 Branch 后，剩余 Branch 按它从未出现过的间距重排', () => {
    const relations: RelationsMap = new Map([
      ['sibling', {
        type: 'branch', parentSessionId: 'main', side: 'right', branchIndex: 1,
        lineLength: FRAME_GAP_X,
      }],
    ])

    const layouts = computeSessionFrameLayout(['main', 'sibling'], new Map(), relations)
    const byId = new Map(layouts.map((layout) => [layout.sessionId, layout]))

    expect(byId.get('sibling')!.x - byId.get('main')!.x).toBe(FRAME_WIDTH + FRAME_GAP_X)
  })
})
