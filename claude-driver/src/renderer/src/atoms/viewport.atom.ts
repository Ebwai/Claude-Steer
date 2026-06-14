// 使用方法：import { viewportModeAtom, focusedSessionIdAtom } from '@renderer/atoms/viewport.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：进程线画布视口状态——四态视口机器（全览/聚焦/跟随/锁定）

import { atom } from 'jotai'

/**
 * 四态视口模式
 * - overview  默认/框折叠后  → fitView(所有框)
 * - focus     用户展开某框   → fitView(该框)
 * - follow    有活跃 session → 新节点时 Y 方向跟随
 * - locked    用户手动拖拽   → 停止自动调整；Esc/双击空白恢复 follow
 */
export const viewportModeAtom = atom<'overview' | 'focus' | 'follow' | 'locked'>('overview')

/** 聚焦模式时的目标 session ID */
export const focusedSessionIdAtom = atom<string | null>(null)

/**
 * 视口聚焦请求（解耦触发方与视口 hook）
 * 写入此 atom 即可请求画布跳转到指定 session 框
 * ts 字段确保相同 sessionId 重复点击也能触发（引用变更）
 */
export const focusRequestAtom = atom<{ sessionId: string; ts: number } | null>(null)

/**
 * 节点跳转请求（全局导航条/键盘 → SessionFrameNode scrollTop）
 * 解耦触发方与执行方；nodeId 可以是 timeline 节点 id 或 insertion id
 */
export const nodeJumpRequestAtom = atom<{
  sessionId: string
  nodeId: string
  ts: number
} | null>(null)
