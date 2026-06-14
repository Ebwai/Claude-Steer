// 使用方法：import { parseJsonlLine } from './lib/jsonl/JsonlParser'
//           import { extractToolDisplay } from '@shared/types/jsonl'（工具显示文本提取请直接从 shared 导入）
// 编译说明：主进程 Node.js 模块
// 代码说明：JSONL 单行解析器——将 ~/.claude/projects/.../session.jsonl 的每行解析为结构化对象

import type { HookEventName } from '../../../shared/types/index'
import type { JsonlMessageType, JsonlToolUse, JsonlToolResult, JsonlRecord, JsonlUsage, ToolDisplayInfo } from '../../../shared/types/jsonl'

// re-export shared 类型，保持对 JsonlWatcher 等消费者的后向兼容
export type { JsonlMessageType, JsonlToolUse, JsonlToolResult, JsonlRecord, JsonlUsage, ToolDisplayInfo }
export { extractToolDisplay } from '../../../shared/types/jsonl'

/**
 * 解析单行 JSONL（逐行调用，不处理多行 JSON）
 * 解析失败时返回 null（跳过损坏行）
 *
 * Claude Code 实际格式（v2.x）：
 *   - obj.type = "user" | "assistant"（顶层类型标识）
 *   - obj.message.content = string（用户纯文本）或 ContentBlock[]（工具调用/结果）
 *   - 其他类型（"permission-mode", "file-history-snapshot", "attachment", "system" 等）忽略
 */
export function parseJsonlLine(line: string): JsonlRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    console.warn('[JsonlParser] Failed to parse line:', trimmed.slice(0, 100))
    return null
  }

  if (typeof raw !== 'object' || raw === null) return null

  const obj = raw as Record<string, unknown>
  const msgType = obj['type'] as string | undefined

  // 只处理 user / assistant 两种消息行，其余（permission-mode, system, attachment 等）全部跳过
  if (msgType !== 'user' && msgType !== 'assistant') return null

  // 实际内容嵌套在 obj.message 中（Claude Code v2.x 格式）
  const message = obj['message'] as Record<string, unknown> | undefined
  if (!message) return null

  const content = message['content']

  let type: JsonlMessageType = msgType as JsonlMessageType
  let text: string | undefined
  let toolUse: JsonlToolUse | undefined
  let toolResult: JsonlToolResult | undefined
  let usage: JsonlUsage | undefined
  let model: string | undefined

  if (typeof content === 'string') {
    // 用户纯文本消息：content 直接是字符串
    text = content
  } else if (Array.isArray(content)) {
    // 消息内容块数组——逐块解析
    for (const block of content as Record<string, unknown>[]) {
      const blockType = block['type'] as string
      if (blockType === 'text') {
        text = (text ?? '') + ((block['text'] as string) ?? '')
      } else if (blockType === 'tool_use') {
        // assistant 调用工具
        toolUse = {
          id: block['id'] as string,
          name: block['name'] as string,
          input: (block['input'] as Record<string, unknown>) ?? {}
        }
      } else if (blockType === 'tool_result') {
        // user 返回工具结果
        toolResult = {
          tool_use_id: block['tool_use_id'] as string,
          content: block['content'] as string | unknown[],
          is_error: block['is_error'] as boolean | undefined
        }
      }
    }
  }

  // 根据内容决定最终类型（tool_use/tool_result 优先于普通文本）
  if (toolUse) type = 'tool_use'
  else if (toolResult) type = 'tool_result'

  // assistant 行：提取 token usage 和 model
  if (msgType === 'assistant') {
    const rawUsage = message['usage'] as Record<string, unknown> | undefined
    if (rawUsage) {
      usage = {
        inputTokens:          (rawUsage['input_tokens'] as number | undefined) ?? 0,
        outputTokens:         (rawUsage['output_tokens'] as number | undefined) ?? 0,
        cacheCreationTokens:  (rawUsage['cache_creation_input_tokens'] as number | undefined) ?? 0,
        cacheReadTokens:      (rawUsage['cache_read_input_tokens'] as number | undefined) ?? 0,
      }
    }
    const rawModel = message['model'] as string | undefined
    if (rawModel) model = rawModel
  }

  // 过滤空记录（既无文本又无工具调用的行）
  if (!text && !toolUse && !toolResult) return null

  // isSidechain：JSONL 顶层字段，true 表示来自 subagent
  const isSidechain = (obj['isSidechain'] as boolean | undefined) === true
  const agentId = isSidechain ? (obj['agentId'] as string | undefined) : undefined

  // 优先用 JSONL 记录自带的 timestamp（ISO 8601），回退到 Date.now()
  // 这样 parsedAt 与插入线 timestamp（hook receivedAt）在同一时间轴上，时间窗口过滤才能正确工作
  const tsRaw = obj['timestamp'] as string | number | undefined
  let parsedAt = Date.now()
  if (tsRaw) {
    const ms = typeof tsRaw === 'number' ? tsRaw : Date.parse(tsRaw)
    if (!isNaN(ms)) parsedAt = ms
  }

  return {
    uuid: obj['uuid'] as string | undefined,
    type,
    text: text?.trim() || undefined,
    toolUse,
    toolResult,
    cwd: obj['cwd'] as string | undefined,
    isSidechain: isSidechain || undefined,
    agentId,
    usage,
    model,
    raw,
    parsedAt,
  }
}

/**
 * 从 JSONL 文件路径中提取 session UUID
 * 路径格式：~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
 */
export function extractSessionIdFromPath(filePath: string): string | null {
  const match = filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return match ? match[1] : null
}

/**
 * 从 subagent JSONL 路径中提取 agentId
 * 路径格式：~/.claude/projects/<encoded>/<session-uuid>/subagents/agent-<agentId>.jsonl
 * 返回 { sessionUuid, agentId } 或 null（非 subagent 路径）
 */
export function extractSubagentInfo(filePath: string): { sessionUuid: string; agentId: string } | null {
  // 匹配 <uuid>/subagents/agent-<agentId>.jsonl
  const match = filePath.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[/\\]subagents[/\\]agent-([^/\\]+)\.jsonl$/i
  )
  if (!match) return null
  return { sessionUuid: match[1], agentId: match[2] }
}

/**
 * 将 Hook 事件名映射到 JSONL 消息类型（用于混合渲染）
 */
export function hookEventToMessageType(eventName: HookEventName): JsonlMessageType {
  switch (eventName) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'tool_use'
    default:
      return 'system'
  }
}
