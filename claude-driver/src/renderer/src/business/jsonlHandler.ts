// 使用方法：import { createJsonlHandler } from '@renderer/business/jsonlHandler'
// 编译说明：renderer 进程 browser bundle
// 代码说明：BL-6 JSONL 数据接收——JSONL_RECORD / JSONL_RECORDS / JSONL_SUBAGENT_RECORD

import { IPC } from '@shared/events/ipc-channels'
import type { JsonlRecord } from '@shared/types/jsonl'
import {
  appendTimelineNode,
  appendTimelineNodes,
  appendInsertion,
  resolveTimelineKey,
} from '@renderer/capabilities/timelineStore'
import { setInsight, registerSubagentId } from '@renderer/capabilities/agentActivity'
import { jsonlRecordToNode } from '@renderer/capabilities/utils/jsonlToNode'
import { extractInsightText } from '@renderer/capabilities/utils/insightExtractor'
import { addTokensFromRecord } from '@renderer/capabilities/tokenCapability'
import type { PtyBindings } from '@renderer/atoms/pty-binding.atom'
import { ptyBindingsAtom } from '@renderer/atoms/pty-binding.atom'
import { subagentTimelineAtom, lineInsertionsBySessionAtom, type TimelineNode } from '@renderer/atoms/timeline.atom'
import type { LineInsertion } from '@shared/types/lineInsertion'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

function getBindings(store: Store): PtyBindings {
  return store.get(ptyBindingsAtom)
}

function buildInsightInsertion(sessionId: string, text: string, parsedAt: number, recordUuid?: string): LineInsertion {
  return {
    id: recordUuid ? `${sessionId}-insight-${recordUuid}` : `${sessionId}-insight-${parsedAt}`,
    type: 'insight',
    direction: 'left',
    color: '#DA7756',
    length: 'long',
    sessionId,
    timestamp: parsedAt,
    badgeContent: { toolName: '◆ Insight', displayText: text },
    status: 'done',
    isAnimating: false,
  }
}


export function createJsonlHandler(store: Store) {
  function handleRecord(rawId: string, record: JsonlRecord): void {
    const claudeId = resolveTimelineKey(rawId, getBindings(store))
    const node = jsonlRecordToNode(record)
    if (node) {
      appendTimelineNode(store, claudeId, node)
    }

    // 实时路径：assistant 行累加 token
    addTokensFromRecord(store, claudeId, record)

    if (record.type === 'assistant' && record.text) {
      const insightText = extractInsightText(record.text)
      if (insightText) {
        appendInsertion(store, claudeId, buildInsightInsertion(claudeId, insightText, record.parsedAt, record.uuid))
        // 同步更新 AgentBlock 金色卡片（record.sessionId 是 Claude Code 内部 session UUID）
        if (record.sessionId) {
          setInsight(store, record.sessionId, insightText)
        }
      }
    }
  }

  function handleBatchRecords(rawId: string, records: JsonlRecord[]): void {
    const claudeId = resolveTimelineKey(rawId, getBindings(store))
    const nodes = records.map(jsonlRecordToNode).filter((n): n is TimelineNode => n !== null)
    if (nodes.length > 0) {
      appendTimelineNodes(store, claudeId, nodes)
    }

    // 历史批量重播不在此累加 token——token 汇总由 useHistoryLoader 的 TOKEN_SCAN_FILE 负责
    // 若此处累加，每次重新打开项目都会把整个 JSONL 重放一遍，导致数值翻倍

    // 批量扫描 Insight
    const insightInsertions: LineInsertion[] = records
      .filter((r) => r.type === 'assistant' && r.text)
      .flatMap((r): LineInsertion[] => {
        const insightText = extractInsightText(r.text!)
        if (!insightText) return []
        return [buildInsightInsertion(claudeId, insightText, r.parsedAt, r.uuid)]
      })
    if (insightInsertions.length > 0) {
      insightInsertions.forEach((ins) => appendInsertion(store, claudeId, ins))
    }
  }

  function handleSubagentRecord(rawId: string, agentId: string, record: JsonlRecord): void {
    const claudeId = resolveTimelineKey(rawId, getBindings(store))
    const node = jsonlRecordToNode(record)
    if (node) {
      const key = `${claudeId}::${agentId}`
      store.set(subagentTimelineAtom(key), (prev) => {
        if (prev.some((n) => n.id === node.id)) return prev
        return [...prev, node]
      })
    }
    registerSubagentId(store, claudeId, agentId)
  }

  /** 处理 subagent 插入线批量推送（历史加载时由 JSONL_WATCH 主进程发送） */
  function handleSubagentInsertions(rawId: string, agentId: string, insertions: LineInsertion[]): void {
    const claudeId = resolveTimelineKey(rawId, getBindings(store))
    for (const ins of insertions) {
      store.set(lineInsertionsBySessionAtom(agentId), (prev) => {
        if (prev.some((p) => p.id === ins.id)) return prev
        return [...prev, ins]
      })
    }
    registerSubagentId(store, claudeId, agentId)
    console.log(`[jsonlHandler] subagent insertions: agentId=${agentId.slice(0, 8)} count=${insertions.length}`)
  }

  function register(): Array<() => void> {
    return [
      window.api.on(IPC.JSONL_RECORD, (data: unknown) => {
        const { sessionId, record } = data as { sessionId: string; record: JsonlRecord }
        handleRecord(sessionId, record)
      }),
      window.api.on(IPC.JSONL_RECORDS, (data: unknown) => {
        const { sessionId, records } = data as { sessionId: string; records: JsonlRecord[] }
        handleBatchRecords(sessionId, records)
      }),
      window.api.on(IPC.JSONL_SUBAGENT_RECORD, (data: unknown) => {
        const { sessionId, agentId, record } = data as { sessionId: string; agentId: string; record: JsonlRecord }
        handleSubagentRecord(sessionId, agentId, record)
      }),
      window.api.on(IPC.JSONL_SUBAGENT_INSERTIONS, (data: unknown) => {
        const { sessionId, agentId, insertions } = data as { sessionId: string; agentId: string; insertions: LineInsertion[] }
        handleSubagentInsertions(sessionId, agentId, insertions)
      }),
    ]
  }

  return { register, handleRecord, handleBatchRecords, handleSubagentRecord }
}
