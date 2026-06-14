// 使用方法：在 ProcessLineCanvas.tsx 的 edgeTypes 中注册为 'branchEdge'
// 编译说明：renderer 进程 browser bundle
// 代码说明：/branch 继承记忆连线——父框 source Handle（触发节点底部）→ 子框 target Handle
//           使用 getBezierPath 自然斜向连接，source Y 由 nodeYOffsetsAtom 精确定位，
//           颜色 #35C98A，与父 session 插入线统一；"继承记忆"文字只在插入线上展示，此处不重复

import React from 'react'
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'

export default function BranchEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps): React.JSX.Element {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{
          stroke: '#35C98A',
          strokeWidth: 2,
          strokeDasharray: '8 4',
          opacity: 0.85,
        }}
      />

      {/* 两端端点小圆 */}
      <circle cx={sourceX} cy={sourceY} r={3.5} fill="#35C98A" opacity={0.85} />
      <circle cx={targetX} cy={targetY} r={3.5} fill="#35C98A" opacity={0.85} />
    </>
  )
}
