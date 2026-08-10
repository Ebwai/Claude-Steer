// 使用方法：npm test -- src/__tests__/hooks/historyViewportMath.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：历史固定相机、动画插值与最大可见面积锚点单测

import { describe, expect, it } from 'vitest'
import {
  HISTORY_CAMERA_INTERPOLATE,
  HISTORY_FRAME_BOTTOM_GAP,
  canHistoryCameraOwnerPreempt,
  computeHistoryCameraTarget,
  evaluateHistoryBottomFollow,
  interpolateViewport,
  isHistoryCameraOperationCurrent,
  selectLatestAddedSessionId,
  selectLatestSessionId,
  selectViewingAnchor,
  type AnchorBottomSample,
} from '@renderer/hooks/historyViewportMath'

const bottomLayout = { sessionId: 'main', x: 100, y: 0, width: 1500 }
const bottomViewport = { x: 40, y: 0, zoom: 1 }
const bottomViewportSize = { width: 1200, height: 500 }

function bottomSample(sessionId: string, frameHeight: number): AnchorBottomSample {
  return {
    sessionId,
    frameHeight,
    layout: { ...bottomLayout, sessionId },
    viewport: bottomViewport,
    viewportSize: bottomViewportSize,
  }
}

describe('history viewport math', () => {
  it('forces linear viewport interpolation so horizontal navigation never performs a d3 zoom detour', () => {
    expect(HISTORY_CAMERA_INTERPOLATE).toBe('linear')
  })

  it('按框宽 60% 计算相机且与框高无关', () => {
    const target = computeHistoryCameraTarget(
      { sessionId: 'a', x: 100, y: 40, width: 1500 },
      { width: 1200, height: 800 },
    )
    expect(target.zoom).toBeCloseTo(0.48)
    expect(target.x).toBeCloseTo(192)
    expect(target.y).toBeCloseTo(4.8)
  })

  it('窄视口和超宽视口受缩放边界保护', () => {
    expect(computeHistoryCameraTarget(
      { sessionId: 'a', x: 0, y: 0, width: 1500 },
      { width: 100, height: 600 },
    ).zoom).toBe(0.1)
    expect(computeHistoryCameraTarget(
      { sessionId: 'a', x: 0, y: 0, width: 100 },
      { width: 1000, height: 600 },
    ).zoom).toBe(3)
  })

  it('动画插值从当前 viewport 平滑抵达目标', () => {
    const start = { x: 0, y: 0, zoom: 1 }
    const target = { x: 100, y: 50, zoom: 0.5 }
    expect(interpolateViewport(start, target, 0)).toEqual(start)
    expect(interpolateViewport(start, target, 1)).toEqual(target)
    expect(interpolateViewport(start, target, 0.5).x).toBeGreaterThan(50)
  })

  it('选择可见面积最大者，面积相同时优先靠近视口中心', () => {
    const layouts = [
      { sessionId: 'left', x: 0, y: 0, width: 100 },
      { sessionId: 'center', x: 100, y: 0, width: 100 },
      { sessionId: 'right', x: 200, y: 0, width: 100 },
    ]
    const heights = new Map(layouts.map((layout) => [layout.sessionId, 100]))
    expect(selectViewingAnchor(layouts, { x: 0, y: 0, zoom: 1 }, { width: 300, height: 100 }, heights)).toBe('center')
  })

  it('Branch 与主线使用同一锚点规则', () => {
    const layouts = [
      { sessionId: 'main', x: -180, y: 0, width: 150 },
      { sessionId: 'branch', x: 10, y: 0, width: 150 },
    ]
    const heights = new Map([['main', 100], ['branch', 100]])
    expect(selectViewingAnchor(layouts, { x: 0, y: 0, zoom: 1 }, { width: 200, height: 100 }, heights)).toBe('branch')
  })

  it('首屏按 startedAt 选择最新正式会话，Branch 可以成为锚点', () => {
    expect(selectLatestSessionId([
      { sessionId: 'main', startedAt: 1000 },
      { sessionId: 'branch', startedAt: 3000 },
      { sessionId: 'agent2', startedAt: 2000 },
    ])).toBe('branch')
  })

  it('相同 startedAt 使用 sessionId 确定性选择且不依赖输入顺序', () => {
    const candidates = [
      { sessionId: 'agent-a', startedAt: 1000 },
      { sessionId: 'agent-b', startedAt: 1000 },
    ]
    expect(selectLatestSessionId(candidates)).toBe('agent-b')
    expect(selectLatestSessionId([...candidates].reverse())).toBe('agent-b')
  })

  it('从空实时基线首次新增时也能选择新 Session', () => {
    expect(selectLatestAddedSessionId(new Set(), [
      { sessionId: 'new-session', startedAt: 2000 },
    ])).toBe('new-session')
  })

  it('只从未知实时会话中选择最新者，忽略项目切换时的既存基线', () => {
    expect(selectLatestAddedSessionId(new Set(['existing']), [
      { sessionId: 'existing', startedAt: 3000 },
      { sessionId: 'newer-added', startedAt: 5000 },
      { sessionId: 'older-added', startedAt: 4000 },
    ])).toBe('newer-added')
  })

  it('当前锚点首次出现只建立 armed 高度基线，不立即移动到底部', () => {
    const evaluation = evaluateHistoryBottomFollow(null, bottomSample('main', 300))

    expect(HISTORY_FRAME_BOTTOM_GAP).toBe(24)
    expect(evaluation).toMatchObject({
      baseline: { sessionId: 'main', height: 300, armed: true },
      target: null,
      reason: 'baseline',
    })
  })

  it('多次增长在安全线内保持静止，累计越界后只补偿 Y', () => {
    const initial = evaluateHistoryBottomFollow(null, bottomSample('main', 300))
    const firstGrowth = evaluateHistoryBottomFollow(initial.baseline, bottomSample('main', 400))
    const secondGrowth = evaluateHistoryBottomFollow(firstGrowth.baseline, bottomSample('main', 475))
    const crossing = evaluateHistoryBottomFollow(secondGrowth.baseline, bottomSample('main', 478))

    expect(firstGrowth.reason).toBe('inside-safe-line')
    expect(firstGrowth.target).toBeNull()
    expect(secondGrowth.target).toBeNull()
    expect(crossing).toMatchObject({
      reason: 'follow',
      overflowPx: 2,
      target: { x: 40, y: -2, zoom: 1 },
    })
  })

  it('初始长框保持 unarmed，后续增长不会突然跳到框底', () => {
    const initial = evaluateHistoryBottomFollow(null, bottomSample('main', 800))
    const growth = evaluateHistoryBottomFollow(initial.baseline, bottomSample('main', 900))

    expect(initial.baseline.armed).toBe(false)
    expect(growth.reason).toBe('unarmed')
    expect(growth.target).toBeNull()
  })

  it('框缩短只重建高度与 armed 状态，未来重新增长才允许跟随', () => {
    const initial = evaluateHistoryBottomFollow(null, bottomSample('main', 800))
    const shrink = evaluateHistoryBottomFollow(initial.baseline, bottomSample('main', 400))
    const growth = evaluateHistoryBottomFollow(shrink.baseline, bottomSample('main', 478))

    expect(shrink).toMatchObject({
      baseline: { height: 400, armed: true },
      target: null,
      reason: 'height-reset',
    })
    expect(growth.reason).toBe('follow')
  })

  it('1px 内的亚像素越界不移动，避免 ResizeObserver 抖动', () => {
    const initial = evaluateHistoryBottomFollow(null, bottomSample('main', 475))
    const jitter = evaluateHistoryBottomFollow(initial.baseline, bottomSample('main', 476.8))

    expect(jitter.reason).toBe('inside-safe-line')
    expect(jitter.target).toBeNull()
  })

  it('底部位于最后 24px 可见区时重新 armed，但只在未来增长后移动到安全线', () => {
    const initial = evaluateHistoryBottomFollow(null, bottomSample('main', 490))
    const growth = evaluateHistoryBottomFollow(initial.baseline, bottomSample('main', 500))

    expect(initial).toMatchObject({
      baseline: { sessionId: 'main', height: 490, armed: true },
      target: null,
      reason: 'baseline',
    })
    expect(growth).toMatchObject({
      reason: 'follow',
      overflowPx: 24,
      target: { x: 40, y: -24, zoom: 1 },
    })
  })

  it('底部刚好可见时 armed，超出视口容差后保持 unarmed', () => {
    const visible = evaluateHistoryBottomFollow(null, bottomSample('main', 500))
    const outside = evaluateHistoryBottomFollow(null, bottomSample('main', 502))
    const aboveTop = evaluateHistoryBottomFollow(null, {
      ...bottomSample('main', 100),
      viewport: { ...bottomViewport, y: -102 },
    })

    expect(visible.baseline.armed).toBe(true)
    expect(outside.baseline.armed).toBe(false)
    expect(aboveTop.baseline.armed).toBe(false)
  })

  it.each([0.25, 0.5, 1, 2])('zoom=%s 时使用同一屏幕坐标判定并补偿同一屏幕越界量', (zoom) => {
    const layout = { sessionId: 'main', x: 100, y: 80, width: 1500 }
    const frameHeight = 720
    const screenBottom = 490
    const viewport = {
      x: 40,
      y: screenBottom - (layout.y + frameHeight) * zoom,
      zoom,
    }
    const initial = evaluateHistoryBottomFollow(null, {
      sessionId: 'main',
      frameHeight,
      layout,
      viewport,
      viewportSize: bottomViewportSize,
    })
    const growth = evaluateHistoryBottomFollow(initial.baseline, {
      sessionId: 'main',
      frameHeight: frameHeight + 10 / zoom,
      layout,
      viewport,
      viewportSize: bottomViewportSize,
    })

    expect(initial.baseline.armed).toBe(true)
    expect(growth.overflowPx).toBeCloseTo(24)
    expect(growth.target).toEqual({ x: 40, y: viewport.y - 24, zoom })
  })

  it('在任意 zoom 下保持 X/zoom，只按屏幕越界量调整 Y', () => {
    const sample = {
      sessionId: 'branch',
      frameHeight: 800,
      layout: { sessionId: 'branch', x: 200, y: 100, width: 1500 },
      viewport: { x: 33, y: 0, zoom: 0.5 },
      viewportSize: bottomViewportSize,
    }
    const initial = evaluateHistoryBottomFollow(null, sample)
    const growth = evaluateHistoryBottomFollow(initial.baseline, {
      ...sample,
      frameHeight: 900,
    })

    expect(initial.baseline.armed).toBe(true)
    expect(growth.target).toEqual({ x: 33, y: -24, zoom: 0.5 })
  })

  it('主线切换到 Branch 时只为 Branch 建立新基线', () => {
    const main = evaluateHistoryBottomFollow(null, bottomSample('main', 300))
    const branch = evaluateHistoryBottomFollow(main.baseline, bottomSample('branch', 478))

    expect(branch).toMatchObject({
      baseline: { sessionId: 'branch', height: 478, armed: true },
      target: null,
      reason: 'baseline',
    })
  })

  it('父框增长只改变 Branch 布局位置而 Branch 自身高度未增长时不跟随', () => {
    const initial = evaluateHistoryBottomFollow(null, bottomSample('branch', 300))
    const displaced = evaluateHistoryBottomFollow(initial.baseline, {
      ...bottomSample('branch', 300),
      layout: { ...bottomLayout, sessionId: 'branch', y: 300 },
    })

    expect(displaced.reason).toBe('height-reset')
    expect(displaced.target).toBeNull()
  })

  it('显式左右切换可以抢占底部跟随，但底部跟随不能抢占显式或手动相机', () => {
    expect(canHistoryCameraOwnerPreempt('bottom-follow', 'explicit')).toBe(true)
    expect(canHistoryCameraOwnerPreempt('explicit', 'bottom-follow')).toBe(false)
    expect(canHistoryCameraOwnerPreempt('manual', 'explicit')).toBe(false)
    expect(canHistoryCameraOwnerPreempt('explicit', 'manual')).toBe(true)
  })

  it('被抢占操作的旧 token 或旧 owner 不能提交完成回调', () => {
    expect(isHistoryCameraOperationCurrent('bottom-follow', 3, 'bottom-follow', 3)).toBe(true)
    expect(isHistoryCameraOperationCurrent('explicit', 4, 'bottom-follow', 3)).toBe(false)
    expect(isHistoryCameraOperationCurrent('bottom-follow', 4, 'bottom-follow', 3)).toBe(false)
  })
})
