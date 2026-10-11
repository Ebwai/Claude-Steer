// 使用方法：import { createPtyBindHandler } from '@renderer/business/ptyBindHandler'
// 编译说明：renderer 进程 browser bundle
// 代码说明：BL-1 PTY_BIND / PTY_UNBIND 处理——绑定表更新 + Session 注册表更新
//           activeSessionsAtom 中 entry 以 claudeId 为 key（SessionStart Hook 创建），
//           路径 B：claudeId entry 已存在（SessionStart Hook 先到）→ 更新 id/transcriptPath/cwd
//           路径 C：entry 不存在 → 先查 pendingPtyStartsAtom 补 projectId，否则视为外部启动
//           branch PTY_BIND 由 branchHandler 优先处理

import { IPC } from '@shared/events/ipc-channels'
import type { Session } from '@shared/types/index'
import { bindPty, unbindPty } from '@renderer/capabilities/ptyBindings'
import {
  createSession,
  patchSession,
  getSession,
} from '@renderer/capabilities/sessionRegistry'
import {
  addToRealtime,
  removeFromRealtime,
  isRealtimeVisible,
} from '@renderer/capabilities/realtimeVisibility'
import { managedSessionsAtom } from '@renderer/atoms/managed-sessions.atom'
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import { pendingPtyStartsAtom, type PendingPtyStart } from '@renderer/atoms/pending-starts.atom'
import { pathMatches } from '@renderer/utils/pathUtils'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'
import { releaseSessionRuntime } from '@renderer/capabilities/runtimeResourceCapability'

type Store = Pick<TestStore, 'get' | 'set'>

interface PtyBindPayload {
  ptyId: string
  claudeId: string
  transcriptPath?: string | null
  cwd?: string
  projectId?: string  // 早期 PTY_BIND 由主进程直接传入，避免 pendingPtyStartsAtom 时序问题
}

interface PtyUnbindPayload {
  ptyId: string
  claudeId: string
}

interface PtyBindHandler {
  register(): Array<() => void>
  handleBind(payload: PtyBindPayload): void
  handleUnbind(payload: PtyUnbindPayload): void
}

interface PendingStartMatch {
  pendingCwd: string
  pending: PendingPtyStart
}

export function createPtyBindHandler(store: Store): PtyBindHandler {
  function findPendingStart(cwd: string | undefined, ptyId?: string): PendingStartMatch | undefined {
    if (!cwd) return undefined
    for (const [pendingCwd, pending] of store.get(pendingPtyStartsAtom)) {
      if (pathMatches(cwd, pendingCwd) && (!ptyId || pending.ptyId === ptyId)) {
        return { pendingCwd, pending }
      }
    }
    return undefined
  }

  function consumePendingStart(pendingCwd: string): void {
    store.set(pendingPtyStartsAtom, (prev) => {
      const next = new Map(prev)
      next.delete(pendingCwd)
      return next
    })
  }

  function handleBind(payload: PtyBindPayload): void {
    const { ptyId, claudeId, transcriptPath, cwd, projectId: payloadProjectId } = payload
    const managed = [...store.get(managedSessionsAtom).values()].find(s => s.ptyId === ptyId)
    if (managed && (managed.terminalState === 'exited' || managed.lifecycle === 'cancelled')) return

    // I1: 更新双向绑定表
    bindPty(store, ptyId, claudeId)

    const byClaude = getSession(store, claudeId)

    if (byClaude) {
      // SessionStart 已创建真实条目，但早期 PTY 占位仍可能因 IPC 时序残留。
      // 真实 PTY_BIND 同时携带精确 ptyId + claudeId，可安全地按 ptyId 原子收敛，
      // 不能按 cwd 猜测删除（同项目允许多个并行 Agent）。
      let duplicatePlaceholder: Session | undefined
      if (ptyId !== claudeId) {
        const byPtyId = getSession(store, ptyId)
        if (byPtyId?.isPtyPlaceholder && byPtyId.claudeId === ptyId) {
          duplicatePlaceholder = byPtyId
          store.set(activeSessionsAtom, (prev) => {
            if (prev.get(ptyId) !== byPtyId) return prev
            const next = new Map(prev)
            next.delete(ptyId)
            return next
          })
          if (isRealtimeVisible(store, ptyId)) removeFromRealtime(store, ptyId)
          console.info(
            `[BL-1] PTY_BIND reconciled duplicate placeholder: ptyId=${ptyId.slice(0,8)} claudeId=${claudeId.slice(0,8)}`,
          )
        }

        const pending = findPendingStart(cwd, ptyId)
        if (pending) {
          consumePendingStart(pending.pendingCwd)
          console.info(
            `[BL-1] PTY_BIND consumed resolved pending: ptyId=${ptyId.slice(0,8)} projectId=${pending.pending.projectId}`,
          )
        }
      }

      // 路径 B：entry 已以 claudeId 为 key 存在（SessionStart Hook 或 branchHandler 创建），
      //         更新 id（ptyId）/ transcriptPath / cwd。
      // claude --resume 不触发 SessionStart Hook；若旧 entry 已终止，PTY_BIND 就是恢复运行态
      // 与实时输入能力的唯一事实源。Paused/Running 的重复绑定保持原状态，避免 catch-up 误改。
      const resumesTerminalSession = byClaude.status === 'Completed' || byClaude.status === 'Interrupted'
      const reconciledProjectId = byClaude.projectId || duplicatePlaceholder?.projectId || payloadProjectId
      patchSession(store, claudeId, {
        id: ptyId,
        claudeId,
        ...(managed ? { frameId: managed.frameId } : {}),
        isPtyPlaceholder: false,
        ...(reconciledProjectId ? { projectId: reconciledProjectId } : {}),
        ...(resumesTerminalSession ? { status: 'Running', endedAt: null } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(cwd ? { cwd } : {}),
      })
      if (resumesTerminalSession) {
        console.info(
          `[BL-1] PTY_BIND resumed terminal session: claudeId=${claudeId.slice(0,8)} previous=${byClaude.status} ptyId=${ptyId.slice(0,8)}`,
        )
      }
      if (!isRealtimeVisible(store, claudeId)) {
        addToRealtime(store, claudeId)
      }
    } else {
      // 路径 C：entry 不存在——SessionStart Hook 尚未到达或外部启动

      // ── 迁移检查：查找由早期 PTY_BIND（claudeId=ptyId 占位）创建的 entry ──
      // 场景：主进程 SESSION_START 成功后立即发送早期 PTY_BIND（claudeId=ptyId），
      //       后续 autoWatchTranscript 或 Hook 找到真实 claudeId 后发送真正的 PTY_BIND
      //       此时需要将 ptyId-keyed entry 迁移到 claudeId-keyed
      if (ptyId !== claudeId) {
        const byPtyId = getSession(store, ptyId)
        if (byPtyId?.isPtyPlaceholder && byPtyId.claudeId === ptyId) {
          const pending = findPendingStart(cwd, ptyId)
          // 找到占位 entry，迁移到真实 claudeId
          store.set(activeSessionsAtom, (prev) => {
            const next = new Map(prev)
            next.delete(ptyId)
            next.set(claudeId, {
              ...byPtyId,
              claudeId,
              id: ptyId,
              isPtyPlaceholder: false,
              projectId: payloadProjectId ?? pending?.pending.projectId ?? byPtyId.projectId,
              ...(transcriptPath ? { transcriptPath } : {}),
              ...(cwd ? { cwd } : {}),
            })
            return next
          })
          // 迁移 realtime 可见性：从 ptyId 迁移到 claudeId
          if (isRealtimeVisible(store, ptyId)) {
            removeFromRealtime(store, ptyId)
          }
          addToRealtime(store, claudeId)
          if (pending) consumePendingStart(pending.pendingCwd)
          console.log(`[BL-1] PTY_BIND migrated: ${ptyId.slice(0,8)} → ${claudeId.slice(0,8)}`)
          console.log(`[BL-1] PTY_BIND: PTY ${ptyId} ↔ Claude ${claudeId}`)
          return
        }
      }

      // 优先从 pendingPtyStartsAtom 补全 projectId（避免 SESSION_START 后 Hook 迟到时 projectId 为空）
      const pending = findPendingStart(cwd, ptyId)
      const pendingProjectId = pending?.pending.projectId
      const isTemporaryPlaceholder = ptyId === claudeId && Boolean(payloadProjectId)
      if (pending && !isTemporaryPlaceholder) {
        consumePendingStart(pending.pendingCwd)
        console.log(`[BL-1] PTY_BIND path C: consumed pending projectId=${pendingProjectId} for cwd=${cwd ?? ''}`)
      } else if (isTemporaryPlaceholder) {
        console.info(
          `[BL-1] PTY_BIND placeholder retained pending correlation: ptyId=${ptyId.slice(0,8)} projectId=${payloadProjectId}`,
        )
      }

      const newSession: Session = {
        id: ptyId,
        claudeId,
        ...(managed ? { frameId: managed.frameId } : {}),
        projectId: payloadProjectId ?? pendingProjectId ?? '',
        status: 'Running',
        currentModel: null,
        tokenUsage: { current: null, max: null, usedPercentage: null },
        transcriptPath: transcriptPath ?? null,
        cwd: cwd ?? '',
        startedAt: managed?.startedAt ?? Date.now(),
        endedAt: null,
        worktreePath: null,
        isPtyPlaceholder: isTemporaryPlaceholder,
      }
      createSession(store, claudeId, newSession)
      addToRealtime(store, claudeId)
    }

    console.log(`[BL-1] PTY_BIND: PTY ${ptyId} ↔ Claude ${claudeId}`)
  }

  function handleUnbind(payload: PtyUnbindPayload): void {
    const managed = [...store.get(managedSessionsAtom).values()].find(s => s.ptyId === payload.ptyId)
    const current = getSession(store, payload.claudeId)
    if (current && current.id !== payload.ptyId) return
    if (managed && managed.transcriptState !== 'ready') {
      unbindPty(store, payload.ptyId, payload.claudeId)
      removeFromRealtime(store, payload.claudeId)
      releaseSessionRuntime(store, payload.claudeId, { mode: 'destroy', reason: 'managed-exit-without-transcript' })
      return
    }
    unbindPty(store, payload.ptyId, payload.claudeId)
    // PTY 解绑时同步清理 ptySessionIdsAtom，确保 runningProjectsAtom 重新计算
    removeFromRealtime(store, payload.claudeId)
    releaseSessionRuntime(store, payload.claudeId, { mode: 'handoff', reason: 'pty-unbind' })
    console.log(`[BL-1] PTY_UNBIND: PTY ${payload.ptyId} unbound from Claude ${payload.claudeId}`)
  }

  function register(): Array<() => void> {
    return [
      window.api.on(IPC.PTY_BIND, (data: unknown) => {
        handleBind(data as PtyBindPayload)
      }),
      window.api.on(IPC.PTY_UNBIND, (data: unknown) => {
        handleUnbind(data as PtyUnbindPayload)
      }),
    ]
  }

  return { register, handleBind, handleUnbind }
}
