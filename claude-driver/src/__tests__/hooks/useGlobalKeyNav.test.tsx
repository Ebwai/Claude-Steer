import React, { type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { Provider } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusedSessionIdAtom } from '@renderer/atoms/viewport.atom'
import { cursorNodeIndexAtom, timelineBySessionAtom } from '@renderer/atoms/timeline.atom'
import { useGlobalKeyNav } from '@renderer/hooks/useGlobalKeyNav'
import type { FrameLayout } from '@renderer/hooks/useSessionFrameLayout'
import { createTestStore } from '../helpers/createTestStore'

describe('useGlobalKeyNav double tap integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  function createHarness(scopeKey = 'project-a'): {
    store: ReturnType<typeof createTestStore>
    focusSessionEdge: ReturnType<typeof vi.fn>
    rerender: (props: { scope: string }) => void
    unmount: () => void
  } {
    const store = createTestStore()
    store.set(focusedSessionIdAtom, 'agent')
    store.set(timelineBySessionAtom('agent'), [
      { id: 'n1', type: 'user_input', content: 'one', timestamp: 1 },
      { id: 'n2', type: 'user_input', content: 'two', timestamp: 2 },
      { id: 'n3', type: 'user_input', content: 'three', timestamp: 3 }
    ])
    const rf = {
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
      setViewport: vi.fn()
    }
    const focusSession = vi.fn()
    const focusSessionEdge = vi.fn()
    const container = document.createElement('div')
    const layouts: FrameLayout[] = [{ sessionId: 'agent', x: 0, y: 0, width: 1500 }]
    const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
      <Provider store={store}>{children}</Provider>
    )
    const hook = renderHook(
      ({ scope }: { scope: string }) =>
        useGlobalKeyNav(
          rf as never,
          layouts,
          focusSession,
          focusSessionEdge,
          { current: container },
          scope
        ),
      { initialProps: { scope: scopeKey }, wrapper }
    )
    return { rerender: hook.rerender, unmount: hook.unmount, store, focusSessionEdge }
  }

  function dispatch(
    key: string,
    type: 'keydown' | 'keyup',
    repeat = false,
    target: Window | HTMLElement = window
  ): void {
    target.dispatchEvent(new KeyboardEvent(type, { key, repeat, bubbles: true, cancelable: true }))
  }

  it('keeps the first jump immediate and replaces only the second jump with a bottom edge intent', () => {
    const { store, focusSessionEdge } = createHarness()
    act(() => dispatch('ArrowDown', 'keydown'))
    expect(store.get(cursorNodeIndexAtom('agent'))).toBe(0)
    act(() => dispatch('ArrowDown', 'keyup'))
    act(() => vi.advanceTimersByTime(50))
    act(() => dispatch('ArrowDown', 'keydown'))
    expect(store.get(cursorNodeIndexAtom('agent'))).toBe(0)
    act(() => dispatch('ArrowDown', 'keyup'))

    expect(store.get(cursorNodeIndexAtom('agent'))).toBe(0)
    expect(focusSessionEdge).toHaveBeenCalledWith('agent', 'bottom', 'keyboard-double-tap')
  })

  it('treats a second press after 200ms as a normal immediate jump', () => {
    const { store, focusSessionEdge } = createHarness()
    act(() => dispatch('ArrowDown', 'keydown'))
    act(() => dispatch('ArrowDown', 'keyup'))
    act(() => vi.advanceTimersByTime(201))
    act(() => dispatch('ArrowDown', 'keydown'))

    expect(store.get(cursorNodeIndexAtom('agent'))).toBe(1)
    expect(focusSessionEdge).not.toHaveBeenCalled()
  })

  it('does not establish or consume a candidate from editable controls', () => {
    const { store, focusSessionEdge } = createHarness()
    const input = document.createElement('input')
    document.body.appendChild(input)
    act(() => {
      dispatch('ArrowDown', 'keydown', false, input)
      dispatch('ArrowDown', 'keyup', false, input)
    })
    expect(store.get(cursorNodeIndexAtom('agent'))).toBe(-1)
    expect(focusSessionEdge).not.toHaveBeenCalled()
  })

  it('clears a candidate on project scope change', () => {
    const { rerender, store, focusSessionEdge } = createHarness()
    act(() => dispatch('ArrowUp', 'keydown'))
    act(() => dispatch('ArrowUp', 'keyup'))
    rerender({ scope: 'project-b' })
    act(() => dispatch('ArrowUp', 'keydown'))
    act(() => dispatch('ArrowUp', 'keyup'))

    expect(store.get(cursorNodeIndexAtom('agent'))).toBe(1)
    expect(focusSessionEdge).not.toHaveBeenCalled()
  })

  it('clears a candidate on window blur', () => {
    const { store, focusSessionEdge } = createHarness()
    act(() => dispatch('ArrowDown', 'keydown'))
    act(() => dispatch('ArrowDown', 'keyup'))
    act(() => window.dispatchEvent(new Event('blur')))
    act(() => dispatch('ArrowDown', 'keydown'))
    act(() => dispatch('ArrowDown', 'keyup'))

    expect(store.get(cursorNodeIndexAtom('agent'))).toBe(1)
    expect(focusSessionEdge).not.toHaveBeenCalled()
  })

  it('clears pending timers on unmount', () => {
    const { unmount } = createHarness()
    act(() => dispatch('ArrowDown', 'keydown'))
    act(() => vi.advanceTimersByTime(0))
    act(() => dispatch('ArrowDown', 'keyup'))
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
// @vitest-environment jsdom
