// 使用方法：import { updateSessionTokensFromFile, addTokensFromRecord, setDriverConfig } from '@renderer/capabilities/tokenCapability'
// 编译说明：renderer 进程 browser bundle
// 代码说明：M7 Token 统计能力层——sessionTokensAtom 所有写入的唯一入口
//           三条写入路径：①历史扫描（IPC TOKEN_SCAN_FILE）②实时 JSONL 追加③driverConfig 同步

import { IPC } from '@shared/events/ipc-channels'
import type { JsonlRecord } from '@shared/types/jsonl'
import type { DriverConfig } from '@shared/types/index'
import type { HistoryTokenInventoryEntry } from '@shared/types/history'
import { sessionTokensAtom, driverConfigAtom, type SessionTokens } from '@renderer/atoms/stats.atom'
import { tokenInventoryAtom } from '@renderer/atoms/token-inventory.atom'
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

export function upsertTokenInventory(store: Store, entries: HistoryTokenInventoryEntry[]): void {
  store.set(tokenInventoryAtom, (prev) => {
    const next = new Map(prev)
    entries.forEach((entry) => next.set(entry.sessionId, entry))
    return next
  })
  console.info(`[TokenCapability] inventory upsert entries=${entries.length}`)
}

export function removeTokenInventoryEntries(store: Store, sessionIds: Iterable<string>): void {
  store.set(tokenInventoryAtom, (prev) => {
    const next = new Map(prev)
    for (const sessionId of sessionIds) next.delete(sessionId)
    return next
  })
}

// ── 路径 1：历史扫描——从 transcriptPath 读取 JSONL 汇总 token ────────────────

/**
 * 调用主进程 TOKEN_SCAN_FILE，将扫描结果写入 sessionTokensAtom(claudeId)
 * 只在结果非零时写入，避免覆盖实时路径已累积的数据
 */
export async function updateSessionTokensFromFile(
  store: Store,
  claudeId: string,
  transcriptPath: string
): Promise<void> {
  try {
    const result = await window.api.invoke(IPC.TOKEN_SCAN_FILE, { transcriptPath }) as {
      ok: boolean
      inputTokens?: number
      outputTokens?: number
      cacheCreationTokens?: number
      cacheReadTokens?: number
      model?: string | null
      error?: string
    }

    if (!result.ok) {
      console.warn(`[TokenCapability] scan failed for ${claudeId.slice(0, 8)}: ${result.error}`)
      return
    }

    const { inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, model = null } = result

    if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0) return

    // 取历史扫描和已有数据的较大值（实时路径可能已累积了部分数据）
    store.set(sessionTokensAtom(claudeId), (prev) => ({
      inputTokens:         Math.max(prev.inputTokens, inputTokens),
      outputTokens:        Math.max(prev.outputTokens, outputTokens),
      cacheCreationTokens: Math.max(prev.cacheCreationTokens, cacheCreationTokens),
      cacheReadTokens:     Math.max(prev.cacheReadTokens, cacheReadTokens),
      model:               model ?? prev.model,
    }))

    const session = store.get(activeSessionsAtom).get(claudeId)
    if (session) {
      upsertTokenInventory(store, [{
        sessionId: claudeId,
        projectId: session.projectId,
        startedAt: session.startedAt,
        model,
        usage: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens },
      }])
    }

    console.log(`[TokenCapability] Scanned ${claudeId.slice(0, 8)}: input=${inputTokens} output=${outputTokens} cacheCreate=${cacheCreationTokens} cacheRead=${cacheReadTokens} model=${model}`)
  } catch (err) {
    console.warn(`[TokenCapability] updateSessionTokensFromFile error for ${claudeId.slice(0, 8)}:`, err)
  }
}

// ── 路径 2：实时增量——从 JsonlRecord 累加 token ──────────────────────────────

/**
 * 从一条实时 JsonlRecord（assistant 行）增量累加 token 到 sessionTokensAtom
 * 由 jsonlHandler.handleRecord 调用
 */
export function addTokensFromRecord(store: Store, claudeId: string, record: JsonlRecord): void {
  if (record.type !== 'assistant' || !record.usage) return

  const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } = record.usage

  if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0) return

  const previous = store.get(sessionTokensAtom(claudeId))
  const nextTokens: SessionTokens = {
    inputTokens: previous.inputTokens + inputTokens,
    outputTokens: previous.outputTokens + outputTokens,
    cacheCreationTokens: previous.cacheCreationTokens + cacheCreationTokens,
    cacheReadTokens: previous.cacheReadTokens + cacheReadTokens,
    model: record.model ?? previous.model,
  }
  store.set(sessionTokensAtom(claudeId), nextTokens)
  const session = store.get(activeSessionsAtom).get(claudeId)
  if (session) {
    upsertTokenInventory(store, [{
      sessionId: claudeId,
      projectId: session.projectId,
      startedAt: session.startedAt,
      model: nextTokens.model,
      usage: {
        inputTokens: nextTokens.inputTokens,
        outputTokens: nextTokens.outputTokens,
        cacheCreationTokens: nextTokens.cacheCreationTokens,
        cacheReadTokens: nextTokens.cacheReadTokens,
      },
    }])
  }
}

// ── 路径 3：driverConfig 同步──────────────────────────────────────────────────

/**
 * 将 driverConfig 同步到 renderer 侧 atom（保证派生费用计算使用最新价格）
 * 由 GlobalSettingsModal 保存后和 App 启动时调用
 */
export function setDriverConfig(store: Store, config: DriverConfig): void {
  store.set(driverConfigAtom, config)
}

// ── 只读查询（方便其他模块取用，不绕过 capability）──────────────────────────

export function getSessionTokens(store: Store, claudeId: string): SessionTokens {
  return store.get(sessionTokensAtom(claudeId))
}
