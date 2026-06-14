// 使用方法：import { agentBlocksAtom, agentCallCountAtom } from '@renderer/atoms/agent-block.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：Agent Block 实时状态 atom——工具调用、Subagent、Insight 等

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'

export type ToolEntryStatus = 'running' | 'done' | 'failed'
export type ToolCategory = 'tool' | 'mcp' | 'cli'
export type ExperienceCategory = 'skill' | 'workflow'

export interface ToolEntry {
  id: string
  toolName: string
  displayText: string
  category: ToolCategory
  status: ToolEntryStatus
  startedAt: number
}

export interface ExperienceEntry {
  id: string
  name: string
  category: ExperienceCategory
  status: ToolEntryStatus
  startedAt: number
}

export interface SubagentInfo {
  subagentId: string
  description: string
  startedAt: number
}

export interface AgentBlockState {
  sessionId: string
  sessionCwd: string
  workStatusText: string
  activeTools: ToolEntry[]
  activeExperiences: ExperienceEntry[]
  activeSubagent: SubagentInfo | null
  activeInsight: string | null
}

/** 所有活跃 session 的 Agent Block 状态 Map（claudeId → AgentBlockState） */
export const agentBlocksAtom = atom<Map<string, AgentBlockState>>(new Map())

/** SessionFrameNode 估算高度（px），由 ResizeObserver 更新（保留供其他消费者使用）*/
export const sessionFrameHeightsAtom = atomFamily((_sessionId: string) =>
  atom<number>(400)
)

/**
 * 所有 SessionFrameNode 的实际 DOM 高度 Map（claudeId → px）
 * 使用单一 Map atom 而非 atomFamily，使 ProcessLineCanvas 可以一次性订阅全量变化，
 * 任意框高度改变都会触发布局重算（Y 轴时间堆叠策略的数据源）
 * 由 SessionFrameNode ResizeObserver 写入
 */
export const allFrameHeightsAtom = atom<Map<string, number>>(new Map())

/** 每个 session 的 subagent ID 列表（按启动顺序） */
export const subagentIdsAtom = atomFamily((_sessionId: string) =>
  atom<string[]>([])
)

/** 每个 session 已调用 Agent 工具的次数（从 1 开始，用于 Agent{n} badge） */
export const agentCallCountAtom = atomFamily((_sessionId: string) =>
  atom<number>(0)
)

/** 活跃 subagent 槽位（toolUseId → slotNumber），用于多 subagent 并发宽度计算 */
export const activeSubagentSlotsAtom = atomFamily((_sessionId: string) =>
  atom<Map<string, number>>(new Map())
)

/**
 * /btw 等待回答的 insertion ID（claudeId → insertionId）
 * 发送 /btw 时写入，SubagentStop 到来时消费，用于把 last_assistant_message 回填到 badge
 */
export const pendingBtwAtom = atom<Map<string, string>>(new Map())

/**
 * 每个 session 的可见节点精确 Y 偏移数组（相对于 .sfn-frame 顶部，px）
 * 由 SessionFrameNode 的 ResizeObserver 在 DOM 稳定后写入
 * 用于精确定位 BranchEdge source Handle 和子框 Y 位置（替代 NODE_HEIGHT_ESTIMATE 估算）
 * 数组下标 = 可见节点序号（user_input + assistant，不含 tool_use/tool_result）
 */
export const nodeYOffsetsAtom = atomFamily((_sessionId: string) =>
  atom<number[]>([])
)
