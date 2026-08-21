// 使用方法：import { buildEntityShell } from './shellBuilder'
// 编译说明：主进程 Node.js 模块
// 代码说明：EntityShell + EntityLocator 构建——从 JsonlRecord 生成轻量摘要壳与 byte 定位

import type { JsonlRecord } from './JsonlParser'
import type { EntityShell, EntityLocator, EntityKind } from '../../../shared/types/detail'

// ── 配置 ─────────────────────────────────────────────────────────────────────

const SUMMARY_MAX_LENGTH = 200
const SUMMARY_MAX_LINES = 4

// ── 工具辅助 ─────────────────────────────────────────────────────────────────

function truncateToLines(text: string, maxLines: number, maxLength: number): string {
  const lines = text.split('\n')
  const selected = lines.slice(0, maxLines)
  let result = selected.join('\n')
  if (result.length > maxLength) {
    result = result.slice(0, maxLength)
  }
  return result
}

function firstStringArg(input: Record<string, unknown>): string | undefined {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

// ── summary 生成 ─────────────────────────────────────────────────────────────

function buildSummary(record: JsonlRecord, kind: EntityKind): string {
  switch (kind) {
    case 'user_input':
      return truncateToLines(record.text ?? '', SUMMARY_MAX_LINES, SUMMARY_MAX_LENGTH)

    case 'assistant':
      return truncateToLines(record.text ?? '', SUMMARY_MAX_LINES, SUMMARY_MAX_LENGTH)

    case 'tool_use': {
      const toolName = record.toolUse?.name ?? 'unknown'
      const paramSummary = record.toolUse?.input ? firstStringArg(record.toolUse.input) : undefined
      const raw = paramSummary ? `${toolName}: ${paramSummary}` : toolName
      return truncateToLines(raw, 1, SUMMARY_MAX_LENGTH)
    }

    case 'tool_result': {
      const toolUseId = record.toolResult?.tool_use_id ?? 'unknown'
      return `result for ${toolUseId}`
    }

    default:
      return ''
  }
}

// ── 主函数 ───────────────────────────────────────────────────────────────────

export interface BuildEntityShellParams {
  entityId: string
  record: JsonlRecord
  kind: EntityKind
  byteStart: number
  byteEndExclusive: number
  lineEnding: 'lf' | 'crlf'
  order: number
  filePath: string
  sourceGeneration: string
}

export interface BuildEntityShellResult {
  shell: EntityShell
  locator: EntityLocator
}

/**
 * 从 JsonlRecord 和 byte 定位构建 EntityShell 与 EntityLocator。
 *
 * EntityShell 只包含轻量摘要，不包含 text/toolInput/toolResult 任何完整正文字段。
 * EntityLocator 仅由 Main 持有，不通过 IPC 发送给 Renderer。
 */
export function buildEntityShell(params: BuildEntityShellParams): BuildEntityShellResult {
  const {
    entityId,
    record,
    kind,
    byteStart,
    byteEndExclusive,
    lineEnding,
    order,
    filePath,
    sourceGeneration
  } = params

  const estimatedSize = byteEndExclusive - byteStart

  const locator: EntityLocator = {
    filePath,
    byteStart,
    byteEndExclusive,
    encoding: 'utf-8',
    lineEnding
  }

  const summary = buildSummary(record, kind)

  // detailRef.revision 由 DetailService.registerEntity 分配；
  // 此处填入临时值，processLine 调用方会在 registerEntity 后替换 shell.revision 和 shell.detailRef。
  const shell: EntityShell = {
    entityId,
    kind,
    order,
    summary,
    detailRef: {
      detailKey: entityId,
      revision: Date.now(),
      sourceGeneration,
      estimatedSize
    },
    revision: Date.now(),
    estimatedSize
  }

  return { shell, locator }
}
