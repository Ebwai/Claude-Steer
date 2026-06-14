// 使用方法：import { jsonlRecordToNode } from '@renderer/capabilities/utils/jsonlToNode'
// 编译说明：renderer 进程 browser bundle
// 代码说明：JsonlRecord → TimelineNode 结构转换

import { extractToolDisplay, type JsonlRecord } from '@shared/types/jsonl'
import type { TimelineNode } from '@renderer/atoms/timeline.atom'

export function jsonlRecordToNode(record: JsonlRecord): TimelineNode | null {
  const id = record.uuid ?? `node-${record.parsedAt}-${Math.random().toString(36).slice(2, 7)}`
  const sessionId = record.sessionId ?? ''

  switch (record.type) {
    case 'user':
      if (!record.text?.trim()) return null
      return {
        id, sessionId, type: 'user_input',
        text: record.text, parsedAt: record.parsedAt,
        isBranchStart: record.isBranchStart,
      }

    case 'assistant':
      if (!record.text?.trim()) return null
      return { id, sessionId, type: 'assistant', text: record.text, parsedAt: record.parsedAt }

    // 注意：tool_use / tool_result 类型转换为前期设计时所写，目前并没有用于主时间线实际显示中。
    // 主时间线 ProcessTimeline L538 只保留 user_input / assistant 节点，tool_use/tool_result 会被过滤。
    // tool_result 仅用于 toolResults Map 给 tool_use 卡片附加 ✓/✗ 标记（该卡片本身同样被过滤不显示）。
    case 'tool_use':
      if (!record.toolUse) return null
      {
        const display = extractToolDisplay(record.toolUse)
        return {
          id, sessionId, type: 'tool_use',
          toolName: display.toolName,
          toolDisplayText: display.displayText,
          toolUseId: record.toolUse.id,
          parsedAt: record.parsedAt,
        }
      }

    case 'tool_result':
      if (!record.toolResult) return null
      return {
        id, sessionId, type: 'tool_result',
        toolUseId: record.toolResult.tool_use_id,
        isError: record.toolResult.is_error ?? false,
        text: typeof record.toolResult.content === 'string'
          ? record.toolResult.content
          : undefined,
        parsedAt: record.parsedAt,
      }

    default:
      return null
  }
}
