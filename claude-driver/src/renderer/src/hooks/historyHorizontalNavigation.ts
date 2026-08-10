// 使用方法：由 useGlobalKeyNav 计算历史主线/Branch 的左右目标
// 编译说明：renderer 纯 TypeScript；无 React/DOM 依赖，可独立测试
// 代码说明：按完整父链识别 Cluster，避免多级/孤立 Branch 导航静默返回空目标

import type { FrameLayout, RelationsMap } from './useSessionFrameLayout'

export type HorizontalDirection = 'left' | 'right'

function resolveClusterRoot(sessionId: string, relations: RelationsMap): string {
  let current = sessionId
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const parentId = relations.get(current)?.parentSessionId
    if (!parentId) return current
    current = parentId
  }
  return current
}

function adjacentClusterRoot(
  currentId: string,
  direction: HorizontalDirection,
  layouts: FrameLayout[],
  relations: RelationsMap,
): string | null {
  const layoutById = new Map(layouts.map((layout) => [layout.sessionId, layout]))
  const roots = layouts
    .filter((layout) => resolveClusterRoot(layout.sessionId, relations) === layout.sessionId)
    .sort((a, b) => a.x - b.x || a.sessionId.localeCompare(b.sessionId))
  const rootId = resolveClusterRoot(currentId, relations)
  const rootIndex = roots.findIndex((layout) => layout.sessionId === rootId)
  if (rootIndex >= 0) {
    return roots[direction === 'right' ? rootIndex + 1 : rootIndex - 1]?.sessionId ?? null
  }

  // 父链不完整时仍按当前框真实 X 找最近 Cluster，避免静默卡死。
  const currentX = layoutById.get(currentId)?.x
  if (currentX === undefined) return null
  const candidates = roots.filter((layout) => direction === 'right' ? layout.x > currentX : layout.x < currentX)
  candidates.sort((a, b) =>
    Math.abs(a.x - currentX) - Math.abs(b.x - currentX) || a.sessionId.localeCompare(b.sessionId),
  )
  return candidates[0]?.sessionId ?? null
}

export function resolveHistoryHorizontalTarget(
  currentId: string,
  direction: HorizontalDirection,
  layouts: FrameLayout[],
  relations: RelationsMap,
): string | null {
  const layoutById = new Map(layouts.map((layout) => [layout.sessionId, layout]))
  const currentLayout = layoutById.get(currentId)
  if (!currentLayout) return null

  const directChildren = Array.from(relations.entries())
    .filter(([childId, relation]) => {
      if (relation.type !== 'branch' || relation.parentSessionId !== currentId) return false
      const childLayout = layoutById.get(childId)
      return !!childLayout && (direction === 'right' ? childLayout.x > currentLayout.x : childLayout.x < currentLayout.x)
    })
    .sort(([aId, a], [bId, b]) => {
      const aDistance = Math.abs((layoutById.get(aId)?.x ?? currentLayout.x) - currentLayout.x)
      const bDistance = Math.abs((layoutById.get(bId)?.x ?? currentLayout.x) - currentLayout.x)
      return aDistance - bDistance || (a.branchIndex ?? 0) - (b.branchIndex ?? 0) || aId.localeCompare(bId)
    })

  const ownRelation = relations.get(currentId)
  if (ownRelation?.type === 'branch' && ownRelation.parentSessionId) {
    const parentLayout = layoutById.get(ownRelation.parentSessionId)
    const parentDirection = parentLayout && parentLayout.x < currentLayout.x ? 'left' : 'right'
    if (direction === parentDirection && parentLayout) return parentLayout.sessionId
    // 多级 Branch 向外时先进入自己的直接后代；无后代才跨到相邻主线 Cluster。
    if (directChildren[0]) return directChildren[0][0]
    return adjacentClusterRoot(currentId, direction, layouts, relations)
  }

  if (directChildren[0]) return directChildren[0][0]
  return adjacentClusterRoot(currentId, direction, layouts, relations)
}
