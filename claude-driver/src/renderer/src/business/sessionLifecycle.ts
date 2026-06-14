// 使用方法：import { createSessionLifecycle } from '@renderer/business/sessionLifecycle'
// 编译说明：renderer 进程 browser bundle
// 代码说明：BL-2 Session 生命周期处理——SessionStart / SessionEnd / Stop Hook 事件
//           不感知 branch，branch 完整流程由 branchHandler 独立处理
//           SessionStart Hook 到达时消费 pendingPtyStartsAtom，以 claudeId 为 key 创建 entry

import { IPC } from '@shared/events/ipc-channels'
import type { HookEvent, Session } from '@shared/types/index'
import { pathMatches } from '@renderer/utils/pathUtils'
import {
  createSession,
  patchSession,
  completeSession,
  getSession,
  findSessionByCwd,
} from '@renderer/capabilities/sessionRegistry'
import { addToRealtime, removeFromRealtime, isRealtimeVisible } from '@renderer/capabilities/realtimeVisibility'
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import { clearWorkStatus } from '@renderer/capabilities/agentActivity'
import { pendingPtyStartsAtom } from '@renderer/atoms/pending-starts.atom'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

export interface SessionStartPayload {
  sessionId: string    // claudeId
  cwd: string
  transcriptPath?: string | null
  receivedAt: number
}

export interface SessionEndPayload {
  sessionId: string    // claudeId
  cwd: string
  receivedAt: number
}

export interface StopPayload {
  sessionId: string    // claudeId
  cwd: string
}

export function createSessionLifecycle(store: Store, isBranchPending?: () => boolean) {
  function handleSessionStart(payload: SessionStartPayload): void {
    const { sessionId: claudeId, cwd, transcriptPath, receivedAt } = payload
    console.log(`[BL-2] handleSessionStart: claudeId=${claudeId.slice(0,8)} cwd=${cwd}`)

    // 消费 pendingPtyStartsAtom（SESSION_START 后写入，SessionStart Hook 到达时消费）
    // pending key 是 projectPath，与 cwd 精确或前缀匹配
    const pendingMap = store.get(pendingPtyStartsAtom)
    let pendingPtyId: string | undefined
    let pendingProjectId: string | undefined
    for (const [pendingCwd, p] of pendingMap) {
      if (pathMatches(cwd, pendingCwd)) {
        pendingPtyId = p.ptyId
        pendingProjectId = p.projectId
        store.set(pendingPtyStartsAtom, (prev) => {
          const m = new Map(prev)
          m.delete(pendingCwd)
          return m
        })
        break
      }
    }

    // ── 迁移：检查是否有早期 PTY_BIND 创建的 ptyId-keyed 占位 entry ──
    // 场景：SESSION_START 成功后主进程立即发送早期 PTY_BIND（claudeId=ptyId），
    //       SessionStart Hook 随后到达时 claudeId 与 ptyId 不同，
    //       需要先迁移占位 entry，避免创建重复 entry
    const ptyId = pendingPtyId
    if (ptyId && ptyId !== claudeId) {
      const placeholder = getSession(store, ptyId)
      if (placeholder && placeholder.claudeId === ptyId) {
        // 迁移：从 ptyId-keyed → claudeId-keyed
        store.set(activeSessionsAtom, (prev) => {
          const next = new Map(prev)
          next.delete(ptyId)
          next.set(claudeId, {
            ...placeholder,
            claudeId,
            id: ptyId,
            ...(transcriptPath ? { transcriptPath } : {}),
            status: 'Running',
            cwd,
          })
          return next
        })
        // 迁移 realtime 可见性
        if (isRealtimeVisible(store, ptyId)) {
          removeFromRealtime(store, ptyId)
        }
        addToRealtime(store, claudeId)
        console.log(`[BL-2] handleSessionStart: migrated placeholder ${ptyId.slice(0,8)} → ${claudeId.slice(0,8)}`)
        // 迁移完成，existing 检查会在下面找到已迁移的 entry
      }
    }

    // branch session 竞态防护：若 branchHandler 当前处于 PENDING_BIND，
    // 说明此 SessionStart Hook 对应的 session 是 branch，branchHandler 的 handlePtyBind 随后会
    // 先 registerBranch 再 addToRealtime，确保 agentLabelsAtom 计算时关系已存在。
    // 此处跳过 addToRealtime，避免抢先触发导致短暂 "Agent" 标签。
    const skipRealtime = isBranchPending?.() ?? false
    if (skipRealtime) {
      console.log(`[BL-2] handleSessionStart: skipping addToRealtime for branch-pending session claudeId=${claudeId.slice(0,8)}`)
    }

    // 情况 A：claudeId entry 已存在（PTY_BIND 比 SessionStart Hook 先到，或上面迁移已创建）
    const existing = getSession(store, claudeId)
    if (existing) {
      patchSession(store, claudeId, {
        transcriptPath: transcriptPath ?? existing.transcriptPath ?? undefined,
        status: 'Running',
        // PTY_BIND path C 时 projectId 和 cwd 可能为空，此处补全
        projectId: pendingProjectId ?? existing.projectId,
        cwd,
      })
      if (!skipRealtime) addToRealtime(store, claudeId)
      return
    }

    // 情况 B：entry 不存在——创建新 entry（SessionStart Hook 先于 PTY_BIND，正常情况）
    const newSession: Session = {
      id: pendingPtyId ?? claudeId,   // ptyId 来自 pending；外部启动则先用 claudeId 占位
      claudeId,
      projectId: pendingProjectId ?? '',
      status: 'Running',
      currentModel: null,
      tokenUsage: { current: null, max: null, usedPercentage: null },
      transcriptPath: transcriptPath ?? null,
      cwd,
      startedAt: receivedAt,
      endedAt: null,
      worktreePath: null,
    }
    createSession(store, claudeId, newSession)
    if (!skipRealtime) addToRealtime(store, claudeId)
  }

  function handleSessionEnd(payload: SessionEndPayload): void {
    const { sessionId: claudeId, cwd, receivedAt } = payload

    // 正常结束（branch 流程由 branchHandler 独立处理，不在此拦截）
    const existing = getSession(store, claudeId)
    if (existing) {
      completeSession(store, claudeId, receivedAt)
      removeFromRealtime(store, claudeId)
    } else {
      // CWD fallback（极端情况：外部启动 session 且 PTY_BIND 还未到达）
      const matched = findSessionByCwd(store, cwd)
      if (matched) {
        const [matchedKey, matchedSess] = matched
        if (matchedSess.status === 'Running' || matchedSess.status === 'Paused') {
          completeSession(store, matchedKey, receivedAt)
          removeFromRealtime(store, matchedKey)
        }
      }
    }
  }

  function handleStop(payload: StopPayload): void {
    const { sessionId: claudeId, cwd } = payload

    const existing = getSession(store, claudeId)
    if (existing && existing.status === 'Running') {
      patchSession(store, claudeId, { status: 'Paused' })
    } else {
      // CWD fallback
      const matched = findSessionByCwd(store, cwd)
      if (matched) {
        const [matchedKey, matchedSess] = matched
        if (matchedSess.status === 'Running') {
          patchSession(store, matchedKey, { status: 'Paused' })
        }
      }
    }

    clearWorkStatus(store, claudeId)
  }

  function register(): Array<() => void> {
    return [
      window.api.on(IPC.HOOK_EVENT, (event: unknown) => {
        const hookEvent = event as HookEvent
        if (hookEvent.eventName === 'SessionStart') {
          handleSessionStart({
            sessionId: hookEvent.sessionId,
            cwd: hookEvent.cwd,
            transcriptPath: hookEvent.transcriptPath,
            receivedAt: hookEvent.receivedAt,
          })
        }
        if (hookEvent.eventName === 'SessionEnd') {
          handleSessionEnd({
            sessionId: hookEvent.sessionId,
            cwd: hookEvent.cwd,
            receivedAt: hookEvent.receivedAt,
          })
        }
        if (hookEvent.eventName === 'Stop') {
          handleStop({
            sessionId: hookEvent.sessionId,
            cwd: hookEvent.cwd,
          })
        }
      }),
    ]
  }

  return { register, handleSessionStart, handleSessionEnd, handleStop }
}
