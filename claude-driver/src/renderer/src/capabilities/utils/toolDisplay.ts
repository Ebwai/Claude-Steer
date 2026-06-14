// 使用方法：import { extractToolDisplayText, categorizeToolName, toolNameToWorkStatus } from '@renderer/capabilities/utils/toolDisplay'
// 编译说明：renderer 进程 browser bundle
// 代码说明：工具名相关纯函数——显示文本提取、工具分类、工作状态词

import { extractToolDisplay } from '@shared/types/jsonl'
import type { ToolCategory } from '@renderer/atoms/sessions.atom'

const BUILTIN_TOOLS = new Set([
  'Agent', 'AskUserQuestion', 'Edit', 'Glob', 'Grep',
  'Read', 'Skill', 'Task', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write',
])

export function extractToolDisplayText(
  toolName: string,
  input: Record<string, unknown>
): string {
  return extractToolDisplay({ id: '', name: toolName, input }).displayText
}

export function categorizeToolName(toolName: string): ToolCategory {
  if (toolName === 'Bash') return 'cli'
  if (!BUILTIN_TOOLS.has(toolName)) return 'mcp'
  return 'tool'
}

export function toolNameToWorkStatus(toolName: string): string {
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit': return 'Writing'
    case 'Read':
    case 'Glob':
    case 'Grep': return 'Reading'
    case 'Bash': return 'Running'
    case 'Agent': return 'Subagent: pending'
    case 'WebFetch':
    case 'WebSearch': return 'Fetching'
    default: return 'Thinking'
  }
}
