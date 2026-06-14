// 使用方法：import type { JsonlRecord, ToolDisplayInfo } from '@shared/types/jsonl'
//           import { extractToolDisplay } from '@shared/types/jsonl'
// 编译说明：纯逻辑，无 Node.js 依赖，renderer 与 main 均可引用
// 代码说明：JSONL 解析共享类型 + D13 工具调用显示文本提取规则

// ── JSONL 消息类型 ──────────────────────────────────────────────────────────

export type JsonlMessageType =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'summary'

export interface JsonlToolUse {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface JsonlToolResult {
  tool_use_id: string
  content: string | unknown[]
  is_error?: boolean
}

/** assistant 行的 token 消耗（来自 message.usage 字段） */
export interface JsonlUsage {
  /** 纯输入 token 数（不含 cache） */
  inputTokens: number
  /** 输出 token 数 */
  outputTokens: number
  /** cache 写入 token 数 */
  cacheCreationTokens: number
  /** cache 命中 token 数 */
  cacheReadTokens: number
}

/** 一条解析后的 JSONL 记录（主进程解析，通过 IPC 推送到渲染进程）*/
export interface JsonlRecord {
  uuid?: string
  type: JsonlMessageType
  text?: string
  toolUse?: JsonlToolUse
  toolResult?: JsonlToolResult
  cwd?: string
  sessionId?: string
  /** true 表示该记录来自 subagent（JSONL 中的 isSidechain 字段） */
  isSidechain?: boolean
  /** subagent 唯一 ID（仅 isSidechain=true 时存在，对应文件名 agent-<agentId>.jsonl） */
  agentId?: string
  /** true 表示该记录是 /branch 后的第一条消息（紧跟 file-history-snapshot 行），由 JsonlWatcher 逐行追踪标注 */
  isBranchStart?: boolean
  /** assistant 行的 token 消耗（仅 type=assistant 且有 message.usage 时存在） */
  usage?: JsonlUsage
  /** 使用的模型名称（仅 type=assistant 时存在，来自 message.model） */
  model?: string
  raw?: unknown
  parsedAt: number
}

/** 工具调用精简显示文本（PRD D13 规则）*/
export interface ToolDisplayInfo {
  toolName: string
  displayText: string
}

/**
 * D13：从工具调用中提取精简显示文本
 * 同时在 main/lib/jsonl/JsonlParser.ts 和这里存在（两者保持同步）
 */
export function extractToolDisplay(toolUse: JsonlToolUse): ToolDisplayInfo {
  const { name, input } = toolUse
  let displayText = ''

  switch (name) {
    case 'Bash':
      displayText = (input['description'] as string) || (input['command'] as string) || name
      break
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'Glob':
      displayText = (input['file_path'] as string) || (input['path'] as string) || name
      break
    case 'WebFetch':
      displayText = (input['url'] as string) || name
      break
    case 'Agent':
      displayText = (input['description'] as string) || name
      break
    case 'Grep':
      {
        const pattern = input['pattern'] as string
        const grepPath = input['path'] as string
        displayText = grepPath ? `${pattern} in ${grepPath}` : (pattern || name)
      }
      break
    default:
      displayText = (input['description'] as string) || name
  }

  return { toolName: name, displayText }
}
