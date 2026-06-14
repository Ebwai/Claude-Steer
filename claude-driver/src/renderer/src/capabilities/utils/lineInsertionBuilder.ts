// 使用方法：import { buildLineInsertion } from '@renderer/capabilities/utils/lineInsertionBuilder'
// 编译说明：renderer 进程 browser bundle
// 代码说明：工具调用 → LineInsertion 结构转换（方向/颜色/长度/类型由工具名决定）

import type { LineInsertion, LineInsertionType, LineInsertionLength } from '@shared/types/lineInsertion'

export function buildLineInsertion(
  toolName: string,
  toolInput: Record<string, unknown>,
  id: string,
  sessionId: string,
  timestamp: number,
  status: LineInsertion['status']
): LineInsertion | null {
  let type: LineInsertionType
  let direction: LineInsertion['direction']
  let color: string
  let length: LineInsertionLength
  let lineLabel: string | undefined

  if (toolName.startsWith('mcp__')) {
    type = 'mcp'; direction = 'right'; color = '#e6430d'; length = 'medium'
  } else if (toolName === 'Agent') {
    type = 'subagent'; direction = 'left'; color = '#DA7756'; length = 'long'
    lineLabel = '分配任务'
  } else if (toolName === 'Skill') {
    const skillName = (toolInput['name'] as string) ?? ''
    if (skillName.toLowerCase().includes('cli') || skillName.toLowerCase().includes('bash')) {
      type = 'cli'; direction = 'right'; color = '#e6430d'; length = 'long'
    } else {
      type = 'skill'; direction = 'left'; color = '#DA7756'; length = 'short'
    }
  } else {
    type = 'tool'; direction = 'right'; color = '#e6430d'; length = 'short'
  }

  return {
    id,
    type,
    direction,
    color,
    length,
    sessionId,
    timestamp,
    badgeContent: {
      toolName,
      displayText: '',
      description: (toolInput['description'] as string) ?? '',
    },
    status,
    isAnimating: status === 'running',
    lineLabel,
  }
}
