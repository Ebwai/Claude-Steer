// 使用方法：由 ProcessLineCanvas 与 GlobalHistoryDotNavigator 计算主线目录和等距点位
// 编译说明：renderer 纯 TypeScript；无 React/DOM 依赖，可在 Vitest Node 环境直接测试
// 代码说明：全局历史点导航只消费稳定 FrameLayout 与关系表，不读取时间线正文

import type { FrameLayout, RelationsMap } from '../../../hooks/useSessionFrameLayout'

export interface HistoryDotItem {
  sessionId: string
  index: number
  positionPct: number
  hitStartPct: number
  hitEndPct: number
  isFocused: boolean
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/** 按画布 X 顺序返回主线会话；所有层级 Branch 都由关系表排除。 */
export function selectOrderedMainSessionIds(
  layouts: readonly FrameLayout[],
  relations: RelationsMap
): string[] {
  return [...layouts]
    .filter((layout) => relations.get(layout.sessionId)?.type !== 'branch')
    .sort((a, b) => a.x - b.x || a.sessionId.localeCompare(b.sessionId))
    .map((layout) => layout.sessionId)
}

/**
 * 构建等距点及其唯一点击区：视觉中心首尾贴合内轨边界，命中区以相邻中心中点分割。
 * 单点使用 50%，避免 count - 1 为 0。
 */
export function buildHistoryDotItems(
  sessionIds: readonly string[],
  focusedSessionId: string | null
): HistoryDotItem[] {
  const count = sessionIds.length
  if (count === 0) return []

  const positions =
    count === 1 ? [50] : sessionIds.map((_, index) => clampPct((index / (count - 1)) * 100))

  return sessionIds.map((sessionId, index) => {
    const positionPct = positions[index]
    const hitStartPct = index === 0 ? 0 : clampPct((positions[index - 1] + positionPct) / 2)
    const hitEndPct = index === count - 1 ? 100 : clampPct((positionPct + positions[index + 1]) / 2)

    return {
      sessionId,
      index,
      positionPct,
      hitStartPct,
      hitEndPct,
      isFocused: sessionId === focusedSessionId
    }
  })
}
