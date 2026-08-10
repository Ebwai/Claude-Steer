// 使用方法：在 ProcessLineCanvas.tsx 中注册为 nodeTypes={{ sessionFrame: SessionFrameNode }}
// 编译说明：renderer 进程 browser bundle
// 代码说明：@xyflow 自定义 Node——Session 进程线外壳框
//           包含：虚线边框 + 框头部(状态点/名称/token/运行时长) + ProcessTimeline 内容 + 底部操作按钮组
//           通过 ResizeObserver 监听自身高度变化并更新 sessionFrameHeightsAtom

import React, { useEffect, useRef, useCallback } from 'react'
import { Handle, Position, useReactFlow, useUpdateNodeInternals } from '@xyflow/react'
import { useAtomValue, useSetAtom } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import type { Session } from '@shared/types/index'
import type { HistoryDetailsState } from '@shared/types/history'
import { activeSessionsAtom, sessionFrameHeightsAtom, sessionRelationsAtom } from '../../../atoms/sessions.atom'
import { sessionTokensAtom } from '../../../atoms/stats.atom'
import { tokenInventoryAtom } from '../../../atoms/token-inventory.atom'
import { projectByIdAtom, milestonesByProjectAtom } from '../../../atoms/projects.atom'
import { FRAME_HEADER_HEIGHT, computeFrozenOffset } from '../../../hooks/useSessionFrameLayout'
import type { HistoryLayoutMeasurementGate } from '../../../hooks/historyLayoutMeasurementGate'
import { allFrameHeightsAtom } from '../../../atoms/agent-block.atom'
import {
  buildSessionResumePayload,
  resolveSessionFrameProjectId,
} from '../../../capabilities/sessionResumeCapability'
import { useT } from '../../../i18n'
import ProcessTimeline from '../ProcessTimeline'
import './SessionFrameNode.css'

// ── 节点 data 类型 ─────────────────────────────────────────────────────────

export interface SessionFrameData extends Record<string, unknown> {
  projectId: string   // 当前监管画布所属项目；恢复历史会话时作为权威 projectId
  sessionId: string   // claudeId（Map key，稳定渲染标识 = node.id）
  ptyId?: string      // 当前 PTY UUID（每次 resume 会变；历史 shell 无 PTY）
  session: Session
  source: 'realtime' | 'history'
  detailsState: HistoryDetailsState
  clusterId: string
  deleteDisabled: boolean
  isDeleting: boolean
  /** 稳定 ref gate：相机移动/settling 期间冻结高度提交，但不改变 node.data 引用。 */
  layoutMeasurementGate: HistoryLayoutMeasurementGate
  onRequestDelete?: (sessionId: string) => void
  agentLabel: string
  agentColor: string   // CSS 颜色值，如 '#35C98A'
  isExpanded: boolean
  estimatedHeight: number
}

// ── 运行时长格式化 ─────────────────────────────────────────────────────────

function formatDuration(startedAt: number, endedAt: number | null): string {
  const elapsed = Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000))
  if (elapsed < 60) return `${elapsed}s`
  const m = Math.floor(elapsed / 60)
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}min`
}

// ── token 格式化 ──────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1000) return `↑ ${(n / 1000).toFixed(1)}K`
  return `↑ ${n}`
}

// ── SessionFrameNode ──────────────────────────────────────────────────────

interface SessionFrameNodeProps {
  id: string
  data: SessionFrameData
  selected: boolean
}

function SessionFrameNode({ id, data, selected }: SessionFrameNodeProps): React.JSX.Element {
  const { t } = useT()
  const { sessionId, ptyId, agentLabel, agentColor, source, detailsState } = data
  const activeSessions = useAtomValue(activeSessionsAtom)
  const session = activeSessions.get(sessionId) ?? data.session
  const setHeight = useSetAtom(sessionFrameHeightsAtom(sessionId))
  const setAllHeights = useSetAtom(allFrameHeightsAtom)
  const { updateNodeData } = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()
  const relationsMap = useAtomValue(sessionRelationsAtom)
  const sessionProjectId = resolveSessionFrameProjectId(data.projectId, session?.projectId)
  const project = useAtomValue(projectByIdAtom(sessionProjectId))
  // childBranches：sessionRelationsAtom.parentSessionId 现在存 claudeId（= sessionId）
  const childBranches = Array.from(relationsMap.entries())
    .filter(([, rel]) => rel.type === 'branch' && rel.parentSessionId === sessionId)

  const containerRef = useRef<HTMLDivElement>(null)
  const lastMeasuredHeightRef = useRef<number | null>(null)
  const pendingMeasuredHeightRef = useRef<number | null>(null)
  const startedAt = session?.startedAt ?? 0
  const sessionTokens = useAtomValue(sessionTokensAtom(sessionId))
  const tokenInventory = useAtomValue(tokenInventoryAtom).get(sessionId)
  const displayedTokens = source === 'history' && tokenInventory ? tokenInventory.usage : sessionTokens
  const totalConsumedTokens = displayedTokens.inputTokens + displayedTokens.outputTokens +
    displayedTokens.cacheCreationTokens + displayedTokens.cacheReadTokens

  // ── Milestone badges ───────────────────────────────────────────────────────
  const allMilestones = useAtomValue(milestonesByProjectAtom(sessionProjectId))
  const sessionMilestones = allMilestones.filter((m) => m.sessionId === sessionId)

  // ── ResizeObserver：监听框高度变化，通知 ReactFlow 重新测量节点尺寸 ────────
  // updateNodeData  → 更新 node.data.estimatedHeight（供布局 hook 使用）
  // updateNodeInternals(id) → 通知 @xyflow 重新读取 DOM 尺寸，锚点随高度移动
  // 同时计算可见节点精确 Y 偏移（相对于 .sfn-frame 顶部），存入 nodeYOffsetsAtom
  // 供 BranchEdge Handle top 精确定位，替代 NODE_HEIGHT_ESTIMATE 估算
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const gate = data.layoutMeasurementGate
    const commitMeasuredHeight = (h: number): void => {
      if (lastMeasuredHeightRef.current !== null && Math.abs(lastMeasuredHeightRef.current - h) < 0.5) return
      lastMeasuredHeightRef.current = h
      setHeight(h)
      // 同步写入全量 Map atom，使 ProcessLineCanvas 订阅到变化触发布局重算。
      setAllHeights((prev) => {
        const next = new Map(prev)
        next.set(sessionId, h)
        return next
      })
      updateNodeData(id, { estimatedHeight: h })
      updateNodeInternals(id)
    }
    const flushPendingHeight = (): void => {
      const pendingHeight = pendingMeasuredHeightRef.current
      if (pendingHeight === null) return
      pendingMeasuredHeightRef.current = null
      commitMeasuredHeight(pendingHeight)
    }
    gate.unblockedListeners.add(flushPendingHeight)
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height
        if (gate.blocked) {
          pendingMeasuredHeightRef.current = h
          continue
        }
        commitMeasuredHeight(h)
      }
    })
    ro.observe(el)
    return () => {
      gate.unblockedListeners.delete(flushPendingHeight)
      ro.disconnect()
    }
  }, [data.layoutMeasurementGate, id, sessionId, setHeight, setAllHeights, updateNodeData, updateNodeInternals])

  // ── 状态点颜色 ─────────────────────────────────────────────────────────
  const statusColor = session?.status === 'Running'
    ? '#35C98A'
    : session?.status === 'Paused'
    ? '#DA7756'
    : '#888'

  const isRunning = session?.status === 'Running'
  const isCompleted = !session || session.status === 'Completed' || session.status === 'Interrupted'

  // ── 操作按钮 ───────────────────────────────────────────────────────────
  const handleInterrupt = useCallback(() => {
    if (!ptyId) return
    void window.api.invoke(IPC.SESSION_STOP, { sessionId: ptyId })
      .catch((err: unknown) => console.error('[SessionFrameNode] SESSION_STOP failed:', err))
  }, [ptyId])

  const handleResume = useCallback(async () => {
    console.log(`[SessionFrameNode] handleResume: ptyId=${ptyId} projectId=${sessionProjectId || 'null'} project=${project?.id ?? 'null'} sessionId=${sessionId}`)
    // 历史框按设计没有 ptyId；SESSION_RESUME 会创建新的 PTY，只需要稳定的 Claude sessionId。
    const resumePayload = buildSessionResumePayload(sessionId, project)
    if (!resumePayload) {
      console.warn(`[SessionFrameNode] handleResume blocked: project not found for session=${sessionId} projectId=${sessionProjectId || 'null'}`)
      return
    }
    console.log(`[SFN:WIN] handleResume BEFORE: outerW=${window.outerWidth} outerH=${window.outerHeight} innerW=${window.innerWidth} innerH=${window.innerHeight}`)
    // sessionId = claudeId，直接作为 resumeSessionId 传入（claude -r <claudeId>）
    try {
      const result = await window.api.invoke(IPC.SESSION_RESUME, resumePayload) as { ok: boolean; sessionId?: string }
      console.log(`[SFN:WIN] handleResume AFTER: outerW=${window.outerWidth} outerH=${window.outerHeight} innerW=${window.innerWidth} innerH=${window.innerHeight}`)

      if (result.ok && result.sessionId) {
        const newPtyId = result.sessionId
        // 新开 xterm.js 终端窗口（新 PTY 已在主进程运行）
        void window.api.invoke(IPC.TERM_WINDOW_OPEN, {
          sessionId: newPtyId,
          title: t('projectMonitor.canvas.terminalTitle', { label: agentLabel }),
        }).catch((err: unknown) => console.error('[SessionFrameNode] TERM_WINDOW_OPEN failed:', err))
        // PTY_BIND {newPtyId, claudeId} 到达后，byClaude 分支自动更新 entry.id = newPtyId
        // activeSessionsAtom/ptySessionIdsAtom 无需手动操作，node.id = claudeId 不变
      }
    } catch (err) {
      console.error('[SessionFrameNode] SESSION_RESUME failed:', err)
    }
  }, [ptyId, sessionId, sessionProjectId, project, agentLabel, t])

  const handleOpenTerminal = useCallback(() => {
    console.log(`[SessionFrameNode] handleOpenTerminal: ptyId=${ptyId} isCompleted=${isCompleted}`)
    if (!ptyId) return
    void window.api.invoke(IPC.TERM_WINDOW_OPEN, {
      sessionId: ptyId,
      title: t('projectMonitor.canvas.terminalTitle', { label: agentLabel }),
    }).catch((err: unknown) => console.error('[SessionFrameNode] TERM_WINDOW_OPEN failed:', err))
  }, [ptyId, isCompleted, agentLabel, t])

  return (
    <div
      ref={containerRef}
      className={`sfn-frame ${selected ? 'sfn-frame-selected' : ''}`}
      style={{
        borderColor: `${agentColor}60`,
        minHeight: source === 'history' && detailsState !== 'resident'
          ? data.estimatedHeight
          : undefined,
      }}
    >
      {/* 基础 handle（@xyflow 内部要求至少有一个） */}
      <Handle type="target" position={Position.Top} id="default-target" style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} id="default-source" style={{ opacity: 0 }} />

      {/* 动态 source handles：父框一侧，top = frozenOffset（帧底端基准：parentH - FRAME_FOOTER_HEIGHT）
          优先级：triggerYOffset（旧数据兼容）→ computeFrozenOffset（帧底端）→ 绝对 fallback */}
      {childBranches.map(([childId, rel]) => {
        const handlePos = (rel.side ?? 'right') === 'left' ? Position.Left : Position.Right
        const parentH = data.estimatedHeight
        const srcTop = rel.triggerYOffset
          ?? (parentH !== undefined ? computeFrozenOffset(parentH) : undefined)
          ?? FRAME_HEADER_HEIGHT + 300  // 绝对 fallback：header + 300px 内容偏移
        return (
          <Handle
            key={`src-${childId}`}
            id={`src-${childId}`}
            type="source"
            position={handlePos}
            style={{ opacity: 0, top: srcTop, left: handlePos === Position.Left ? 0 : undefined, right: handlePos === Position.Right ? 0 : undefined }}
          />
        )
      })}

      {/* 动态 target handle：子框一侧，top = FRAME_HEADER_HEIGHT / 2（框头部中央，与插入线对齐） */}
      {(() => {
        const ownRel = relationsMap.get(sessionId)
        if (!ownRel || ownRel.type !== 'branch') return null
        const handlePos = (ownRel.side ?? 'right') === 'right' ? Position.Left : Position.Right
        return (
          <Handle
            key="branch-target"
            id="branch-target"
            type="target"
            position={handlePos}
            style={{ opacity: 0, top: FRAME_HEADER_HEIGHT / 2 }}
          />
        )
      })()}

      {/* ── 框头部 ── */}
      <div className="sfn-header" style={{ borderBottomColor: `${agentColor}40` }}>
        {/* 左侧：状态点 + Agent 名称 */}
        <div className="sfn-header-left">
          <span
            className={`sfn-status-dot ${isRunning ? 'sfn-dot-running' : ''}`}
            style={{ backgroundColor: statusColor, boxShadow: isRunning ? `0 0 6px ${statusColor}` : 'none' }}
          />
          <span className="sfn-agent-label" style={{ color: agentColor }}>{agentLabel}</span>
        </div>

        {/* 右侧：context window 用量（运行中）/ 总消耗（已完成）+ 运行时长 */}
        <div className="sfn-header-right">
          {isRunning && (session?.tokenUsage?.current ?? 0) > 0 && (
            <span className="sfn-tokens" title={t('projectMonitor.canvas.contextWindowUsage')}>
              {formatTokens(session!.tokenUsage.current!)}
            </span>
          )}
          {isCompleted && totalConsumedTokens > 0 && (
            <span className="sfn-tokens" title={t('projectMonitor.canvas.sessionTokenTotal')}>
              {formatTokens(totalConsumedTokens)}
            </span>
          )}
          <span className="sfn-duration">{formatDuration(startedAt, session?.endedAt ?? null)}</span>
          {source === 'history' && (
            <button
              type="button"
              className="sfn-delete-btn"
              disabled={data.deleteDisabled || data.isDeleting}
              title={data.deleteDisabled
                ? t('projectMonitor.canvas.historyDeleteRunning')
                : t('projectMonitor.canvas.historyDeleteAria')}
              aria-label={t('projectMonitor.canvas.historyDeleteAria')}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                data.onRequestDelete?.(sessionId)
              }}
            >
              {data.isDeleting ? '…' : '×'}
            </button>
          )}
        </div>
      </div>

      {/* ── 进程线内容区 ── */}
      <div className="sfn-timeline-area" style={{ position: 'relative' }}>
        {/* 里程碑 badges：绝对定位在内容末尾，frameHeight 是触发瞬间帧的精确 DOM 高度 */}
        {sessionMilestones.map((m, idx) => {
          // 触发时帧高度 - 头部(40) - 底部操作区(~36) = 内容区实际底部
          // 多个 badge 时向上堆叠（每个 badge 高约 18px）
          const BADGE_HEIGHT = 18
          const FOOTER_HEIGHT = 36
          const topPx = m.frameHeight - FRAME_HEADER_HEIGHT - FOOTER_HEIGHT - (sessionMilestones.length - idx) * BADGE_HEIGHT
          return (
            <div
              key={m.id}
              className="sfn-milestone-badge"
              style={{ top: Math.max(topPx, FRAME_HEADER_HEIGHT + 4) }}
              title={m.description}
            >
              [{m.id}]
            </div>
          )
        })}
        {source === 'history' && detailsState !== 'resident' ? (
          <div className={`sfn-history-shell sfn-history-shell-${detailsState}`}>
            {detailsState === 'hydrating'
              ? t('projectMonitor.canvas.historyLoading')
              : detailsState === 'error'
                ? t('projectMonitor.canvas.historyLoadFailed')
                : t('projectMonitor.canvas.historyShell')}
          </div>
        ) : (
          <ProcessTimeline
            sessionId={sessionId}
            embedded={true}
            sessionOverride={session}
            source={source}
          />
        )}
      </div>

      {/* ── 底部操作区 ── */}
      <div className="sfn-footer">
        {/* 中间位置：token 消耗统计 */}
        {totalConsumedTokens > 0 && (
          <span className="sfn-footer-tokens" title={`input: ${displayedTokens.inputTokens} output: ${displayedTokens.outputTokens} cache_create: ${displayedTokens.cacheCreationTokens} cache_read: ${displayedTokens.cacheReadTokens}`}>
            {formatTokens(totalConsumedTokens)} tok
          </span>
        )}
        <button
          className="sfn-btn sfn-btn-interrupt"
          onClick={handleInterrupt}
          disabled={isCompleted}
          title={t('projectMonitor.canvas.interruptTooltip')}
        >
          ⬛ {t('projectMonitor.canvas.interruptConversation')}
        </button>
        <button
          className="sfn-btn sfn-btn-resume"
          onClick={() => { void handleResume() }}
          title={t('projectMonitor.canvas.resumeTooltip')}
        >
          {t('projectMonitor.canvas.backToConversation')}
        </button>
        <button
          className="sfn-btn sfn-btn-terminal"
          onClick={handleOpenTerminal}
          disabled={isCompleted}
          title={isCompleted ? t('projectMonitor.canvas.sessionEndedTooltip') : t('projectMonitor.canvas.openTerminalTooltip')}
        >
          ⬛ {t('projectMonitor.canvas.openTerminal')}
        </button>
        <button
          className="sfn-btn sfn-btn-merge"
          title={t('projectMonitor.canvas.mergeToMainTooltip')}
          onClick={() => {
            // M4 S4 T4 Git 合并实现时接入
            console.info('[SessionFrameNode] merge to main: not yet implemented')
          }}
        >
          {t('projectMonitor.canvas.mergeToMain')}
        </button>
      </div>
    </div>
  )
}

export default SessionFrameNode
