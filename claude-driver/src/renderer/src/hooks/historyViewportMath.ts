// 使用方法：由 useProcessLineViewport 计算历史工作框固定相机与手动浏览锚点
// 编译说明：renderer 纯 TypeScript；无 React/DOM 依赖，可在 Vitest Node 环境直接测试
// 代码说明：历史导航只按框宽构图，不读取框高；锚点按屏幕可见面积确定

export interface ViewportLike {
  x: number
  y: number
  zoom: number
}

export interface ViewportSize {
  width: number
  height: number
}

export interface FramePosition {
  sessionId: string
  x: number
  y: number
  width: number
}

export interface SessionCameraAnchor {
  sessionId: string
  startedAt: number
}

export interface AnchorBottomBaseline {
  sessionId: string
  height: number
  armed: boolean
}

export interface AnchorBottomSample {
  sessionId: string
  frameHeight: number
  layout: FramePosition
  viewport: ViewportLike
  viewportSize: ViewportSize
}

export type BottomFollowReason =
  | 'baseline'
  | 'height-reset'
  | 'unarmed'
  | 'inside-safe-line'
  | 'follow'

export interface BottomFollowEvaluation {
  baseline: AnchorBottomBaseline
  target: ViewportLike | null
  overflowPx: number
  reason: BottomFollowReason
}

export type HistoryCameraOwner = 'idle' | 'bottom-follow' | 'explicit' | 'manual'

export const HISTORY_FRAME_VIEWPORT_RATIO = 0.6
export const HISTORY_FRAME_TOP_GAP = 24
export const HISTORY_MIN_ZOOM = 0.1
export const HISTORY_MAX_ZOOM = 3
export const HISTORY_CAMERA_DURATION_MS = 260
export const HISTORY_FRAME_BOTTOM_GAP = HISTORY_FRAME_TOP_GAP
export const HISTORY_BOTTOM_FOLLOW_DURATION_MS = 160
export const HISTORY_BOTTOM_FOLLOW_EPSILON_PX = 1
/**
 * React Flow 默认的 smooth 会调用 d3.interpolateZoom：远距离平移时即使起终 zoom
 * 相同，中途也会自动拉远再拉近。历史框切换只需要稳定比例的平移，必须显式使用 linear。
 */
export const HISTORY_CAMERA_INTERPOLATE = 'linear' as const

const HISTORY_CAMERA_OWNER_PRIORITY: Record<HistoryCameraOwner, number> = {
  idle: 0,
  'bottom-follow': 1,
  explicit: 2,
  manual: 3,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function canHistoryCameraOwnerPreempt(
  currentOwner: HistoryCameraOwner,
  incomingOwner: Exclude<HistoryCameraOwner, 'idle'>,
): boolean {
  return HISTORY_CAMERA_OWNER_PRIORITY[incomingOwner] >= HISTORY_CAMERA_OWNER_PRIORITY[currentOwner]
}

export function isHistoryCameraOperationCurrent(
  currentOwner: HistoryCameraOwner,
  currentToken: number,
  expectedOwner: Exclude<HistoryCameraOwner, 'idle'>,
  expectedToken: number,
): boolean {
  return currentOwner === expectedOwner && currentToken === expectedToken
}

export function computeHistoryCameraTarget(
  layout: FramePosition,
  viewportSize: ViewportSize,
): ViewportLike {
  const width = Math.max(0, viewportSize.width)
  const frameWidth = Math.max(1, layout.width)
  const zoom = clamp(
    (width * HISTORY_FRAME_VIEWPORT_RATIO) / frameWidth,
    HISTORY_MIN_ZOOM,
    HISTORY_MAX_ZOOM,
  )
  return {
    zoom,
    x: width / 2 - (layout.x + frameWidth / 2) * zoom,
    y: HISTORY_FRAME_TOP_GAP - layout.y * zoom,
  }
}

function computeFrameBottomScreenY(sample: AnchorBottomSample, frameHeight: number): number {
  return (sample.layout.y + frameHeight) * sample.viewport.zoom + sample.viewport.y
}

function createAnchorBottomBaseline(sample: AnchorBottomSample): AnchorBottomBaseline {
  const height = Math.max(1, sample.frameHeight)
  const screenBottom = computeFrameBottomScreenY(sample, height)
  const viewportBottom = Math.max(0, sample.viewportSize.height)
  return {
    sessionId: sample.sessionId,
    height,
    armed:
      screenBottom >= -HISTORY_BOTTOM_FOLLOW_EPSILON_PX &&
      screenBottom <= viewportBottom + HISTORY_BOTTOM_FOLLOW_EPSILON_PX,
  }
}

/**
 * 当前锚点框增长跟随的唯一几何入口。新锚点只建基线；只有底部真实位于可见视口
 * 内才 armed，已在视口外的长框保持 unarmed，避免第一次轻微增长就跳到框底。
 * armed 锚点真实增长并越过底部安全线时，返回保持 x/zoom 不变的 Y-only 目标。
 */
export function evaluateHistoryBottomFollow(
  baseline: AnchorBottomBaseline | null,
  sample: AnchorBottomSample,
): BottomFollowEvaluation {
  const nextBaseline = createAnchorBottomBaseline(sample)
  if (!baseline || baseline.sessionId !== sample.sessionId) {
    return { baseline: nextBaseline, target: null, overflowPx: 0, reason: 'baseline' }
  }

  if (nextBaseline.height <= baseline.height) {
    return { baseline: nextBaseline, target: null, overflowPx: 0, reason: 'height-reset' }
  }

  const grownBaseline: AnchorBottomBaseline = {
    sessionId: sample.sessionId,
    height: nextBaseline.height,
    armed: baseline.armed,
  }
  if (!baseline.armed) {
    return { baseline: grownBaseline, target: null, overflowPx: 0, reason: 'unarmed' }
  }

  const safeBottom = Math.max(0, sample.viewportSize.height - HISTORY_FRAME_BOTTOM_GAP)
  const overflowPx = computeFrameBottomScreenY(sample, nextBaseline.height) - safeBottom
  if (overflowPx <= HISTORY_BOTTOM_FOLLOW_EPSILON_PX) {
    return { baseline: grownBaseline, target: null, overflowPx: 0, reason: 'inside-safe-line' }
  }

  return {
    baseline: grownBaseline,
    target: {
      x: sample.viewport.x,
      y: sample.viewport.y - overflowPx,
      zoom: sample.viewport.zoom,
    },
    overflowPx,
    reason: 'follow',
  }
}

export function easeOutCubic(progress: number): number {
  const t = clamp(progress, 0, 1)
  return 1 - Math.pow(1 - t, 3)
}

/** 按稳定时间和 sessionId 选择最新正式会话；输入顺序不影响结果。 */
export function selectLatestSessionId(candidates: readonly SessionCameraAnchor[]): string | null {
  let latest: SessionCameraAnchor | null = null
  for (const candidate of candidates) {
    if (
      !latest ||
      candidate.startedAt > latest.startedAt ||
      (candidate.startedAt === latest.startedAt && candidate.sessionId.localeCompare(latest.sessionId) > 0)
    ) {
      latest = candidate
    }
  }
  return latest?.sessionId ?? null
}

/** 从实时集合的增量中选择最新会话，供同一项目内新增 Agent/Branch 自动聚焦。 */
export function selectLatestAddedSessionId(
  knownSessionIds: ReadonlySet<string>,
  candidates: readonly SessionCameraAnchor[],
): string | null {
  return selectLatestSessionId(candidates.filter((candidate) => !knownSessionIds.has(candidate.sessionId)))
}

export function interpolateViewport(
  start: ViewportLike,
  target: ViewportLike,
  progress: number,
): ViewportLike {
  const eased = easeOutCubic(progress)
  return {
    x: start.x + (target.x - start.x) * eased,
    y: start.y + (target.y - start.y) * eased,
    zoom: start.zoom + (target.zoom - start.zoom) * eased,
  }
}

interface AnchorCandidate {
  sessionId: string
  area: number
  centerDistanceSq: number
  x: number
}

/**
 * 手动浏览结束时选择一次观看锚点。框高只用于求当前可见面积，不参与固定相机计算。
 */
export function selectViewingAnchor(
  layouts: FramePosition[],
  viewport: ViewportLike,
  viewportSize: ViewportSize,
  heights: ReadonlyMap<string, number>,
  fallbackHeight = 400,
): string | null {
  if (viewportSize.width <= 0 || viewportSize.height <= 0 || viewport.zoom <= 0) return null
  const viewportCenterX = viewportSize.width / 2
  const viewportCenterY = viewportSize.height / 2
  const candidates: AnchorCandidate[] = []

  for (const layout of layouts) {
    const frameHeight = Math.max(1, heights.get(layout.sessionId) ?? fallbackHeight)
    const left = layout.x * viewport.zoom + viewport.x
    const top = layout.y * viewport.zoom + viewport.y
    const right = (layout.x + layout.width) * viewport.zoom + viewport.x
    const bottom = (layout.y + frameHeight) * viewport.zoom + viewport.y
    const visibleWidth = Math.max(0, Math.min(right, viewportSize.width) - Math.max(left, 0))
    const visibleHeight = Math.max(0, Math.min(bottom, viewportSize.height) - Math.max(top, 0))
    const area = visibleWidth * visibleHeight
    if (area <= 0) continue
    const centerX = (left + right) / 2
    const centerY = (top + bottom) / 2
    candidates.push({
      sessionId: layout.sessionId,
      area,
      centerDistanceSq: Math.pow(centerX - viewportCenterX, 2) + Math.pow(centerY - viewportCenterY, 2),
      x: layout.x,
    })
  }

  candidates.sort((a, b) =>
    b.area - a.area ||
    a.centerDistanceSq - b.centerDistanceSq ||
    a.x - b.x ||
    a.sessionId.localeCompare(b.sessionId),
  )
  return candidates[0]?.sessionId ?? null
}
