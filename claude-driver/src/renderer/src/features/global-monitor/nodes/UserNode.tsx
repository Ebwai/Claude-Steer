// 使用方法：在 CanvasPanel.tsx 的 nodeTypes 中注册为 'userNode'
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局画板用户节点——橙色头像 + "我" + 用户名 + 展开箭头（左上角固定位置）

import React from 'react'
import { type NodeProps, type Node } from '@xyflow/react'
import { useT } from '../../../i18n'
import './UserNode.css'

export type UserNodeData = {
  username?: string
}

export type UserNodeType = Node<UserNodeData, 'userNode'>

function UserNode({ data }: NodeProps<UserNodeType>): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="un-wrap">
      <div className="un-avatar">{t('canvasPanel.username')}</div>
      <span className="un-name">{data.username ?? t('canvasPanel.username')}</span>
      <span className="un-arrow">▾</span>
    </div>
  )
}

export default UserNode
