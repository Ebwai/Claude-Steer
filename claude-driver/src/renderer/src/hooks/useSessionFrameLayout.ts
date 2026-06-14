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

// ── Cluster 内部结构 ──────────────────────────────────────────────────────────

interface BranchChild {
  id: string
  rel: SessionRelation
}

interface Cluster {
  parentId: string
  leftChildren: BranchChild[]
  rightChildren: BranchChild[]
}

/** 计算单侧 branch 子框组的最大占用宽度 */
function sideWidth(children: BranchChild[]): number {
  if (children.length === 0) return 0
  return Math.max(...children.map((c) => (c.rel.lineLength ?? FRAME_GAP_X) + FRAME_WIDTH))
}

// ── 主 Hook ────────────────────────────────────────────────────────────────────

export function useSessionFrameLayout(
  sessionIds: string[],
  heights: Map<string, number>,
  relations: RelationsMap,
  /** 各父 session 可见节点精确 Y 偏移数组（DOM 实测），保留供调用方传入；布局计算已不使用，Handle 定位由 SessionFrameNode 直接读取 */
  nodeYOffsets?: Map<string, number[]>,
  /** 各 session 的 startedAt 时间戳，用于 Y 轴时间堆叠排序 */
  startTimes?: Map<string, number>
): FrameLayout[] {
  return useMemo(() => {
    const count = sessionIds.length
    if (count === 0) return []

    // 情形1：单 Session
    if (count === 1) {
      return [{ sessionId: sessionIds[0], x: 0, y: FRAME_GAP_Y, width: FRAME_WIDTH }]
    }

    // 找出所有 branch 子框
    const branchChildSet = new Set<string>()
    for (const [sid, rel] of relations) {
      if (rel?.type === 'branch') branchChildSet.add(sid)
    }

    // 构建 Cluster（每个非 branch 子框为一个 cluster 的父框）
    const clusters: Cluster[] = []
    for (const sessionId of sessionIds) {
      if (branchChildSet.has(sessionId)) continue

      const leftChildren: BranchChild[] = []
      const rightChildren: BranchChild[] = []

      for (const [childId, rel] of relations) {
        if (rel.type !== 'branch' || rel.parentSessionId !== sessionId) continue
        if ((rel.side ?? 'right') === 'left') leftChildren.push({ id: childId, rel })
        else rightChildren.push({ id: childId, rel })
      }

      clusters.push({ parentId: sessionId, leftChildren, rightChildren })
    }

    // 孤儿 branch（父框不在 sessionIds 中）退化为独立 cluster
    for (const [childId, rel] of relations) {
      if (rel.type !== 'branch') continue
      if (!rel.parentSessionId || sessionIds.includes(rel.parentSessionId)) continue
      if (!sessionIds.includes(childId)) continue
      clusters.push({ parentId: childId, leftChildren: [], rightChildren: [] })
    }

    // ── X 轴：Cluster-aware 水平居中排列 ──────────────────────────────────────
    const clusterDims = clusters.map((c) => {
      const left  = sideWidth(c.leftChildren)
      const right = sideWidth(c.rightChildren)
      return { left, right, total: left + FRAME_WIDTH + right }
    })

    const totalWidth = clusterDims.reduce((s, d) => s + d.total, 0)
      + FRAME_GAP_X * (clusters.length - 1)
    let cursorX = -(totalWidth / 2)

    // ── Y 轴：时间堆叠策略 ────────────────────────────────────────────────────
    // 按 startedAt 升序排列所有父框（cluster 代表），依次堆叠 Y 坐标
    // 每个父框的 Y = 比它早启动的所有框的 bottom_y 的最大值 + FRAME_GAP_Y
    // branch 子框 Y = 父框 Y + 父框高度（时间轴语义：branch 从父框底部接续延伸）
    const DEFAULT_H = 400
    const parentYMap = new Map<string, number>()

    if (startTimes && startTimes.size > 0) {
      // 按 startedAt 升序排列 cluster 父框
      const sortedClusters = [...clusters].sort((a, b) => {
        const ta = startTimes.get(a.parentId) ?? 0
        const tb = startTimes.get(b.parentId) ?? 0
        return ta - tb
      })

      // 记录每个已排列框的 bottom_y（含 branch 子框），用于后续框的起点计算
      const bottomYMap = new Map<string, number>()

      for (const cluster of sortedClusters) {
        // 父框 Y = 比当前 startedAt 更早的所有框的 bottom_y 最大值 + FRAME_GAP_Y
        const parentStart = startTimes.get(cluster.parentId) ?? 0
        let maxPrevBottom = FRAME_GAP_Y

        for (const [sid, bottom] of bottomYMap) {
          const sStart = startTimes.get(sid) ?? 0
          if (sStart < parentStart) {
            maxPrevBottom = Math.max(maxPrevBottom, bottom + FRAME_GAP_Y)
          }
        }

        const parentY = maxPrevBottom
        parentYMap.set(cluster.parentId, parentY)
        const parentH = heights.get(cluster.parentId) ?? DEFAULT_H
        bottomYMap.set(cluster.parentId, parentY + parentH)

        // branch 子框顶端 = 父框Y + frozenOffset（帧底端基准：parentH - FRAME_FOOTER_HEIGHT）
        // 优先用持久化的 triggerYOffset（兼容旧数据），否则基于帧底端计算
        // 连接线与 "继承记忆" 插入线同参考系（帧底部），对齐一致
        const allChildren = [...cluster.leftChildren, ...cluster.rightChildren]
        for (const { id: childId, rel } of allChildren) {
          const frozenOffset = rel.triggerYOffset ?? computeFrozenOffset(parentH)
          const childY = parentY + frozenOffset
          const childH = heights.get(childId) ?? DEFAULT_H
          console.log(`[Layout][DIAG] child=${childId.slice(0,8)} parentY=${Math.round(parentY)} triggerYOffset=${rel.triggerYOffset} frozenOffset=${Math.round(frozenOffset)} source=${rel.triggerYOffset !== undefined ? 'SNAPSHOT' : 'BOTTOM_BASED'} childY=${Math.round(childY)} parentH=${Math.round(parentH)}`)
          bottomYMap.set(childId, childY + childH)
          parentYMap.set(childId, childY)
        }
      }
    } else {
      // fallback：所有父框顶部对齐，branch 子框顶端 = 父框Y + triggerYOffset（或帧底端偏移）
      clusters.forEach((c) => {
        parentYMap.set(c.parentId, FRAME_GAP_Y)
        const parentH = heights.get(c.parentId) ?? DEFAULT_H
        const allChildren = [...c.leftChildren, ...c.rightChildren]
        allChildren.forEach(({ id: childId, rel }) => {
          const frozenOffset = rel.triggerYOffset ?? computeFrozenOffset(parentH)
          parentYMap.set(childId, FRAME_GAP_Y + frozenOffset)
        })
      })
    }

    // ── 组装结果 ───────────────────────────────────────────────────────────────
    const result: FrameLayout[] = []

    for (let i = 0; i < clusters.length; i++) {
      const cluster  = clusters[i]
      const { left } = clusterDims[i]
      const parentX  = cursorX + left
      const parentY  = parentYMap.get(cluster.parentId) ?? FRAME_GAP_Y

      result.push({ sessionId: cluster.parentId, x: parentX, y: parentY, width: FRAME_WIDTH })

      // 左侧 branch 子框
      for (const { id: childId, rel } of cluster.leftChildren) {
        const lineLen = rel.lineLength ?? FRAME_GAP_X
        const childY  = parentYMap.get(childId) ?? parentY
        result.push({
          sessionId: childId,
          x: parentX - lineLen - FRAME_WIDTH,
          y: childY,
          width: FRAME_WIDTH,
        })
      }

      // 右侧 branch 子框
      for (const { id: childId, rel } of cluster.rightChildren) {
        const lineLen = rel.lineLength ?? FRAME_GAP_X
        const childY  = parentYMap.get(childId) ?? parentY
        result.push({
          sessionId: childId,
          x: parentX + FRAME_WIDTH + lineLen,
          y: childY,
          width: FRAME_WIDTH,
        })
      }

      cursorX += clusterDims[i].total + FRAME_GAP_X
    }

    console.log(`[Layout] result:`, result.map((l) =>
      `${l.sessionId.slice(0,8)} x=${l.x} y=${Math.round(l.y)}`
    ).join(' | '))

    return result
  }, [sessionIds, heights, relations, nodeYOffsets, startTimes])
}
