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
    target: Window | HTMLElement = window,
    timestamp?: number,
  ): void {
    const event = new KeyboardEvent(type, { key, repeat, bubbles: true, cancelable: true })
    if (timestamp !== undefined) {
      Object.defineProperty(event, 'timeStamp', { configurable: true, value: timestamp })
    }
    target.dispatchEvent(event)
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

  it('uses physical event timestamps when the renderer timer runs before delayed keyup delivery', () => {
    const { store, focusSessionEdge } = createHarness()
    act(() => dispatch('ArrowUp', 'keydown', false, window, 1000))
    act(() => dispatch('ArrowUp', 'keyup', false, window, 1050))
    act(() => vi.advanceTimersByTime(250))
    act(() => dispatch('ArrowUp', 'keydown', false, window, 1100))
    act(() => dispatch('ArrowUp', 'keyup', false, window, 1150))

    expect(store.get(cursorNodeIndexAtom('agent'))).toBe(2)
    expect(focusSessionEdge).toHaveBeenCalledWith('agent', 'top', 'keyboard-double-tap')
  })

  it('keeps a physically long first press invalid even when keyup delivery is delayed', () => {
    const { store, focusSessionEdge } = createHarness()
    act(() => dispatch('ArrowDown', 'keydown', false, window, 1000))
    act(() => vi.advanceTimersByTime(250))
    act(() => dispatch('ArrowDown', 'keyup', false, window, 1250))

    expect(store.get(cursorNodeIndexAtom('agent'))).toBe(0)
    expect(focusSessionEdge).not.toHaveBeenCalled()
  })

  it('keeps a physically valid second press after the waiting timer has elapsed', () => {
    const { store, focusSessionEdge } = createHarness()
    act(() => dispatch('ArrowDown', 'keydown', false, window, 1000))
    act(() => dispatch('ArrowDown', 'keyup', false, window, 1050))
    act(() => vi.advanceTimersByTime(300))
    act(() => dispatch('ArrowDown', 'keydown', false, window, 1100))
    act(() => dispatch('ArrowDown', 'keyup', false, window, 1150))

    expect(store.get(cursorNodeIndexAtom('agent'))).toBe(0)
    expect(focusSessionEdge).toHaveBeenCalledWith('agent', 'bottom', 'keyboard-double-tap')
  })

  it('rejects a physically late second press even when its callback is delayed', () => {
    const { focusSessionEdge } = createHarness()
    act(() => dispatch('ArrowDown', 'keydown', false, window, 1000))
    act(() => dispatch('ArrowDown', 'keyup', false, window, 1050))
    act(() => vi.advanceTimersByTime(300))
    act(() => dispatch('ArrowDown', 'keydown', false, window, 1300))
    act(() => dispatch('ArrowDown', 'keyup', false, window, 1350))

    expect(focusSessionEdge).not.toHaveBeenCalled()
  })

  it('falls back to renderer time when the event timestamp is unusable', () => {
    const { focusSessionEdge } = createHarness()
    act(() => dispatch('ArrowDown', 'keydown', false, window, 0))
    act(() => vi.advanceTimersByTime(50))
    act(() => dispatch('ArrowDown', 'keyup', false, window, 0))
    act(() => vi.advanceTimersByTime(50))
    act(() => dispatch('ArrowDown', 'keydown', false, window, 0))
    act(() => dispatch('ArrowDown', 'keyup', false, window, 0))

    expect(focusSessionEdge).toHaveBeenCalledWith('agent', 'bottom', 'keyboard-double-tap')
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
