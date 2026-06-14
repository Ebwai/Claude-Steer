// 使用方法：在 ProcessLineCanvas.tsx 中注册为 nodeTypes={{ sessionFrame: SessionFrameNode }}
// 编译说明：renderer 进程 browser bundle
// 代码说明：@xyflow 自定义 Node——Session 进程线外壳框
//           包含：虚线边框 + 框头部(状态点/名称/token/运行时长) + ProcessTimeline 内容 + 底部操作按钮组
//           通过 ResizeObserver 监听自身高度变化并更新 sessionFrameHeightsAtom

import React, { useEffect, useRef, useCallback } from 'react'
import { Handle, Position, useReactFlow, useUpdateNodeInternals } from '@xyflow/react'
import { useAtomValue, useSetAtom } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import { activeSessionsAtom, sessionFrameHeightsAtom, sessionRelationsAtom } from '../../../atoms/sessions.atom'
import { sessionTokensAtom } from '../../../atoms/stats.atom'
import { projectByIdAtom, milestonesByProjectAtom } from '../../../atoms/projects.atom'
import { FRAME_HEADER_HEIGHT, computeFrozenOffset } from '../../../hooks/useSessionFrameLayout'
import { allFrameHeightsAtom } from '../../../atoms/agent-block.atom'
import { useT } from '../../../i18n'
import ProcessTimeline from '../ProcessTimeline'
import './SessionFrameNode.css'

// ── 节点 data 类型 ─────────────────────────────────────────────────────────

export interface SessionFrameData extends Record<string, unknown> {
  sessionId: string   // claudeId（Map key，稳定渲染标识 = node.id）
  ptyId: string       // 当前 PTY UUID（每次 resume 会变；SESSION_STOP/INPUT/TERM_WINDOW_OPEN 使用此值）
  agentLabel: string
  agentColor: string   // CSS 颜色值，如 '#35C98A'
  isExpanded: boolean
  estimatedHeight: number
}

// ── 运行时长格式化 ─────────────────────────────────────────────────────────

function formatDuration(startedAt: number): string {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000)
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
  const { sessionId, ptyId, agentLabel, agentColor } = data
  const activeSessions = useAtomValue(activeSessionsAtom)
  const session = activeSessions.get(sessionId)
  const setHeight = useSetAtom(sessionFrameHeightsAtom(sessionId))
  const setAllHeights = useSetAtom(allFrameHeightsAtom)
  const allHeights = useAtomValue(allFrameHeightsAtom)
  const { updateNodeData } = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()
  const relationsMap = useAtomValue(sessionRelationsAtom)
  const project = useAtomValue(projectByIdAtom(session?.projectId ?? ''))
  // childBranches：sessionRelationsAtom.parentSessionId 现在存 claudeId（= sessionId）
  const childBranches = Array.from(relationsMap.entries())
    .filter(([, rel]) => rel.type === 'branch' && rel.parentSessionId === sessionId)

  const containerRef = useRef<HTMLDivElement>(null)
  const startedAt = session?.startedAt ?? Date.now()
  const sessionTokens = useAtomValue(sessionTokensAtom(sessionId))
  const totalConsumedTokens = sessionTokens.inputTokens + sessionTokens.outputTokens +
    sessionTokens.cacheCreationTokens + sessionTokens.cacheReadTokens

  // ── Milestone badges ───────────────────────────────────────────────────────
  const allMilestones = useAtomValue(milestonesByProjectAtom(session?.projectId ?? ''))
  const sessionMilestones = allMilestones.filter((m) => m.sessionId === sessionId)
  if (allMilestones.length > 0) {
    console.log(`[PlanIndicator] SessionFrameNode ${sessionId}: allMilestones=${allMilestones.length} sessionMilestones=${sessionMilestones.length}`)
  }

  // ── ResizeObserver：监听框高度变化，通知 ReactFlow 重新测量节点尺寸 ────────
  // updateNodeData  → 更新 node.data.estimatedHeight（供布局 hook 使用）
  // updateNodeInternals(id) → 通知 @xyflow 重新读取 DOM 尺寸，锚点随高度移动
  // 同时计算可见节点精确 Y 偏移（相对于 .sfn-frame 顶部），存入 nodeYOffsetsAtom
  // 供 BranchEdge Handle top 精确定位，替代 NODE_HEIGHT_ESTIMATE 估算
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height
        setHeight(h)
        // 同步写入全量 Map atom，使 ProcessLineCanvas 订阅到变化触发布局重算
        setAllHeights((prev) => {
          const next = new Map(prev)
          next.set(sessionId, h)
          return next
        })
        updateNodeData(id, { estimatedHeight: h })
        updateNodeInternals(id)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [id, sessionId, setHeight, setAllHeights, updateNodeData, updateNodeInternals])

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
    console.log(`[SessionFrameNode] handleResume: ptyId=${ptyId} projectId=${session?.projectId} project=${project?.id ?? 'null'} sessionId=${sessionId}`)
    if (!ptyId || !project) return
    console.log(`[SFN:WIN] handleResume BEFORE: outerW=${window.outerWidth} outerH=${window.outerHeight} innerW=${window.innerWidth} innerH=${window.innerHeight}`)
    // sessionId = claudeId，直接作为 resumeSessionId 传入（claude -r <claudeId>）
    try {
      const result = await window.api.invoke(IPC.SESSION_RESUME, {
        projectId: project.id,
        projectPath: project.path,
        resumeSessionId: sessionId,
        permissionMode: 'acceptEdits',
      }) as { ok: boolean; sessionId?: string }
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
  }, [ptyId, sessionId, project, agentLabel])

  const handleOpenTerminal = useCallback(() => {
    console.log(`[SessionFrameNode] handleOpenTerminal: ptyId=${ptyId} isCompleted=${isCompleted}`)
    if (!ptyId) return
    void window.api.invoke(IPC.TERM_WINDOW_OPEN, {
      sessionId: ptyId,
      title: t('projectMonitor.canvas.terminalTitle', { label: agentLabel }),
    }).catch((err: unknown) => console.error('[SessionFrameNode] TERM_WINDOW_OPEN failed:', err))
  }, [ptyId, agentLabel])

  return (
    <div
      ref={containerRef}
      className={`sfn-frame ${selected ? 'sfn-frame-selected' : ''}`}
      style={{ borderColor: `${agentColor}60` }}
    >
      {/* 基础 handle（@xyflow 内部要求至少有一个） */}
      <Handle type="target" position={Position.Top} id="default-target" style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} id="default-source" style={{ opacity: 0 }} />

      {/* 动态 source handles：父框一侧，top = frozenOffset（帧底端基准：parentH - FRAME_FOOTER_HEIGHT）
          优先级：triggerYOffset（旧数据兼容）→ computeFrozenOffset（帧底端）→ 绝对 fallback */}
      {childBranches.map(([childId, rel]) => {
        const handlePos = (rel.side ?? 'right') === 'left' ? Position.Left : Position.Right
        const parentH = allHeights.get(sessionId)
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
          <span className="sfn-duration">{formatDuration(startedAt)}</span>
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
        <ProcessTimeline
          sessionId={sessionId}
          embedded={true}
        />
      </div>

      {/* ── 底部操作区 ── */}
      <div className="sfn-footer">
        {/* 中间位置：token 消耗统计 */}
        {totalConsumedTokens > 0 && (
          <span className="sfn-footer-tokens" title={`input: ${sessionTokens.inputTokens} output: ${sessionTokens.outputTokens} cache_create: ${sessionTokens.cacheCreationTokens} cache_read: ${sessionTokens.cacheReadTokens}`}>
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
