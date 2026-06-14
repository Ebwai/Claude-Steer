// 使用方法：import { createStatusLineHandler } from '@renderer/business/statusLineHandler'
// 编译说明：renderer 进程 browser bundle
// 代码说明：BL-7 StatusLine 处理——IPC.STATUS_LINE (~300ms 一次)
//           将 context_window 实时用量写入对应 session.tokenUsage（按 transcript_path 匹配）

import { IPC } from '@shared/events/ipc-channels'
import type { StatusLineData } from '@shared/types/index'
import { latestStatusLineAtom } from '../atoms/stats.atom'
import { patchSession } from '@renderer/capabilities/sessionRegistry'
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

export function createStatusLineHandler(store: Store) {
  function handleStatusLine(statusLine: StatusLineData): void {
    store.set(latestStatusLineAtom, statusLine)

    // 将 context_window 实时用量写入对应 session.tokenUsage
    const ctxWindow = statusLine.context_window
    if (ctxWindow) {
      const claudeId = resolveClaudeIdFromStatusLine(store, statusLine)
      if (claudeId) {
        patchSession(store, claudeId, {
          tokenUsage: {
            current:         ctxWindow.current_usage,
            max:             ctxWindow.max_tokens,
            usedPercentage:  ctxWindow.used_percentage,
          }
        })
      }
    }

    // 兜底：为缺少 transcriptPath 的 Running session 补全（stream-json 恢复模式）
    if (statusLine.transcript_path && statusLine.cwd) {
      for (const [id, session] of store.get(activeSessionsAtom)) {
        if (session.status === 'Running' && !session.transcriptPath && session.cwd === statusLine.cwd) {
          patchSession(store, id, { transcriptPath: statusLine.transcript_path! })
          break
        }
      }
    }
  }

  function register(): Array<() => void> {
    return [
      window.api.on(IPC.STATUS_LINE, (data: unknown) => {
        handleStatusLine(data as StatusLineData)
      }),
    ]
  }

  return { register, handleStatusLine }
}

/**
 * 从 statusLine 的 transcript_path 提取 claudeId（文件名 UUID 部分）
 * 精确匹配：transcript_path 路径中文件名即为 claudeId
 * fallback：按 cwd 匹配第一个 Running session
 */
function resolveClaudeIdFromStatusLine(store: Store, statusLine: StatusLineData): string | null {
  if (statusLine.transcript_path) {
    // 从路径提取 UUID（格式：~/.claude/projects/<hash>/<uuid>.jsonl）
    const match = statusLine.transcript_path.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
    )
    if (match) {
      const claudeId = match[1]
      if (store.get(activeSessionsAtom).has(claudeId)) {
        return claudeId
      }
    }
  }

  // fallback：cwd 匹配第一个 Running session
  if (statusLine.cwd) {
    for (const [id, session] of store.get(activeSessionsAtom)) {
      if (session.status === 'Running' && session.cwd === statusLine.cwd) {
        return id
      }
    }
  }

  return null
}
