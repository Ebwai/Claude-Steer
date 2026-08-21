// 使用方法：import { resolveEntityId } from './entityId'
// 编译说明：主进程 Node.js 模块
// 代码说明：确定性 EntityId 生成——按优先级链选择 ID 来源，无随机 fallback

import * as crypto from 'crypto'
import type { JsonlRecord } from './JsonlParser'
import type { EntityIdSource, EntityKind } from '../../../shared/types/detail'

// ── kind 映射 ────────────────────────────────────────────────────────────────

/**
 * 从 JsonlRecord 推导 EntityKind。
 *
 * 映射规则（与 detail.ts EntityKind 对齐）：
 *  - type=user → user_input
 *  - type=assistant + 有 toolUse → tool_use（assistant 内嵌工具调用）
 *  - type=assistant + 纯 text → assistant
 *  - type=tool_use → tool_use
 *  - type=tool_result → tool_result
 */
export function deriveEntityKind(record: JsonlRecord): EntityKind {
  if (record.type === 'user') return 'user_input'
  if (record.type === 'tool_result') return 'tool_result'
  if (record.type === 'tool_use') return 'tool_use'
  if (record.type === 'assistant') {
    return record.toolUse ? 'tool_use' : 'assistant'
  }
  // system / summary 等极少走到此路径，统一归为 system
  return 'system'
}

// ── 确定性 hash ──────────────────────────────────────────────────────────────

function deterministicHash(
  sessionId: string,
  byteStart: number,
  byteEndExclusive: number,
  kind: string,
  ordinal: number
): string {
  const payload = `${sessionId}|${byteStart}|${byteEndExclusive}|${kind}|${ordinal}`
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
}

// ── 主函数 ───────────────────────────────────────────────────────────────────

/**
 * 按优先级链解析 EntityId。
 *
 * 优先级（对应 EntityIdSource 判别联合）：
 *   1. record.uuid 非空 → 'uuid'
 *   2. record.type=tool_use && toolUse.id 存在 → 'tool_use_id'
 *   3. record.type=tool_result && toolResult.tool_use_id 存在 → 'tool_use_id'
 *   4. 确定性 fallback: sha256(sessionId + byteRange + kind + ordinal) → 'deterministic'
 *
 * 不引入 requestId / insertion_id 路径（实时 watcher 无此信息），统一走 deterministic fallback。
 * 无 Math.random 调用。
 */
export function resolveEntityId(
  record: JsonlRecord,
  sessionId: string,
  byteStart: number,
  byteEndExclusive: number,
  ordinal: number
): { entityId: string; source: EntityIdSource } {
  const kind = deriveEntityKind(record)

  // 优先级 1：JSONL uuid
  if (record.uuid) {
    return {
      entityId: record.uuid,
      source: { source: 'uuid', value: record.uuid }
    }
  }

  // 优先级 2：tool_use id
  if (record.type === 'tool_use' && record.toolUse?.id) {
    return {
      entityId: record.toolUse.id,
      source: { source: 'tool_use_id', value: record.toolUse.id }
    }
  }

  // 优先级 3：tool_result.tool_use_id
  if (record.type === 'tool_result' && record.toolResult?.tool_use_id) {
    return {
      entityId: record.toolResult.tool_use_id,
      source: { source: 'tool_use_id', value: record.toolResult.tool_use_id }
    }
  }

  // 优先级 4：确定性 fallback
  const entityId = deterministicHash(sessionId, byteStart, byteEndExclusive, kind, ordinal)
  return {
    entityId,
    source: { source: 'deterministic', sessionId, byteStart, byteEndExclusive, kind, ordinal }
  }
}
