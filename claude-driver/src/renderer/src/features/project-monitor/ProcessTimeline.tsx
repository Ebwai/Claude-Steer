// 使用方法：由 ProjectMonitorPage.tsx 渲染在右半区域，或由 SessionFrameNode 以 sessionId 直接使用
// 编译说明：renderer 进程 browser bundle
// 代码说明：历史进程线画布——渲染 JSONL 时间线节点（用户输入 / Claude 回复 / 工具调用）
//           双模式：历史模式（全量 JSONL 批读）+ 实时模式（chokidar tail 追加）
//           Props 两种用法：
//             1. <ProcessTimeline projectId={id} />  ← 兼容旧用法，内部查找 session
//             2. <ProcessTimeline sessionId={id} />  ← SessionFrameNode 直接传 sessionId

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { pathMatches } from '@renderer/utils/pathUtils'
import { useAtomValue, useAtom, useStore } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import { activeSessionsAtom, subagentIdsAtom, sessionRelationsAtom } from '../../atoms/sessions.atom'
import { projectByIdAtom } from '../../atoms/projects.atom'
import type { Session } from '@shared/types/index'
import { timelineBySessionAtom, lineInsertionsBySessionAtom, cursorNodeIndexAtom, type TimelineNode } from '../../atoms/timeline.atom'
import { appendInsertion } from '../../capabilities/timelineStore'
import { markNodeGitted, unmarkNodeGitted } from '../../capabilities/gitCapability'
import { pendingBtwAtom } from '../../atoms/agent-block.atom'
import { nodeJumpRequestAtom } from '../../atoms/viewport.atom'
import { buildJumpableNodes } from '../../capabilities/jumpableNodes'
import LineInsertionItem from './LineInsertionItem'
import SubagentBlock from './SubagentBlock'
import AssignAgentPanel from './AssignAgentPanel'
import { useT } from '../../i18n'
import './ProcessTimeline.css'

interface ProcessTimelineProps {
  /** 兼容旧用法：通过项目 ID 查找 session */
  projectId?: string | null
  /** 新用法（SessionFrameNode）：直接指定 sessionId，跳过 project 查找 */
  sessionId?: string | null
  /** 是否显示为嵌入模式（SessionFrameNode 内使用时不显示空态提示） */
  embedded?: boolean
  /** 拉动条命令跳转目标（user_input 节点 ID），null 表示无跳转命令 */
  scrubberTargetNodeId?: string | null
  /** user_input 节点 ref 注册回调（供 HistoryScrubber 挂载 DOM 参考点） */
  onUserInputRef?: (nodeId: string, el: HTMLDivElement | null) => void
}

// ── 工具类型 → 颜色分类 ────────────────────────────────────────────────────

/** 从 assistant 文本中移除 Insight 块，返回剩余内容（与 useIpcBridge 的提取逻辑对称） */
function stripInsightBlock(text: string): string {
  return text
    .replace(/`★\s*Insight[^`]*`[\s\S]*?(`─+`|$)/g, '')
    .trim()
}

function getToolCategory(toolName: string): 'file' | 'shell' | 'web' | 'agent' | 'other' {
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep'].includes(toolName)) return 'file'
  if (toolName === 'Bash') return 'shell'
  if (toolName === 'WebFetch') return 'web'
  if (toolName === 'Agent') return 'agent'
  return 'other'
}

// ── 已 git 节点：回退 + 删除 commit（独立组件，让 delete 状态只在 isGitted 节点分配）──

interface GittedNodeActionBarProps {
  nodeId: string
  commitHash: string
  sessionId: string | null
  projectPath: string | null
}

function GittedNodeActionBar({ nodeId, commitHash, sessionId, projectPath }: GittedNodeActionBarProps): React.JSX.Element {
  const { t } = useT()
  const store = useStore()
  const [confirming, setConfirming] = useState(false)
  const [deleteConfirming, setDeleteConfirming] = useState(false)
  const [deleteState, setDeleteState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [deleteMsg, setDeleteMsg] = useState('')

  const handleRevert = useCallback(async () => {
    if (!projectPath) return
    try {
      await window.api.invoke(IPC.GIT_RESET, { projectPath, commitHash })
      console.log(`[GittedNodeActionBar] git reset ok: ${commitHash}`)
    } catch (err) {
      console.error('[GittedNodeActionBar] git reset error:', err)
    } finally {
      setConfirming(false)
    }
  }, [commitHash, projectPath])

  const handleDeleteCommit = useCallback(async () => {
    if (!projectPath) return
    setDeleteState('loading')
    setDeleteConfirming(false)
    try {
      const result = await window.api.invoke(IPC.GIT_DELETE_COMMIT, { projectPath, commitHash }) as { ok: boolean; error?: string }
      if (result.ok) {
        setDeleteState('idle')
        console.log(`[GittedNodeActionBar] git delete-commit ok: ${commitHash}`)
        if (sessionId) unmarkNodeGitted(store, sessionId, nodeId)
      } else {
        setDeleteState('error')
        setDeleteMsg(result.error?.slice(0, 80) ?? t('projectMonitor.timeline.deleteFailed'))
        console.warn('[GittedNodeActionBar] git delete-commit failed:', result.error)
      }
    } catch (err) {
      setDeleteState('error')
      setDeleteMsg(String(err).slice(0, 80))
      console.error('[GittedNodeActionBar] git delete-commit error:', err)
    }
  }, [commitHash, projectPath, sessionId, nodeId, store, t])

  if (confirming) {
    return (
      <div className="ptl-action-bar ptl-action-bar-gitted">
        <div className="ptl-confirm-row">
          <span>{t('projectMonitor.timeline.confirmRevert')}</span>
          <button className="ptl-confirm-yes" onClick={() => { void handleRevert() }}>{t('projectMonitor.timeline.confirm')}</button>
          <button className="ptl-confirm-no" onClick={() => setConfirming(false)}>{t('projectMonitor.timeline.cancel')}</button>
        </div>
      </div>
    )
  }
  if (deleteConfirming) {
    return (
      <div className="ptl-action-bar ptl-action-bar-gitted">
        <div className="ptl-confirm-row">
          <span>{t('projectMonitor.timeline.confirmDeleteCommit')}</span>
          <button className="ptl-confirm-yes ptl-confirm-danger" onClick={() => { void handleDeleteCommit() }}>{t('projectMonitor.timeline.deleteConfirm')}</button>
          <button className="ptl-confirm-no" onClick={() => setDeleteConfirming(false)}>{t('projectMonitor.timeline.cancel')}</button>
        </div>
      </div>
    )
  }
  return (
    <div className="ptl-action-bar ptl-action-bar-gitted">
      <button className="ptl-action-btn ptl-action-btn-revert" onClick={() => setConfirming(true)}>
        {t('projectMonitor.timeline.revertToThisVersion')}
      </button>
      <button
        className="ptl-action-btn ptl-action-btn-delete-commit"
        onClick={() => setDeleteConfirming(true)}
        disabled={deleteState === 'loading'}
      >
        {deleteState === 'loading' ? t('projectMonitor.timeline.deleting') : t('projectMonitor.timeline.deleteThisCommit')}
      </button>
      {deleteState === 'error' && (
        <span className="ptl-git-errmsg" title={deleteMsg}>{deleteMsg}</span>
      )}
    </div>
  )
}

// ── assistant 节点底部操作栏 ──────────────────────────────────────────────

interface AssistantActionBarProps {
  node: TimelineNode
  isLastNode: boolean
  sessionId: string | null
  projectPath: string | null
}

function AssistantActionBar({ node, isLastNode, sessionId, projectPath }: AssistantActionBarProps): React.JSX.Element {
  const { t } = useT()
  const store = useStore()
  const [subMenuOpen, setSubMenuOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [btwOpen, setBtwOpen] = useState(false)
  const [gitState, setGitState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [gitMsg, setGitMsg] = useState('')
  const [btwText, setBtwText] = useState('')
  const btwRef = useRef<HTMLTextAreaElement>(null)

  const handleGitSnapshot = useCallback(async () => {
    console.log(`[AssistantActionBar] handleGitSnapshot: sessionId=${sessionId ?? 'NULL'} projectPath=${projectPath ?? 'NULL'}`)
    if (!sessionId || !projectPath) return
    setGitState('loading')
    setGitMsg('')
    try {
      const msgText = (node.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
      const message = msgText ? `snapshot: ${msgText}` : `snapshot: node-${node.id.slice(0, 8)}`
      const result = await window.api.invoke(IPC.GIT_COMMIT, {
        projectPath,
        message,
      }) as { ok: boolean; commitHash?: string; error?: string }
      if (result.ok) {
        const hash = result.commitHash ?? ''
        markNodeGitted(store, sessionId, node.id, hash)
        setGitState('ok')
        setGitMsg(hash.slice(0, 7))
        console.log(`[AssistantActionBar] git snapshot ok: ${hash}`)
      } else {
        // 从错误字符串中提取可读原因（去掉 Node.js execFileSync 堆栈前缀）
        const raw = result.error ?? t('projectMonitor.timeline.unknownError')
        const readable = raw.includes('nothing to commit')
          ? t('projectMonitor.timeline.noFilesToSnapshot')
          : raw.includes('does not have any commits')
          ? t('projectMonitor.timeline.noCommitHistory')
          : raw.split('\n').find((l) => l.trim() && !l.startsWith('Error:') && !l.startsWith('    at ')) ?? raw.slice(0, 80)
        setGitState('error')
        setGitMsg(readable)
        console.warn('[AssistantActionBar] git snapshot failed:', result)
      }
    } catch (err) {
      setGitState('error')
      setGitMsg(String(err).slice(0, 80))
      console.error('[AssistantActionBar] git snapshot error:', err)
    }
  }, [node.id, node.text, sessionId, projectPath, store, t])

  const handleBranch = useCallback(() => {
    if (!sessionId) return
    void window.api.invoke(IPC.SESSION_INPUT, { sessionId, text: '/branch\n' })
      .catch((err: unknown) => console.error('[AssistantActionBar] /branch failed:', err))
  }, [sessionId])

  const handleBtwOpen = useCallback(() => {
    setBtwOpen(true)
    setSubMenuOpen(false)
    setAssignOpen(false)
    // 下一帧 focus
    setTimeout(() => btwRef.current?.focus(), 50)
  }, [])

  const handleBtwSend = useCallback(() => {
    const content = btwText.trim()
    if (!content || !sessionId) return
    void window.api.invoke(IPC.SESSION_INPUT, { sessionId, text: `/btw ${content}\n` })
      .catch((err: unknown) => console.error('[AssistantActionBar] /btw send failed:', err))
    // /btw 是 ephemeral，必须在 UI 层立即创建插入线；SubagentStop 时回填 last_assistant_message
    const insertionId = `${sessionId}-btw-${Date.now()}`
    appendInsertion(store, sessionId, {
      id: insertionId,
      type: 'btw',
      direction: 'left',
      color: '#DA7756',
      length: 'long',
      sessionId,
      timestamp: Date.now(),
      badgeContent: { toolName: '💬 btw', displayText: content },
      status: 'running',
      isAnimating: true,
      lineLabel: t('projectMonitor.timeline.tempQuestion'),
    })
    // 登记 pending：等 SubagentStop 携带 last_assistant_message 时回填
    store.set(pendingBtwAtom, (prev) => {
      const next = new Map(prev)
      next.set(sessionId, insertionId)
      return next
    })
    console.log(`[AssistantActionBar] /btw sent insertionId=${insertionId} content=${content.slice(0, 40)}`)
    setBtwText('')
    setBtwOpen(false)
  }, [btwText, sessionId, store, t])

  // 最后节点：Git 快照 + 创建多 Agent
  if (isLastNode) {
    const gitBtnLabel =
      gitState === 'loading' ? t('projectMonitor.timeline.gitCommitting') :
      gitState === 'ok'      ? t('projectMonitor.timeline.gitSnapshotOk', { hash: gitMsg }) :
      t('projectMonitor.timeline.gitSnapshot')
    const gitBtnClass = `ptl-action-btn ptl-action-btn-git${gitState === 'ok' ? ' ptl-action-btn-git-ok' : gitState === 'error' ? ' ptl-action-btn-git-err' : ''}`

    return (
      <>
        <div className="ptl-action-bar">
          <button
            className={gitBtnClass}
            onClick={() => { if (gitState !== 'loading') void handleGitSnapshot() }}
            disabled={gitState === 'loading'}
          >
            {gitBtnLabel}
          </button>
          {gitState === 'error' && (
            <span className="ptl-git-errmsg" title={gitMsg}>{gitMsg}</span>
          )}
          <button
            className="ptl-action-btn ptl-action-btn-agent"
            onClick={() => setSubMenuOpen((v) => !v)}
          >
            {t('projectMonitor.timeline.createMultiAgent')} {subMenuOpen ? '▲' : '▸'}
          </button>
        </div>
        {subMenuOpen && (
          <div className="ptl-submenu">
            <button className="ptl-submenu-item" onClick={handleBranch}>{t('projectMonitor.timeline.openBranchAgent')}</button>
            <button
              className="ptl-submenu-item"
              onClick={() => setAssignOpen((v) => !v)}
            >
              {t('projectMonitor.timeline.assignAgentWork')}
            </button>
            <button className="ptl-submenu-item" onClick={handleBtwOpen}>{t('projectMonitor.timeline.btwQuickAsk')}</button>
          </div>
        )}
        {assignOpen && sessionId && projectPath && (
          <AssignAgentPanel
            sessionId={sessionId}
            projectPath={projectPath}
            onClose={() => { setAssignOpen(false) }}
          />
        )}
        {btwOpen && (
          <div className="ptl-btw-input-area">
            <textarea
              ref={btwRef}
              className="ptl-btw-textarea"
              value={btwText}
              placeholder={t('projectMonitor.timeline.btwInputPlaceholder')}
              rows={1}
              onChange={(e) => {
                setBtwText(e.target.value)
                // auto-grow
                e.target.style.height = 'auto'
                e.target.style.height = `${e.target.scrollHeight}px`
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleBtwSend() }
                if (e.key === 'Escape') { setBtwOpen(false); setBtwText('') }
              }}
            />
            <div className="ptl-btw-actions">
              <button className="ptl-btw-cancel" onClick={() => { setBtwOpen(false); setBtwText('') }}>{t('projectMonitor.timeline.cancel')}</button>
              <button className="ptl-btw-send" onClick={handleBtwSend} disabled={!btwText.trim()}>{t('projectMonitor.timeline.send')}</button>
            </div>
          </div>
        )}
      </>
    )
  }

  // 已 git 的非最后节点：回退 + 删除此 commit（委托给 GittedNodeActionBar）
  if (node.isGitted && node.commitHash) {
    return <GittedNodeActionBar nodeId={node.id} commitHash={node.commitHash} sessionId={sessionId} projectPath={projectPath} />
  }

  // 普通节点：空操作栏（占位保持视觉一致）
  return <div className="ptl-action-bar" />
}

// ── 单个时间线节点渲染 ─────────────────────────────────────────────────────

interface NodeProps {
  node: TimelineNode
  toolResults: Map<string, TimelineNode>
  onUserInputRef?: (nodeId: string, el: HTMLDivElement | null) => void
  isLastNode?: boolean
  sessionId?: string | null
  projectPath?: string | null
  isCursor?: boolean
}

function TimelineNodeItem({ node, toolResults, onUserInputRef, isLastNode, sessionId, projectPath, isCursor }: NodeProps): React.JSX.Element {
  const { t } = useT()
  const [expanded, setExpanded] = useState(false)
  const MAX_TEXT = 400
  const MAX_USER_LINES = 10
  const cursorClass = isCursor ? ' ptl-node--cursor' : ''

  if (node.type === 'user_input') {
    const lines = (node.text ?? '').split('\n')
    const isUserLong = lines.length > MAX_USER_LINES
    const displayText = isUserLong && !expanded
      ? lines.slice(0, MAX_USER_LINES).join('\n') + '\n…'
      : (node.text ?? '')
    return (
      <div
        className={`ptl-node ptl-node-user${cursorClass}`}
        data-nodeid={node.id}
        ref={(el) => onUserInputRef?.(node.id, el)}
      >
        <span className="ptl-dot ptl-dot-user" />
        <div className="ptl-user-bubble">
          <div className="ptl-user-bubble-header">
            <span className="ptl-user-prefix">{t('projectMonitor.timeline.userPrefix')}</span>
            {/* 删除功能预留：功能即将上线，暂不可交互 */}
            <span className="ptl-delete-placeholder" title={t('projectMonitor.timeline.deleteComingSoon')}>🗑</span>
          </div>
          <span className="ptl-user-text">{displayText}</span>
          {isUserLong && (
            <button className="ptl-expand-btn" onClick={() => setExpanded((v) => !v)}>
              {expanded ? t('projectMonitor.timeline.collapse') : t('projectMonitor.timeline.expandFull', { lines: lines.length })}
            </button>
          )}
        </div>
      </div>
    )
  }

  if (node.type === 'assistant') {
    const text = stripInsightBlock(node.text ?? '')
    if (!text) return <></>
    const isLong = text.length > MAX_TEXT
    return (
      <div className={`ptl-node ptl-node-assistant${cursorClass}`} data-nodeid={node.id}>
        <span className={`ptl-dot ptl-dot-assistant${node.isGitted ? ' ptl-dot-gitted' : ''}`} />
        <div className="ptl-assistant-card">
          <div className="ptl-assistant-text">
            {isLong && !expanded ? text.slice(0, MAX_TEXT) + '…' : text}
          </div>
          {isLong && (
            <button className="ptl-expand-btn" onClick={() => setExpanded((v) => !v)}>
              {expanded ? t('projectMonitor.timeline.collapse') : t('projectMonitor.timeline.expandFullText')}
            </button>
          )}
          <AssistantActionBar
            node={node}
            isLastNode={isLastNode ?? false}
            sessionId={sessionId ?? null}
            projectPath={projectPath ?? null}
          />
        </div>
      </div>
    )
  }

  // 注意：此段 tool_use 卡片渲染代码为前期设计时所写，目前并没有用于实际显示中。
  // 因为 visibleNodes 过滤在 L538 只保留 user_input / assistant，tool_use 节点不会传入此函数。
  if (node.type === 'tool_use') {
    const category = getToolCategory(node.toolName ?? '')
    const result = node.toolUseId ? toolResults.get(node.toolUseId) : undefined
    return (
      <div className="ptl-node ptl-node-tool">
        <span className="ptl-dot ptl-dot-tool" />
        <div className={`ptl-tool-box ptl-tool-${category}`}>
          <span className="ptl-tool-name">{node.toolName}</span>
          <span className="ptl-tool-text">{node.toolDisplayText}</span>
          {result && (
            <span className={`ptl-tool-result ${result.isError ? 'ptl-tool-error' : 'ptl-tool-ok'}`}>
              {result.isError ? t('projectMonitor.timeline.toolFailed') : '✓'}
            </span>
          )}
        </div>
      </div>
    )
  }

  return <></>
}

// ── 主组件 ─────────────────────────────────────────────────────────────────

function ProcessTimeline({ projectId, sessionId: directSessionId, embedded = false, scrubberTargetNodeId, onUserInputRef }: ProcessTimelineProps): React.JSX.Element {
  const { t } = useT()
  const project        = useAtomValue(projectByIdAtom(projectId ?? ''))
  const activeSessions = useAtomValue(activeSessionsAtom)

  // ── session 解析：优先使用 directSessionId，否则通过 project 查找 ──────────
  let resolvedSession: Session | undefined
  if (directSessionId) {
    resolvedSession = activeSessions.get(directSessionId)
  } else if (project?.activeSessionId) {
    resolvedSession = activeSessions.get(project.activeSessionId)
  }
  if (!resolvedSession && !directSessionId && project) {
    for (const s of activeSessions.values()) {
      if ((s.status === 'Running' || s.status === 'Paused') &&
          pathMatches(s.cwd, project.path)) {
        resolvedSession = s
        break
      }
    }
  }

  const sessionId   = directSessionId ?? resolvedSession?.id ?? null
  const session     = resolvedSession
  const [nodes]     = useAtom(timelineBySessionAtom(sessionId ?? '__none__'))
  const insertions  = useAtomValue(lineInsertionsBySessionAtom(sessionId ?? '__none__'))
  console.log(`[ProcessTimeline] sessionId=${sessionId?.slice(0,8) ?? 'null'} nodes=${nodes.length} insertions=${insertions.length}`)
  const subagentIds = useAtomValue(subagentIdsAtom(sessionId ?? '__none__'))

  // ── 键盘游标节点 ID（用于 cursor overlay 指示器）────────────────────────────
  const cursorIdx = useAtomValue(cursorNodeIndexAtom(sessionId ?? '__none__'))
  const jumpable  = useMemo(() => buildJumpableNodes(nodes, insertions), [nodes, insertions])
  const cursorNodeId = cursorIdx >= 0 && cursorIdx < jumpable.length
    ? jumpable[cursorIdx].id
    : null

  // ── nodeJumpRequestAtom：响应全局导航条 / 键盘跳转（替代旧 scrubberTarget）──
  const nodeJumpReq = useAtomValue(nodeJumpRequestAtom)
  useEffect(() => {
    if (!nodeJumpReq || nodeJumpReq.sessionId !== sessionId || !containerRef.current) return
    const el = containerRef.current.querySelector<HTMLElement>(
      `[data-nodeid="${nodeJumpReq.nodeId}"]`
    )
    if (el) {
      containerRef.current.scrollTop = el.offsetTop - containerRef.current.clientHeight / 2 + el.clientHeight / 2
    }
  }, [nodeJumpReq, sessionId])
  // branch session：用 isBranchStart 标记定位切割点，过滤父 session 历史前缀
  const relationsMap = useAtomValue(sessionRelationsAtom)
  const branchRelation = sessionId ? relationsMap.get(sessionId) : undefined
  const isBranchSession = branchRelation?.type === 'branch'

  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // ── 自动滚到底部 ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [nodes, autoScroll])

  // 用户手动向上滚动时关闭 autoScroll
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(atBottom)
  }, [])

  // ── 拉动条跳转：scrubberTargetNodeId 变化时滚动容器 ─────────────────────
  useEffect(() => {
    if (!scrubberTargetNodeId || !containerRef.current) return
    // 通过 onUserInputRef 注册的 DOM ref 在父组件 map 里；这里用 data-nodeid 属性查找
    const el = containerRef.current.querySelector<HTMLDivElement>(
      `[data-nodeid="${scrubberTargetNodeId}"]`
    )
    if (el) {
      containerRef.current.scrollTop = el.offsetTop - 16
    }
  }, [scrubberTargetNodeId])

  // ── 触发 JSONL 监听（历史 + 实时）────────────────────────────────────────
  useEffect(() => {
    if (!sessionId || !session?.transcriptPath) return

    void window.api.invoke(IPC.JSONL_WATCH, {
      transcriptPath: session.transcriptPath,
      sessionId,
      readFromStart: true,   // 总是先读历史，watcher 之后追加实时
    }).catch((err: unknown) => {
      console.error('[ProcessTimeline] JSONL_WATCH failed:', err)
    })
  }, [sessionId, session?.transcriptPath])

  // ── 构建 tool_result 查找表（toolUseId → node）────────────────────────────
  const toolResults = new Map<string, TimelineNode>()
  for (const n of nodes) {
    if (n.type === 'tool_result' && n.toolUseId) {
      toolResults.set(n.toolUseId, n)
    }
  }

  // 只显示 user_input 和 assistant 节点。
  // 注意：tool_use / tool_result 在此被过滤，不显示为独立卡片。
  // 工具调用转而通过侧边插入线（LineInsertion）来体现。TimelineNodeItem 中的 tool_use 渲染代码为前期设计遗留，暂未启用。
  // branch session：找第一个 isBranchStart=true 的节点，只显示该节点及之后的内容
  // 若尚未收到 isBranchStart 节点则显示空（等待），完全不依赖 IPC 时序
  // 非 branch session：直接显示全部（不影响主线/并行 session）
  const allVisible = nodes.filter((n) => n.type === 'user_input' || n.type === 'assistant')
  const visibleNodes = (() => {
    if (!isBranchSession) return allVisible
    const startIdx = allVisible.findIndex((n) => n.isBranchStart)
    return startIdx >= 0 ? allVisible.slice(startIdx) : []
  })()

  // dispatch 线与 subagentIds 按出现顺序一一对应（n 番 dispatch 对应 subagentIds[n]）
  // agentId 在 PreToolUse Agent 时尚未知，由后续 subagent 内部工具触发时 registerSubagentId 填入
  let subagentRenderIdx = 0

  /**
   * 渲染一组插入线：
   * - "分配任务"线：渲染线本体 + 紧随 SubagentBlock（SubagentBlock 内部自行渲染返回线）
   * - "返回任务结果"线：跳过（由对应 SubagentBlock 内部渲染，避免 Y 坐标分离）
   * - 其他线：直接渲染
   */
  const renderInsertions = (insItems: typeof insertions, activeCursorId?: string | null): React.ReactNode[] => {
    return insItems.flatMap((ins) => {
      // 返回任务结果线由 SubagentBlock 内部渲染，主时间线跳过
      if (ins.type === 'subagent' && ins.lineLabel === '返回任务结果') return []

      const isCursorIns = ins.id === activeCursorId
      const items: React.ReactNode[] = [
        <div
          key={ins.id}
          data-nodeid={ins.id}
          className={isCursorIns ? 'ptl-insertion-wrapper ptl-node--cursor' : 'ptl-insertion-wrapper'}
        >
          <LineInsertionItem insertion={ins} />
        </div>
      ]
      if (ins.type === 'subagent' && ins.lineLabel === '分配任务' && sessionId) {
        const agentId = subagentIds[subagentRenderIdx]
        subagentRenderIdx++
        if (agentId) {
          items.push(
            <SubagentBlock
              key={`sab-${agentId}`}
              sessionId={sessionId}
              agentId={agentId}
              dispatchWidth={ins.customWidth ?? 144}
              toolUseId={ins.toolUseId}
            />
          )
        }
      }
      return items
    })
  }

  // ── 空态渲染（非嵌入模式才显示提示）────────────────────────────────────
  if (!embedded) {
    if (!projectId || !project) {
      return (
        <div className="ptl-empty">
          <span className="ptl-empty-icon">◈</span>
          <span>{t('projectMonitor.timeline.selectProjectAbove')}</span>
        </div>
      )
    }

    if (!sessionId) {
      return (
        <div className="ptl-empty">
          <span className="ptl-empty-icon">⏸</span>
          <span>{t('projectMonitor.timeline.noRunningSession')}</span>
          <span className="ptl-empty-sub">{t('projectMonitor.timeline.startFromGlobalMonitor')}</span>
        </div>
      )
    }
  }

  return (
    <div className="ptl-container" ref={containerRef} onScroll={handleScroll}>
      {/* 左侧竖线时间轴 */}
      <div className="ptl-axis" />

      {/* 起始标记 */}
      <div className="ptl-node ptl-node-start">
        <span className="ptl-dot ptl-dot-start" />
        <div className="ptl-start-label">
          <span className="ptl-start-dot-outer" />
          {t('projectMonitor.timeline.sessionStarted')}{project ? ` · ${project.name}` : ''}
        </div>
      </div>

      {/* 时间线节点 + 节点间/节点后插入元素（按时间戳穿插） */}
      {(() => {
        const lastAssistantNode = [...visibleNodes].reverse().find((n) => n.type === 'assistant')
        return visibleNodes.map((node, idx) => {
          const nextNode = visibleNodes[idx + 1]
          const windowStart = node.parsedAt
          const windowEnd = nextNode ? nextNode.parsedAt : Infinity
          const nodeInsertions = insertions.filter(
            (ins) => ins.timestamp >= windowStart && ins.timestamp < windowEnd
          )
          const isLastNode = node.type === 'assistant' && node.id === lastAssistantNode?.id
          return (
            <React.Fragment key={node.id}>
              <TimelineNodeItem
                node={node}
                toolResults={toolResults}
                onUserInputRef={onUserInputRef}
                isLastNode={isLastNode}
                sessionId={sessionId}
                projectPath={session?.cwd ?? null}
                isCursor={node.id === cursorNodeId}
              />
              {renderInsertions(nodeInsertions, cursorNodeId)}
            </React.Fragment>
          )
        })
      })()}
      {/* 无 JSONL 节点时的实时插入元素（session 刚启动，JSONL 文件还未有内容）*/}
      {visibleNodes.length === 0 && renderInsertions(insertions, cursorNodeId)}

      {/* Running：显示"运行中…"；Paused（Stop hook 触发后）：显示"等待输入" */}
      {session?.status === 'Running' && (
        <div className="ptl-node ptl-running-indicator">
          <span className="ptl-dot ptl-dot-running" />
          <span className="ptl-running-text">{t('projectMonitor.timeline.running')}</span>
        </div>
      )}
      {session?.status === 'Paused' && (
        <div className="ptl-node ptl-waiting-indicator">
          <span className="ptl-dot ptl-dot-waiting" />
          <span className="ptl-waiting-text">{t('projectMonitor.timeline.waitingForInput')}</span>
        </div>
      )}

      {/* 自动滚动提示 */}
      {!autoScroll && (
        <button className="ptl-scroll-btn" onClick={() => {
          setAutoScroll(true)
          containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' })
        }}>
          {t('projectMonitor.timeline.scrollToBottom')}
        </button>
      )}
    </div>
  )
}

export default ProcessTimeline
