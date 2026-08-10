// @vitest-environment jsdom
// 使用方法：npm test -- src/__tests__/features/globalHistoryDotNavigator.test.tsx
// 编译说明：Vitest + Testing Library；纯函数与 DOM 交互一起覆盖
// 代码说明：验证主线筛选、等距点位、密集命中、Branch 排除与点击固定相机入口

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 当前 Vitest JSX 转换要求 React 在作用域内
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FrameLayout, RelationsMap } from '@renderer/hooks/useSessionFrameLayout'
import GlobalHistoryDotNavigator from '@renderer/features/project-monitor/canvas/GlobalHistoryDotNavigator'
import {
  buildHistoryDotItems,
  selectOrderedMainSessionIds
} from '@renderer/features/project-monitor/canvas/historyDotNavigation'

function frame(sessionId: string, x: number): FrameLayout {
  return { sessionId, x, y: 0, width: 1500 }
}

describe('history dot navigation math', () => {
  it('returns no points for an empty main-session list', () => {
    expect(buildHistoryDotItems([], null)).toEqual([])
  })

  it('centers a single point and gives it the entire hit range', () => {
    expect(buildHistoryDotItems(['main'], 'main')).toEqual([
      {
        sessionId: 'main',
        index: 0,
        positionPct: 50,
        hitStartPct: 0,
        hitEndPct: 100,
        isFocused: true
      }
    ])
  })

  it('places multiple points evenly from the top to the bottom', () => {
    const points = buildHistoryDotItems(['a', 'b', 'c', 'd', 'e'], 'c')
    expect(points.map((point) => point.positionPct)).toEqual([0, 25, 50, 75, 100])
    expect(points.map((point) => point.isFocused)).toEqual([false, false, true, false, false])
  })

  it('partitions dense point hit ranges without gaps or positive overlap', () => {
    const ids = Array.from({ length: 101 }, (_, index) => `main-${index}`)
    const points = buildHistoryDotItems(ids, null)

    expect(points[0].hitStartPct).toBe(0)
    expect(points.at(-1)?.hitEndPct).toBe(100)
    for (let index = 0; index < points.length - 1; index += 1) {
      expect(points[index].hitEndPct).toBeCloseTo(points[index + 1].hitStartPct, 10)
      expect(points[index].hitEndPct).toBeGreaterThan(points[index].hitStartPct)
    }
  })

  it('sorts main sessions by X/sessionId and filters every Branch level', () => {
    const layouts = [
      frame('main-z', 200),
      frame('branch-child', 80),
      frame('main-b', 0),
      frame('branch-nested', 120),
      frame('main-a', 0)
    ]
    const relations: RelationsMap = new Map([
      ['branch-child', { type: 'branch', parentSessionId: 'main-a' }],
      ['branch-nested', { type: 'branch', parentSessionId: 'branch-child' }]
    ])

    expect(selectOrderedMainSessionIds(layouts, relations)).toEqual(['main-a', 'main-b', 'main-z'])
  })

  it('keeps the main point list unchanged when a Branch is added then removed', () => {
    const mains = [frame('older', 0), frame('newer', 400)]
    const withBranch = [...mains, frame('branch', 200)]
    const relations: RelationsMap = new Map([
      ['branch', { type: 'branch', parentSessionId: 'older' }]
    ])

    expect(selectOrderedMainSessionIds(mains, new Map())).toEqual(['older', 'newer'])
    expect(selectOrderedMainSessionIds(withBranch, relations)).toEqual(['older', 'newer'])
    expect(selectOrderedMainSessionIds(mains, new Map())).toEqual(['older', 'newer'])
  })
})

describe('GlobalHistoryDotNavigator', () => {
  it('renders nothing when there are no main Agent frames', () => {
    const { container } = render(
      <GlobalHistoryDotNavigator
        orderedMainSessionIds={[]}
        focusedSessionId={null}
        onSessionFocus={vi.fn()}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('renders one accessible button per main frame and highlights only an exact main focus', () => {
    render(
      <GlobalHistoryDotNavigator
        orderedMainSessionIds={['main-1', 'main-2', 'main-3']}
        focusedSessionId="main-2"
        onSessionFocus={vi.fn()}
      />
    )

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(buttons.map((button) => button.getAttribute('data-position-pct'))).toEqual([
      '0',
      '50',
      '100'
    ])
    expect(buttons[0]).not.toHaveAttribute('aria-current')
    expect(buttons[1]).toHaveAttribute('aria-current', 'true')
    expect(buttons[2]).not.toHaveAttribute('aria-current')
  })

  it('shows no highlighted point while a Branch frame is focused', () => {
    render(
      <GlobalHistoryDotNavigator
        orderedMainSessionIds={['main-1', 'main-2']}
        focusedSessionId="branch-1"
        onSessionFocus={vi.fn()}
      />
    )

    expect(
      screen.getAllByRole('button').every((button) => !button.hasAttribute('aria-current'))
    ).toBe(true)
  })

  it('focuses the exact main session once and stops pointer propagation to the canvas', () => {
    const onSessionFocus = vi.fn()
    const onCanvasPointerDown = vi.fn()
    render(
      <div onPointerDown={onCanvasPointerDown}>
        <GlobalHistoryDotNavigator
          orderedMainSessionIds={['main-1', 'main-2']}
          focusedSessionId={null}
          onSessionFocus={onSessionFocus}
        />
      </div>
    )

    const target = screen.getAllByRole('button')[1]
    fireEvent.pointerDown(target)
    fireEvent.click(target)

    expect(onCanvasPointerDown).not.toHaveBeenCalled()
    expect(onSessionFocus).toHaveBeenCalledTimes(1)
    expect(onSessionFocus).toHaveBeenCalledWith('main-2')
  })

  it('recomputes equal positions when main frames are added or removed', () => {
    const { rerender } = render(
      <GlobalHistoryDotNavigator
        orderedMainSessionIds={['a', 'c']}
        focusedSessionId={null}
        onSessionFocus={vi.fn()}
      />
    )
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('data-position-pct'))
    ).toEqual(['0', '100'])

    rerender(
      <GlobalHistoryDotNavigator
        orderedMainSessionIds={['a', 'b', 'c']}
        focusedSessionId={null}
        onSessionFocus={vi.fn()}
      />
    )
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('data-position-pct'))
    ).toEqual(['0', '50', '100'])

    rerender(
      <GlobalHistoryDotNavigator
        orderedMainSessionIds={['b']}
        focusedSessionId={null}
        onSessionFocus={vi.fn()}
      />
    )
    expect(screen.getByRole('button')).toHaveAttribute('data-position-pct', '50')
  })
})
