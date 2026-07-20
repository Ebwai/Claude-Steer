// 使用方法：由 ProjectMonitorPage.tsx 渲染在左半区域
// 编译说明：renderer 进程 browser bundle
// 代码说明：项目监控左半面板——执行计划折叠区 + 当前工作情况 + 消息输入行

import React, { useCallback } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { activeProjectIdAtom, projectByIdAtom } from '../../atoms/projects.atom'
import { ptySessionIdsAtom, ptyBindingsAtom, agentBlocksAtom, agentLabelsAtom } from '../../atoms/sessions.atom'
import { activeSessionsAtom } from '../../atoms/session-core.atom'
import { IPC } from '@shared/events/ipc-channels'
import { pendingPtyStartsAtom } from '../../atoms/pending-starts.atom'
import { pathMatches } from '@renderer/utils/pathUtils'
import { useT } from '../../i18n'
import PlanSection from './PlanSection'
import AgentBlock from './AgentBlock'
import ContextPanel from './ContextPanel'
import StatusBar from './StatusBar'
import './LeftPanel.css'

function LeftPanel(): React.JSX.Element {
  const { t } = useT()
  const store          = useStore()
  const activeId       = useAtomValue(activeProjectIdAtom)
  const project        = useAtomValue(projectByIdAtom(activeId ?? ''))
  const activeSessions  = useAtomValue(activeSessionsAtom)
  const ptySessionIds   = useAtomValue(ptySessionIdsAtom)
  const ptyBindings     = useAtomValue(ptyBindingsAtom)
  const agentBlocks     = useAtomValue(agentBlocksAtom)
  const agentLabels     = useAtomValue(agentLabelsAtom)
  const pendingPtyStarts = useAtomValue(pendingPtyStartsAtom)

  // 收集当前项目所有活跃 session（Running / Paused），支持多 Agent 并行
  // entry 以 claudeId 为 key，SessionStart Hook 到达后创建；ptySessionIdsAtom 中存 claudeId
  const projectSessions = project
    ? Array.from(activeSessions.values()).filter(
        (s) =>
          ptySessionIds.has(s.claudeId ?? s.id) &&
          (s.status === 'Running' || s.status === 'Paused') &&
          pathMatches(s.cwd, project.path)
      )
    : []

  // 调试：打出完整 activeSessions + ptySessionIds + projectSessions
  if (projectSessions.length > 0 || ptySessionIds.size > 0 || activeSessions.size > 0) {
    const allEntries = Array.from(activeSessions.entries()).map(([k,v]) => `${k.slice(0,8)}(id=${v.id.slice(0,8)},st=${v.status},inPty=${ptySessionIds.has(k)})`)
    console.log(`[LP] activeSessions(${activeSessions.size}): ${allEntries.join(' | ')}`)
    console.log(`[LP] ptySessionIds(${ptySessionIds.size}): [${Array.from(ptySessionIds).map(s=>s.slice(0,8)).join(',')}]`)
    console.log(`[LP] projectSessions(${projectSessions.length}): ${projectSessions.map(s=>`key=${s.id.slice(0,8)} claude=${(s.claudeId??s.id).slice(0,8)} status=${s.status}`).join(', ')}`)
  }

  // pending 中有该项目路径 → 已发出 SESSION_START，等待 SessionStart Hook 创建 entry
  const hasPendingStart = project ? pendingPtyStarts.has(project.path) : false
  // isActiveSession：有活跃 session 或有 pending，决定隐藏"启动"按钮
  const isActiveSession = projectSessions.length > 0 || hasPendingStart

  const handleStartSession = useCallback(async () => {
    console.log(`[LP] handleStartSession CLICKED project=${project?.id?.slice(0,8) ?? 'NULL'} hasPendingStart=${hasPendingStart}`)
    if (!project || hasPendingStart) { console.log(`[LP] handleStartSession BLOCKED: project=${!!project} hasPendingStart=${hasPendingStart}`); return }
    console.log(`[LP:WIN] handleStartSession BEFORE: outerW=${window.outerWidth} outerH=${window.outerHeight} innerW=${window.innerWidth} innerH=${window.innerHeight}`)
    try {
      const result = await window.api.invoke(IPC.SESSION_START, {
        projectId: project.id,
        projectPath: project.path,
        permissionMode: 'acceptEdits',
      }) as { ok: boolean; sessionId?: string; error?: string }
      console.log(`[LP:WIN] handleStartSession AFTER: outerW=${window.outerWidth} outerH=${window.outerHeight} innerW=${window.innerWidth} innerH=${window.innerHeight}`)

      if (result.ok && result.sessionId) {
        // 只写 pending，等 SessionStart Hook 到达后 sessionLifecycle 以 claudeId 创建正式 entry
        store.set(pendingPtyStartsAtom, (prev) => {
          const m = new Map(prev)
          m.set(project.path, { ptyId: result.sessionId!, projectId: project.id })
          return m
        })
      }
    } catch (err) {
      console.error('[LeftPanel] start session failed:', err)
    }
  }, [project, hasPendingStart, store])

  if (!project) {
    return (
      <div className="lp-container lp-empty">
        <span className="lp-empty-icon">◈</span>
        <span>{t('projectMonitor.leftPanel.selectProjectHint')}</span>
      </div>
    )
  }

  return (
    <div className="lp-container">
      {/* S2 T1: 执行计划折叠区 */}
      <PlanSection projectId={project.id} />

      {/* S2 T2: 当前工作情况区（Agent Block 列表） */}
      <div className="lp-agent-list">
        {activeSessions.size === 0 || !projectSessions.length ? (
          <div className="lp-work-empty">
            <span className="lp-ph-label">{t('projectMonitor.leftPanel.noActiveAgent')}</span>
          </div>
        ) : (
          projectSessions.map((sess, idx) => {
            // agentBlocksAtom 的 key 是 Hook claudeId，sess.claudeId 即是
            // Map key 已是 claudeId，直接查；fallback 用 ptyToClaudeMap 或 CWD 匹配
            const claudeId = sess.claudeId ?? ptyBindings.ptyToClaudeMap.get(sess.id)
            const block = (claudeId ? agentBlocks.get(claudeId) : undefined)
              ?? Array.from(agentBlocks.values()).find(
                (b) => b.sessionCwd && pathMatches(sess.cwd, b.sessionCwd)
              )
              ?? {
                sessionId: sess.id,
                sessionCwd: sess.cwd,
                workStatusText: '',
                activeTools: [],
                activeExperiences: [],
                activeSubagent: null,
                activeInsight: null,
              }
            const colors = ['#35C98A', '#5B9BD5', '#DA7756', '#8B6FCB']
            const color = colors[idx % colors.length]
            const sessClaudeId = sess.claudeId ?? sess.id
            const label = agentLabels.get(sessClaudeId) ?? (idx === 0 ? t('projectMonitor.leftPanel.mainline') : t('projectMonitor.leftPanel.agentLabel', { index: idx + 1 }))
            return (
              <AgentBlock
                key={sess.claudeId ?? sess.id}
                session={sess}
                block={block}
                agentLabel={label}
                agentColor={color}
              />
            )
          })
        )}
      </div>

      {/* S2 T4: 上下文面板（层④）——常驻，有 session 时传入 session 列表 */}
      <ContextPanel
        sessions={projectSessions}
        primarySessionId={projectSessions[0]?.id ?? ''}
      />

      {/* 无活跃 session 时显示"启动"按钮 */}
      {!isActiveSession && (
        <div className="lp-start-area">
          <button className="lp-btn-start" onClick={handleStartSession} disabled={hasPendingStart}>
            {hasPendingStart ? t('projectMonitor.leftPanel.starting') : t('projectMonitor.leftPanel.startSession')}
          </button>
        </div>
      )}

      {/* S2 T6: 底部状态栏——常驻最底部 */}
      <StatusBar sessions={projectSessions} />
    </div>
  )
}

export default LeftPanel
