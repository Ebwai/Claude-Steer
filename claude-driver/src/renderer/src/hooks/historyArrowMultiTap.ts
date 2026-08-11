// 编译说明：renderer 纯 TypeScript；无 React/DOM 依赖，可在 Vitest 中用显式时间戳测试
// 代码说明：↑/↓ 完整双连按识别状态机；只描述意图，不直接读写视口

export const ARROW_MULTI_TAP_WINDOW_MS = 200

export type VerticalArrowKey = 'ArrowUp' | 'ArrowDown'
export type HistoryFrameEdge = 'top' | 'bottom'

export type ArrowMultiTapState =
  | { phase: 'idle' }
  | { phase: 'first-pressed'; key: VerticalArrowKey; pressedAt: number }
  | { phase: 'waiting-second'; key: VerticalArrowKey; releasedAt: number }
  | { phase: 'second-pressed'; key: VerticalArrowKey; pressedAt: number }

export type ArrowMultiTapAction =
  | { type: 'single'; key: VerticalArrowKey }
  | { type: 'edge'; edge: HistoryFrameEdge }

export interface ArrowMultiTapTransition {
  state: ArrowMultiTapState
  actions: ArrowMultiTapAction[]
  reason: string
}

export type ArrowMultiTapEvent =
  | { type: 'keydown'; key: VerticalArrowKey; repeat: boolean; now: number }
  | { type: 'keyup'; key: VerticalArrowKey; now: number }
  | { type: 'interrupt'; flushPending: boolean }
  | { type: 'timeout'; now: number }

export const IDLE_ARROW_MULTI_TAP_STATE: ArrowMultiTapState = { phase: 'idle' }

function withinWindow(elapsed: number): boolean {
  return elapsed >= 0 && elapsed <= ARROW_MULTI_TAP_WINDOW_MS
}

function single(key: VerticalArrowKey): ArrowMultiTapAction {
  return { type: 'single', key }
}

function startFirstPress(
  key: VerticalArrowKey,
  now: number,
  reason: string
): ArrowMultiTapTransition {
  return {
    state: { phase: 'first-pressed', key, pressedAt: now },
    actions: [single(key)],
    reason
  }
}

/**
 * 自动重复永不计作 tap。second-pressed 的初始 keydown 被暂存，因此 repeat/超时
 * 需要先补交它，再按原有长按语义处理当前 repeat。
 */
export function transitionArrowMultiTap(
  state: ArrowMultiTapState,
  event: ArrowMultiTapEvent
): ArrowMultiTapTransition {
  if (event.type === 'interrupt') {
    const actions =
      event.flushPending && state.phase === 'second-pressed' ? [single(state.key)] : []
    return { state: IDLE_ARROW_MULTI_TAP_STATE, actions, reason: 'interrupt' }
  }

  if (event.type === 'timeout') {
    const actions = state.phase === 'second-pressed' ? [single(state.key)] : []
    return { state: IDLE_ARROW_MULTI_TAP_STATE, actions, reason: `${state.phase}-timeout` }
  }

  if (event.type === 'keydown') {
    if (event.repeat) {
      const actions =
        state.phase === 'second-pressed'
          ? [single(state.key), single(event.key)]
          : [single(event.key)]
      return { state: IDLE_ARROW_MULTI_TAP_STATE, actions, reason: 'repeat' }
    }

    if (
      state.phase === 'waiting-second' &&
      state.key === event.key &&
      withinWindow(event.now - state.releasedAt)
    ) {
      return {
        state: { phase: 'second-pressed', key: event.key, pressedAt: event.now },
        actions: [],
        reason: 'second-press-candidate'
      }
    }

    const next = startFirstPress(event.key, event.now, 'new-first-press')
    return next
  }

  if (state.phase === 'first-pressed' && state.key === event.key) {
    if (withinWindow(event.now - state.pressedAt)) {
      return {
        state: { phase: 'waiting-second', key: event.key, releasedAt: event.now },
        actions: [],
        reason: 'first-tap-complete'
      }
    }
    return { state: IDLE_ARROW_MULTI_TAP_STATE, actions: [], reason: 'first-press-too-long' }
  }

  if (state.phase === 'second-pressed' && state.key === event.key) {
    if (withinWindow(event.now - state.pressedAt)) {
      return {
        state: IDLE_ARROW_MULTI_TAP_STATE,
        actions: [{ type: 'edge', edge: event.key === 'ArrowUp' ? 'top' : 'bottom' }],
        reason: 'double-tap-confirmed'
      }
    }
    return {
      state: IDLE_ARROW_MULTI_TAP_STATE,
      actions: [single(state.key)],
      reason: 'second-press-too-long'
    }
  }

  return { state, actions: [], reason: 'unmatched-keyup' }
}

export function arrowMultiTapDeadline(state: ArrowMultiTapState): number | null {
  switch (state.phase) {
    case 'first-pressed':
    case 'second-pressed':
      return state.pressedAt + ARROW_MULTI_TAP_WINDOW_MS
    case 'waiting-second':
      return state.releasedAt + ARROW_MULTI_TAP_WINDOW_MS
    default:
      return null
  }
}
