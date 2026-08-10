// 使用方法：在 ProcessLineCanvas.tsx 中计算各 SessionFrameNode 的位置
// 编译说明：renderer 进程 browser bundle
// 代码说明：Session 框布局计算 Hook——根据 session 关系输出每个框的 {x, y}
//           X 轴：Cluster-aware 布局——父框 + 所有 branch 子框视为一个整体 Cluster
//           Y 轴：时间堆叠策略——新 session 起点 = 其启动前所有框的最大 bottom_y + FRAME_GAP_Y
//                branch 子框 Y = 父框底部（父框 Y + 父框高度），时间轴语义：branch 从父框结束处延伸

import { useMemo } from 'react'
import type { SessionRelation } from '../atoms/sessions.atom'

export type RelationsMap = Map<string, SessionRelation>

export const FRAME_WIDTH          = 1500
export const FRAME_GAP_X          = 40
export const FRAME_GAP_Y          = 24
export const FRAME_HEADER_HEIGHT  = 40
export const FRAME_FOOTER_HEIGHT  = 28   // footer border(1) + padding(5+5) + button(~17px) ≈ 28px
export const NODE_HEIGHT_ESTIMATE = 120   // fallback only，正常路径不再使用
/** branch "继承记忆" 插入线在 timeline 中占据的垂直空间（margin-top + line + margin-bottom ≈ 10px） */
export const BRANCH_INSERTION_LINE_HEIGHT = 10

// ── 基于帧底端的 branch 子框偏移量计算 ─────────────────────────────────────
// 方案：以主框底端为基准，向上偏移 FRAME_FOOTER_HEIGHT + BRANCH_HANDLE_OFFSET
//       "继承记忆"插入线在 ProcessTimeline 中紧贴帧底部，两者参考系一致
//       BRANCH_HANDLE_OFFSET 微调连接线与插入线 badge 的视觉对齐

const BRANCH_HANDLE_OFFSET = 38  // 连接线相对于帧底端 footer 上边界的向上偏移（px）

/** 根据父框当前高度计算 branch 连接线的 Y 偏移（距父框顶端） */
export function computeFrozenOffset(parentH: number): number {
  return parentH - FRAME_FOOTER_HEIGHT - BRANCH_HANDLE_OFFSET
}

export interface FrameLayout {
  sessionId: string
  x: number
  y: number
  width: number
}

interface ClusterGeometry {
  rootId: string
  memberIds: string[]
  relativeX: Map<string, number>
  left: number
  right: number
}

// ── 纯布局计算 + React Hook 包装 ───────────────────────────────────────────────

export function computeSessionFrameLayout(
  sessionIds: string[],
  heights: Map<string, number>,
  relations: RelationsMap,
  /** 各父 session 可见节点精确 Y 偏移数组（DOM 实测），保留供调用方传入；布局计算已不使用，Handle 定位由 SessionFrameNode 直接读取 */
  nodeYOffsets?: Map<string, number[]>,
  /** 各 session 的 startedAt 时间戳，用于 Y 轴时间堆叠排序 */
  startTimes?: Map<string, number>
): FrameLayout[] {
    void nodeYOffsets
    const count = sessionIds.length
    if (count === 0) return []

    // 情形1：单 Session
    if (count === 1) {
      return [{ sessionId: sessionIds[0], x: 0, y: FRAME_GAP_Y, width: FRAME_WIDTH }]
    }

    const sessionIdSet = new Set(sessionIds)
    const childrenByParent = new Map<string, string[]>()
    for (const [childId, rel] of relations) {
      if (
        rel.type !== 'branch'
        || !rel.parentSessionId
        || !sessionIdSet.has(childId)
        || !sessionIdSet.has(rel.parentSessionId)
      ) continue
      const children = childrenByParent.get(rel.parentSessionId) ?? []
      children.push(childId)
      childrenByParent.set(rel.parentSessionId, children)
    }
    for (const children of childrenByParent.values()) {
      children.sort((a, b) => {
        const ar = relations.get(a)
        const br = relations.get(b)
        return (ar?.branchIndex ?? 0) - (br?.branchIndex ?? 0)
          || (startTimes?.get(a) ?? 0) - (startTimes?.get(b) ?? 0)
          || a.localeCompare(b)
      })
    }

    const roots = sessionIds.filter((sessionId) => {
      const parentId = relations.get(sessionId)?.parentSessionId
      return !parentId || !sessionIdSet.has(parentId)
    })
    roots.sort((a, b) =>
      (startTimes?.get(a) ?? 0) - (startTimes?.get(b) ?? 0) || a.localeCompare(b),
    )

    const assigned = new Set<string>()
    const buildGeometry = (rootId: string): ClusterGeometry => {
      const relativeX = new Map<string, number>([[rootId, 0]])
      const memberIds: string[] = []
      const visiting = new Set<string>()
      const visit = (sessionId: string): void => {
        if (assigned.has(sessionId) || visiting.has(sessionId)) return
        visiting.add(sessionId)
        assigned.add(sessionId)
        memberIds.push(sessionId)
        const parentX = relativeX.get(sessionId) ?? 0
        for (const childId of childrenByParent.get(sessionId) ?? []) {
          const rel = relations.get(childId)
          if (!rel || assigned.has(childId) || visiting.has(childId)) continue
          const lineLength = rel.lineLength ?? FRAME_GAP_X
          relativeX.set(
            childId,
            (rel.side ?? 'right') === 'left'
              ? parentX - lineLength - FRAME_WIDTH
              : parentX + FRAME_WIDTH + lineLength,
          )
          visit(childId)
        }
        visiting.delete(sessionId)
      }
      visit(rootId)
      const minX = Math.min(...memberIds.map((id) => relativeX.get(id) ?? 0), 0)
      const maxRight = Math.max(...memberIds.map((id) => (relativeX.get(id) ?? 0) + FRAME_WIDTH), FRAME_WIDTH)
      return { rootId, memberIds, relativeX, left: -minX, right: maxRight - FRAME_WIDTH }
    }

    const clusters: ClusterGeometry[] = roots.map(buildGeometry)
    // 循环或关系损坏时仍让未分配节点退化为独立 Cluster，禁止静默丢框。
    for (const sessionId of sessionIds) {
      if (!assigned.has(sessionId)) clusters.push(buildGeometry(sessionId))
    }
    clusters.sort((a, b) =>
      (startTimes?.get(a.rootId) ?? 0) - (startTimes?.get(b.rootId) ?? 0)
      || a.rootId.localeCompare(b.rootId),
    )

    // ── X 轴：以最新（最右）Cluster 的父框 x=0 为稳定锚点 ───────────────────
    // 后台发现更早 Cluster 时只向左扩展，已显示 Cluster 不会因总宽度重新居中而跳动。
    const rootXMap = new Map<string, number>()
    let rightNeighborLeft: number | null = null
    for (let index = clusters.length - 1; index >= 0; index--) {
      const cluster = clusters[index]
      const rootX = rightNeighborLeft === null
        ? 0
        : rightNeighborLeft - FRAME_GAP_X - FRAME_WIDTH - cluster.right
      rootXMap.set(cluster.rootId, rootX)
      rightNeighborLeft = rootX - cluster.left
    }

    // ── Y 轴：时间堆叠策略 ────────────────────────────────────────────────────
    // 按 startedAt 升序排列所有父框（cluster 代表），依次堆叠 Y 坐标
    // 每个父框的 Y = 比它早启动的所有框的 bottom_y 的最大值 + FRAME_GAP_Y
    // branch 子框 Y = 父框 Y + 父框高度（时间轴语义：branch 从父框底部接续延伸）
    const DEFAULT_H = 400
    const frameYMap = new Map<string, number>()

    // 独立 Cluster 顶部对齐；它们在 X 轴互不重叠。这样后台插入更早历史不会级联改变
    // 已显示 Cluster 的 Y。Branch 仍从父框冻结位置延伸，保持继承记忆连线语义。
    clusters.forEach((cluster) => {
      frameYMap.set(cluster.rootId, FRAME_GAP_Y)
      const visited = new Set<string>()
      const visit = (parentId: string): void => {
        if (visited.has(parentId)) return
        visited.add(parentId)
        const parentY = frameYMap.get(parentId) ?? FRAME_GAP_Y
        const parentH = heights.get(parentId) ?? DEFAULT_H
        for (const childId of childrenByParent.get(parentId) ?? []) {
          if (!cluster.relativeX.has(childId)) continue
          const rel = relations.get(childId)
          const frozenOffset = rel?.triggerYOffset ?? computeFrozenOffset(parentH)
          frameYMap.set(childId, parentY + frozenOffset)
          visit(childId)
        }
      }
      visit(cluster.rootId)
    })

    // ── 组装结果 ───────────────────────────────────────────────────────────────
    const result: FrameLayout[] = []

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i]
      const rootX = rootXMap.get(cluster.rootId) ?? 0
      for (const sessionId of cluster.memberIds) {
        result.push({
          sessionId,
          x: rootX + (cluster.relativeX.get(sessionId) ?? 0),
          y: frameYMap.get(sessionId) ?? FRAME_GAP_Y,
          width: FRAME_WIDTH,
        })
      }
    }

    console.debug(`[Layout] frames=${result.length} clusters=${clusters.length}`)

    return result
}

export function useSessionFrameLayout(
  sessionIds: string[],
  heights: Map<string, number>,
  relations: RelationsMap,
  nodeYOffsets?: Map<string, number[]>,
  startTimes?: Map<string, number>,
): FrameLayout[] {
  return useMemo(
    () => computeSessionFrameLayout(sessionIds, heights, relations, nodeYOffsets, startTimes),
    [sessionIds, heights, relations, nodeYOffsets, startTimes],
  )
}
