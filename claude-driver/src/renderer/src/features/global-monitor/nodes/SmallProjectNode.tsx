// 使用方法：在 CanvasPanel.tsx 的 nodeTypes 中注册为 'smallProject'
// 编译说明：renderer 进程 browser bundle
// 代码说明：紧凑项目卡片——用于"其他项目"分区中的空闲/待确认项目展示

import React from 'react'
import { type NodeProps, type Node } from '@xyflow/react'
import type { Project } from '@shared/types/index'
import './SmallProjectNode.css'

export type SmallProjectNodeData = {
  project: Project
  /** 待确认项目（claimStatus=0）显示橙色警告样式 */
  isPending?: boolean
  /** 双击跳转到项目监控页（可选，向后兼容） */
  onDoubleClick?: (projectId: string) => void
}

export type SmallProjectNodeType = Node<SmallProjectNodeData, 'smallProject'>

function SmallProjectNode({ data }: NodeProps<SmallProjectNodeType>): React.JSX.Element {
  const { project, isPending, onDoubleClick } = data

  const handleDoubleClick = (): void => {
    if (project.id === '__pending__') return // 聚合角标不跳转
    onDoubleClick?.(project.id)
  }

  return (
    <div
      className={`spn-wrap ${isPending ? 'spn-pending' : ''}`}
      onDoubleClick={handleDoubleClick}
    >
      <div className={`spn-dot ${isPending ? 'spn-dot-warn' : 'spn-dot-idle'}`} />
      <span className={`spn-name ${isPending ? 'spn-name-warn' : ''}`}>
        {isPending ? `${project.name}` : project.name}
      </span>
      <span className="spn-arrow">›</span>
    </div>
  )
}

export default SmallProjectNode
