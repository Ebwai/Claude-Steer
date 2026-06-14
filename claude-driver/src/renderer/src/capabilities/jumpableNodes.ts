// 使用方法：import { buildJumpableNodes } from '@renderer/capabilities/jumpableNodes'
// 编译说明：renderer 进程 browser bundle
// 代码说明：构建键盘 ↑↓ 精细跳转列表——合并 timeline 节点 + insertion 节点，按时间序排列

import type { TimelineNode } from '../atoms/timeline.atom'
import type { LineInsertion } from '@shared/types/lineInsertion'

export interface JumpableNode {
  id: string
  type: 'user_input' | 'assistant' | 'insertion'
  timestamp: number
}

/**
 * 合并 timeline 节点（user_input + assistant）和 insertions，按时间序排列
 * 用于键盘 ↑↓ 精细游标跳转
 */
export function buildJumpableNodes(
  timelineNodes: TimelineNode[],
  insertions: LineInsertion[],
): JumpableNode[] {
  const result: JumpableNode[] = []

  for (const n of timelineNodes) {
    if (n.type !== 'user_input' && n.type !== 'assistant') continue
    result.push({ id: n.id, type: n.type, timestamp: n.parsedAt })
  }

  for (const ins of insertions) {
    result.push({ id: ins.id, type: 'insertion', timestamp: ins.timestamp })
  }

  result.sort((a, b) => a.timestamp - b.timestamp)

  return result
}
