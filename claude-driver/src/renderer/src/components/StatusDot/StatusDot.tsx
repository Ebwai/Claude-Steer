// 使用方法：<StatusDot status="running" size="md" />
// 编译说明：renderer 进程 browser bundle
// 代码说明：状态指示圆点——对应 5 种 Session/Plan 状态，还原 demo .sdot / .ps 样式

import type { FC } from 'react'
import './StatusDot.css'

export type DotStatus =
  | 'running'      // 运行中（绿色脉动）
  | 'paused'       // 已暂停（橙色脉动）
  | 'done'         // 已完成（绿色静态）
  | 'todo'         // 待执行（空心边框）
  | 'idle'         // 空闲/已停止（灰色）
  | 'error'        // 错误（红色）

export type DotSize = 'sm' | 'md' | 'lg'

interface StatusDotProps {
  status: DotStatus
  size?: DotSize
  className?: string
}

const StatusDot: FC<StatusDotProps> = ({ status, size = 'md', className = '' }) => {
  return (
    <span
      className={`status-dot status-dot--${status} status-dot--${size} ${className}`}
      aria-label={status}
    />
  )
}

export default StatusDot
