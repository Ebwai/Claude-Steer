import { describe, expect, it } from 'vitest'
import {
  IDLE_ARROW_MULTI_TAP_STATE,
  transitionArrowMultiTap,
  type ArrowMultiTapState,
  type ArrowMultiTapTransition
} from '@renderer/hooks/historyArrowMultiTap'
import { computeHistoryBottomCameraTarget } from '@renderer/hooks/historyViewportMath'

function keyDown(
  state: ArrowMultiTapState,
  now: number,
  key: 'ArrowUp' | 'ArrowDown' = 'ArrowDown',
  repeat = false
): ArrowMultiTapTransition {
  return transitionArrowMultiTap(state, { type: 'keydown', key, repeat, now })
}

function keyUp(
  state: ArrowMultiTapState,
  now: number,
  key: 'ArrowUp' | 'ArrowDown' = 'ArrowDown'
): ArrowMultiTapTransition {
  return transitionArrowMultiTap(state, { type: 'keyup', key, now })
}

describe('history arrow multi-tap', () => {
  it.each([199, 200])(
    'confirms two complete same-direction taps at the inclusive %sms boundary',
    (window) => {
      const firstDown = keyDown(IDLE_ARROW_MULTI_TAP_STATE, 0)
      expect(firstDown.actions).toEqual([{ type: 'single', key: 'ArrowDown' }])
      const firstUp = keyUp(firstDown.state, window)
      const secondDown = keyDown(firstUp.state, window * 2)
      expect(secondDown.actions).toEqual([])
      const secondUp = keyUp(secondDown.state, window * 3)
      expect(secondUp.actions).toEqual([{ type: 'edge', edge: 'bottom' }])
      expect(secondUp.state.phase).toBe('idle')
    }
  )

  it('does not arm a tap whose press lasts 201ms', () => {
    const firstDown = keyDown(IDLE_ARROW_MULTI_TAP_STATE, 0)
    const firstUp = keyUp(firstDown.state, 201)
    expect(firstUp.state.phase).toBe('idle')
    expect(firstUp.actions).toEqual([])
  })

  it('treats the next press as an immediate normal press after a 201ms gap', () => {
    const firstDown = keyDown(IDLE_ARROW_MULTI_TAP_STATE, 0)
    const firstUp = keyUp(firstDown.state, 50)
    const lateSecondDown = keyDown(firstUp.state, 251)
    expect(lateSecondDown.state.phase).toBe('first-pressed')
    expect(lateSecondDown.actions).toEqual([{ type: 'single', key: 'ArrowDown' }])
  })

  it('flushes the withheld second normal press once when its release times out', () => {
    const firstDown = keyDown(IDLE_ARROW_MULTI_TAP_STATE, 0)
    const firstUp = keyUp(firstDown.state, 20)
    const secondDown = keyDown(firstUp.state, 40)
    const timedOut = transitionArrowMultiTap(secondDown.state, { type: 'timeout', now: 241 })
    expect(timedOut.actions).toEqual([{ type: 'single', key: 'ArrowDown' }])
    expect(timedOut.state.phase).toBe('idle')
  })

  it('never counts repeat as a tap and preserves both withheld and repeated navigation', () => {
    const firstDown = keyDown(IDLE_ARROW_MULTI_TAP_STATE, 0)
    const firstUp = keyUp(firstDown.state, 20)
    const secondDown = keyDown(firstUp.state, 40)
    const repeated = keyDown(secondDown.state, 100, 'ArrowDown', true)
    expect(repeated.actions).toEqual([
      { type: 'single', key: 'ArrowDown' },
      { type: 'single', key: 'ArrowDown' }
    ])
    expect(repeated.state.phase).toBe('idle')
  })

  it('cancels a withheld press and starts the opposite direction as a new first tap', () => {
    const firstDown = keyDown(IDLE_ARROW_MULTI_TAP_STATE, 0)
    const firstUp = keyUp(firstDown.state, 20)
    const secondDown = keyDown(firstUp.state, 40)
    const opposite = keyDown(secondDown.state, 50, 'ArrowUp')
    expect(opposite.actions).toEqual([{ type: 'single', key: 'ArrowUp' }])
    expect(opposite.state).toMatchObject({ phase: 'first-pressed', key: 'ArrowUp' })
  })

  it('discards a candidate on blur/scope cleanup without delayed actions', () => {
    const waiting = keyUp(keyDown(IDLE_ARROW_MULTI_TAP_STATE, 0).state, 20)
    const reset = transitionArrowMultiTap(waiting.state, { type: 'interrupt', flushPending: false })
    expect(reset.actions).toEqual([])
    expect(reset.state.phase).toBe('idle')
  })

  it('maps a completed ArrowUp pair to the top edge', () => {
    const firstDown = keyDown(IDLE_ARROW_MULTI_TAP_STATE, 0, 'ArrowUp')
    const firstUp = keyUp(firstDown.state, 20, 'ArrowUp')
    const secondDown = keyDown(firstUp.state, 40, 'ArrowUp')
    expect(keyUp(secondDown.state, 60, 'ArrowUp').actions).toEqual([{ type: 'edge', edge: 'top' }])
  })
})

describe('shared history bottom camera geometry', () => {
  it('reuses the 90% width and 75% viewport-height bottom composition', () => {
    const target = computeHistoryBottomCameraTarget(
      { sessionId: 'agent', x: 100, y: 40, width: 1500 },
      1000,
      { width: 1200, height: 800 }
    )
    expect(target.zoom).toBeCloseTo(0.72)
    expect(target.x).toBeCloseTo(-12)
    expect(target.y).toBeCloseTo(-148.8)
  })
})
