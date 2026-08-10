// 使用方法：HistoryService.scanTokenInventory 调用 scanHistoryTokenInventory
// 编译说明：Electron main / Node.js
// 代码说明：低优先级流式 Token 汇总，结果与历史画布 Session 集合完全解耦

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import type { HistoryTokenInventoryEntry } from '../../../shared/types/history'
import type { HistoryCatalogSnapshot } from './HistoryCatalog'

function finiteNumber(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

async function scanOne(
  snapshot: HistoryCatalogSnapshot,
  sessionId: string,
  signal?: AbortSignal,
): Promise<HistoryTokenInventoryEntry | null> {
  const entry = snapshot.entriesById.get(sessionId)
  if (!entry) return null
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
  let model: string | null = null
  const stream = fs.createReadStream(path.join(snapshot.claudeDir, `${sessionId}.jsonl`), { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (signal?.aborted) throw Object.assign(new Error('History request cancelled'), { code: 'HISTORY_CANCELLED' })
      if (!line.trim()) continue
      try {
        const raw = JSON.parse(line) as Record<string, unknown>
        if (raw.type !== 'assistant') continue
        const message = raw.message as Record<string, unknown> | undefined
        const rawUsage = message?.usage as Record<string, unknown> | undefined
        if (rawUsage) {
          usage.inputTokens += finiteNumber(rawUsage.input_tokens)
          usage.outputTokens += finiteNumber(rawUsage.output_tokens)
          usage.cacheCreationTokens += finiteNumber(rawUsage.cache_creation_input_tokens)
          usage.cacheReadTokens += finiteNumber(rawUsage.cache_read_input_tokens)
        }
        if (typeof message?.model === 'string') model = message.model
      } catch {
        // 部分损坏不影响剩余 Token 汇总。
      }
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  return { sessionId, projectId: entry.projectId, startedAt: entry.startedAt, model, usage }
}

export async function scanHistoryTokenInventory(
  snapshot: HistoryCatalogSnapshot,
  signal?: AbortSignal,
): Promise<HistoryTokenInventoryEntry[]> {
  const started = Date.now()
  const results: HistoryTokenInventoryEntry[] = []
  // 低并发避免统计扫描与首屏详情争抢磁盘。
  for (let index = 0; index < snapshot.entries.length; index += 4) {
    const batch = snapshot.entries.slice(index, index + 4)
    const scanned = await Promise.all(batch.map((entry) => scanOne(snapshot, entry.sessionId, signal)))
    results.push(...scanned.filter((item): item is HistoryTokenInventoryEntry => item !== null))
  }
  console.info(`[HistoryTokenInventory] project=${snapshot.projectId} sessions=${results.length} elapsedMs=${Date.now() - started}`)
  return results
}
