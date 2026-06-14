// 使用方法：import { extractInsightText } from '@renderer/capabilities/utils/insightExtractor'
// 编译说明：renderer 进程 browser bundle
// 代码说明：从 assistant 文本中提取 Insight 块内容（outputStyle=Explanatory 固定格式）

/**
 * 匹配格式：
 *   `★ Insight ─...─`
 *   [内容]
 *   `─...─`
 */
export function extractInsightText(text: string): string | null {
  const startMatch = text.match(/`★\s*Insight[^`]*`/)
  if (!startMatch) return null
  const afterStart = text.slice(startMatch.index! + startMatch[0].length)
  const endMatch = afterStart.match(/\n`─+`/)
  const content = endMatch
    ? afterStart.slice(0, endMatch.index).trim()
    : afterStart.trim()
  return content || null
}
