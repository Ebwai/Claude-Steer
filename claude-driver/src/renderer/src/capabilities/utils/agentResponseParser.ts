// 使用方法：import { extractAgentResponse } from '@renderer/capabilities/utils/agentResponseParser'
// 编译说明：renderer 进程 browser bundle
// 代码说明：从 PostToolUse 的 tool_response 字段中提取可读文本（兼容多种格式变体）

export function extractAgentResponse(raw: unknown): string {
  if (!raw) return ''
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw)) {
    return raw
      .filter((b): b is { type: string; text: string } =>
        b != null && typeof b === 'object' && b.type === 'text'
      )
      .map((b) => b.text)
      .join(' ')
      .trim()
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (typeof obj['content'] === 'string') return obj['content'].trim()
    if (Array.isArray(obj['content'])) return extractAgentResponse(obj['content'])
    if (typeof obj['result'] === 'string') return obj['result'].trim()
  }
  return ''
}
