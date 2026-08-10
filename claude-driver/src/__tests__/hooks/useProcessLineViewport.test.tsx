// @vitest-environment jsdom
// 使用方法：npm test -- src/__tests__/hooks/useProcessLineViewport.test.tsx
// 编译说明：Vitest + Testing Library renderHook；使用受控 ReactFlow mock
// 代码说明：验证当前锚点底部跟随与显式左右切换的相机抢占契约

import React, { type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { Provider } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusedSessionIdAtom, viewportModeAtom } from '@renderer/atoms/viewport.atom'
import { HISTORY_BOTTOM_FOLLOW_DURATION_MS, HISTORY_CAMERA_DURATION_MS } from '@renderer/hooks/historyViewportMath'
import { useProcessLineViewport } from '@renderer/hooks/useProcessLineViewport'
import type { FrameLayout } from '@renderer/hooks/useSessionFrameLayout'
import { createTestStore } from '../helpers/createTestStore'

describe('useProcessLineViewport camera arbitration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0))
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('cancels an active bottom follow before an explicit horizontal focus starts', async () => {
    const store = createTestStore()
    store.set(viewportModeAtom, 'focus')
    store.set(focusedSessionIdAtom, 'main')

    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 1200 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 500 })

    let viewport = { x: 40, y: 0, zoom: 1 }
    let resolveBottomFollow: (() => void) | null = null
    const setViewport = vi.fn((target: typeof viewport, options?: { duration?: number }) => {
      if (options?.duration === HISTORY_BOTTOM_FOLLOW_DURATION_MS) {
        return new Promise<void>((resolve) => {
          resolveBottomFollow = resolve
        })
      }
      viewport = target
      return Promise.resolve()
    })
    const flow = {
      fitView: vi.fn(),
      getViewport: vi.fn(() => viewport),
      setViewport,
    }
    const flowRef = { current: flow } as Parameters<typeof useProcessLineViewport>[0]
    const containerRef = { current: container } as Parameters<typeof useProcessLineViewport>[3]
    const layouts: FrameLayout[] = [
      { sessionId: 'main', x: 0, y: 0, width: 1500 },
      { sessionId: 'right', x: 2000, y: 0, width: 1500 },
    ]
    const realtimeAnchors = [
      { sessionId: 'main', startedAt: 1 },
      { sessionId: 'right', startedAt: 2 },
    ]
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <Provider store={store}>{children}</Provider>
    )

    const { result, rerender } = renderHook(
      ({ heights }: { heights: ReadonlyMap<string, number> }) => useProcessLineViewport(
        flowRef,
        ['main', 'right'],
        layouts,
        containerRef,
        heights,
        null,
        null,
        realtimeAnchors,
      ),
      {
        initialProps: { heights: new Map([['main', 300], ['right', 300]]) },
        wrapper,
      },
    )

    rerender({ heights: new Map([['main', 478], ['right', 300]]) })
    expect(setViewport).toHaveBeenCalledWith(
      { x: 40, y: -2, zoom: 1 },
      expect.objectContaining({ duration: HISTORY_BOTTOM_FOLLOW_DURATION_MS }),
    )

    act(() => result.current.focusSession('right'))
    expect(setViewport).toHaveBeenCalledWith(
      { x: 40, y: 0, zoom: 1 },
      { duration: 0 },
    )

    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(setViewport.mock.calls.some(([, options]) =>
      options?.duration === HISTORY_CAMERA_DURATION_MS)).toBe(true)

    await act(async () => {
      resolveBottomFollow?.()
      await Promise.resolve()
    })
    expect(setViewport.mock.calls.filter(([, options]) =>
      options?.duration === HISTORY_BOTTOM_FOLLOW_DURATION_MS)).toHaveLength(1)
  })

  it.each(['main', 'branch'] as const)('%s 手动缩放结束时框底位于可见区，未来增长恢复 Y-only 跟随', async (activeId) => {
    const store = createTestStore()
    store.set(viewportModeAtom, 'locked')
    store.set(focusedSessionIdAtom, activeId)

    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 1200 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 500 })

    const viewport = { x: 360, y: 90, zoom: 0.5 }
    const setViewport = vi.fn(() => Promise.resolve())
    const flow = {
      fitView: vi.fn(),
      getViewport: vi.fn(() => viewport),
      setViewport,
    }
    const flowRef = { current: flow } as Parameters<typeof useProcessLineViewport>[0]
    const containerRef = { current: container } as Parameters<typeof useProcessLineViewport>[3]
    const layouts: FrameLayout[] = [
      { sessionId: activeId, x: 0, y: 0, width: 1500 },
      { sessionId: 'right', x: 2000, y: 0, width: 1500 },
    ]
    const realtimeAnchors = [
      { sessionId: activeId, startedAt: 1 },
      { sessionId: 'right', startedAt: 2 },
    ]
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <Provider store={store}>{children}</Provider>
    )

    const { result, rerender } = renderHook(
      ({ heights }: { heights: ReadonlyMap<string, number> }) => useProcessLineViewport(
        flowRef,
        [activeId, 'right'],
        layouts,
        containerRef,
        heights,
        null,
        null,
        realtimeAnchors,
      ),
      {
        initialProps: { heights: new Map([[activeId, 800], ['right', 300]]) },
        wrapper,
      },
    )

    act(() => {
      result.current.onUserMoveStart(new MouseEvent('mousedown'))
      result.current.onUserMoveEnd(new MouseEvent('mouseup'))
    })
    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })

    rerender({ heights: new Map([[activeId, 820], ['right', 300]]) })

    expect(store.get(focusedSessionIdAtom)).toBe(activeId)
    expect(setViewport).toHaveBeenCalledWith(
      { x: 360, y: 66, zoom: 0.5 },
      expect.objectContaining({ duration: HISTORY_BOTTOM_FOLLOW_DURATION_MS }),
    )
  })
})
