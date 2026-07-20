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
import { activeSessionsAtom } from '@renderer/atoms/session-core.atom'
import { pendingPtyStartsAtom } from '@renderer/atoms/pending-starts.atom'
import { pathMatches } from '@renderer/utils/pathUtils'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

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

export function createPtyBindHandler(store: Store) {
  function handleBind(payload: PtyBindPayload): void {
    const { ptyId, claudeId, transcriptPath, cwd, projectId: payloadProjectId } = payload

    // I1: 更新双向绑定表
    bindPty(store, ptyId, claudeId)

    const byClaude = getSession(store, claudeId)

    if (byClaude) {
      // 路径 B：entry 已以 claudeId 为 key 存在（SessionStart Hook 或 branchHandler 创建），
      //         只更新 id（ptyId）/ transcriptPath / cwd
      patchSession(store, claudeId, {
        id: ptyId,
        claudeId,
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(cwd ? { cwd } : {}),
      })
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
        if (byPtyId && byPtyId.claudeId === ptyId) {
          // 找到占位 entry，迁移到真实 claudeId
          store.set(activeSessionsAtom, (prev) => {
            const next = new Map(prev)
            next.delete(ptyId)
            next.set(claudeId, {
              ...byPtyId,
              claudeId,
              id: ptyId,
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
          console.log(`[BL-1] PTY_BIND migrated: ${ptyId.slice(0,8)} → ${claudeId.slice(0,8)}`)
          console.log(`[BL-1] PTY_BIND: PTY ${ptyId} ↔ Claude ${claudeId}`)
          return
        }
      }

      // 优先从 pendingPtyStartsAtom 补全 projectId（避免 SESSION_START 后 Hook 迟到时 projectId 为空）
      const pendingMap = store.get(pendingPtyStartsAtom)
      let pendingProjectId: string | undefined
      for (const [pendingCwd, p] of pendingMap) {
        const matchCwd = cwd ?? ''
        if (pathMatches(matchCwd, pendingCwd)) {
          pendingProjectId = p.projectId
          store.set(pendingPtyStartsAtom, (prev) => {
            const m = new Map(prev)
            m.delete(pendingCwd)
            return m
          })
          console.log(`[BL-1] PTY_BIND path C: consumed pending projectId=${pendingProjectId} for cwd=${matchCwd}`)
          break
        }
      }

      const newSession: Session = {
        id: ptyId,
        claudeId,
        projectId: payloadProjectId ?? pendingProjectId ?? '',
        status: 'Running',
        currentModel: null,
        tokenUsage: { current: null, max: null, usedPercentage: null },
        transcriptPath: transcriptPath ?? null,
        cwd: cwd ?? '',
        startedAt: Date.now(),
        endedAt: null,
        worktreePath: null,
      }
      createSession(store, claudeId, newSession)
      addToRealtime(store, claudeId)
    }

    console.log(`[BL-1] PTY_BIND: PTY ${ptyId} ↔ Claude ${claudeId}`)
  }

  function handleUnbind(payload: PtyUnbindPayload): void {
    unbindPty(store, payload.ptyId, payload.claudeId)
    // PTY 解绑时同步清理 ptySessionIdsAtom，确保 runningProjectsAtom 重新计算
    removeFromRealtime(store, payload.claudeId)
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
