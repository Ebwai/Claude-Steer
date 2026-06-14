// 使用方法：import { contextPanelAtom } from '@renderer/atoms/context-panel.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：上下文面板 atom——动态组件列表（文件/WebFetch）+ 当前显示的 Agent

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'

export type ContextComponentType =
  | 'System' | 'CLAUDE.md' | 'Memory' | 'Skills'
  | 'MCP' | 'Rules' | 'file' | 'WebFetch' | 'user-input'

export interface ContextComponent {
  id: string
  type: ContextComponentType
  label: string
  url?: string
  tokenEstimate: number
  persistent: boolean
}

/** 每个 session 的上下文组件列表（claudeId → ContextComponent[]） */
export const contextPanelAtom = atomFamily((_sessionId: string) =>
  atom<ContextComponent[]>([])
)

/** 多 Agent 时上下文面板当前显示哪个 session（null = 主 session） */
export const selectedContextAgentAtom = atom<string | null>(null)
