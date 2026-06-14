// 使用方法：import { createBranchHandler } from '@renderer/business/branchHandler'
// 编译说明：renderer 进程 browser bundle
// 代码说明：BL-3 Branch 业务——内部状态机完整处理 branch 全流程
//           状态：IDLE → PENDING_CONFIRM → PENDING_BIND → IDLE
//           订阅：SESSION_BRANCH_LINK / HOOK_EVENT(SessionEnd) / PTY_BIND / JSONL_BRANCH_SNAPSHOT
//           activeSessionsAtom entry 以 claudeId 为 key，无需 ptyId 双路查找

import { IPC } from '@shared/events/ipc-channels'
import type { HookEvent, Session } from '@shared/types/index'
import { resolveClaudeId } from '@renderer/capabilities/ptyBindings'
import { pathMatches } from '@renderer/utils/pathUtils'
import {
  createSession,
  getSession,
  completeSession,
} from '@renderer/capabilities/sessionRegistry'
import { addToRealtime, removeFromRealtime } from '@renderer/capabilities/realtimeVisibility'
import {
  registerBranch,
  updateBranchSnapshot,
  cachePendingSnapshot,
  consumePendingSnapshot,
  getBranchRelation,
} from '@renderer/capabilities/branchRegistry'
import { getVisibleNodeCount, getLastNodeParsedAt, appendInsertion } from '@renderer/capabilities/timelineStore'
import { allFrameHeightsAtom } from '@renderer/atoms/agent-block.atom'
import { computeFrozenOffset } from '../hooks/useSessionFrameLayout'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

// ── 状态机类型 ────────────────────────────────────────────────────────────────

type BranchState =
  | { phase: 'IDLE' }
  | { phase: 'PENDING_CONFIRM'; parentPtyId: string; parentClaudeId: string }
  | { phase: 'PENDING_BIND';   parentPtyId: string; parentClaudeId: string; oldBranchId: string }

export function createBranchHandler(store: Store) {
  let state: BranchState = { phase: 'IDLE' }

  // ── SESSION_BRANCH_LINK（无 child）：预通知 ─────────────────────────────────
  function handlePreNotify(parentPtyId: string, parentClaudeIdFromMsg?: string): void {
    if (state.phase !== 'IDLE') {
      console.warn(`[BL-3] preNotify received in phase ${state.phase}, resetting`)
    }
    // 优先用消息里附带的 parentClaudeId（主进程在绑定表清除前写入）
    // fallback：查渲染层绑定表
    const parentClaudeId = parentClaudeIdFromMsg ?? resolveClaudeId(store, parentPtyId) ?? parentPtyId
    state = { phase: 'PENDING_CONFIRM', parentPtyId, parentClaudeId }
    console.log(`[BL-3] PENDING_CONFIRM: parentPty=${parentPtyId} parentClaude=${parentClaudeId}`)
  }

  // ── SESSION_BRANCH_LINK（有 child=oldBranchId）：确认 ──────────────────────
  function handleConfirm(parentPtyId: string, oldBranchId: string): void {
    if (state.phase !== 'PENDING_CONFIRM') {
      console.warn(`[BL-3] confirm received in unexpected phase ${state.phase}`)
      return
    }
    const parentClaudeId = state.parentClaudeId

    // 父 session 让位：标记 Completed + 移出实时面板（entry key 是 claudeId）
    const parentSession = getSession(store, parentClaudeId)
    if (parentSession) {
      completeSession(store, parentClaudeId, Date.now())
      removeFromRealtime(store, parentClaudeId)
    } else {
      console.warn(`[BL-3] handleConfirm: no entry for parent claudeId=${parentClaudeId}`)
    }

    state = { phase: 'PENDING_BIND', parentPtyId, parentClaudeId, oldBranchId }
    console.log(`[BL-3] PENDING_BIND: parent=${parentClaudeId} oldBranchId=${oldBranchId}`)
  }

  // ── PTY_BIND (parentPtyId → newClaudeId)：branch 新 session 上线 ───────────
  function handlePtyBind(ptyId: string, newClaudeId: string, transcriptPath: string | null | undefined, cwd: string | undefined): void {
    if (state.phase !== 'PENDING_BIND') return
    if (ptyId !== state.parentPtyId) return

    const { parentClaudeId, oldBranchId } = state
    state = { phase: 'IDLE' }

    // 若 entry 已存在（SessionStart Hook 先到的极端情况），不重复创建
    if (!getSession(store, newClaudeId)) {
      const parentSession = getSession(store, parentClaudeId)
      const newSession: Session = {
        id: ptyId,
        claudeId: newClaudeId,
        projectId: parentSession?.projectId ?? '',
        status: 'Running',
        currentModel: null,
        tokenUsage: { current: null, max: null, usedPercentage: null },
        transcriptPath: transcriptPath ?? null,
        cwd: cwd ?? parentSession?.cwd ?? '',
        startedAt: Date.now(),
        endedAt: null,
        worktreePath: null,
      }
      createSession(store, newClaudeId, newSession)
    }

    // 先注册 branch 关系，再加入实时面板
    // agentLabelsAtom 在 ptySessionIds 变化时重新计算，必须确保此时 sessionRelations 已有该 entry
    // 否则会先标记为 "Agent"，紧接着才更新为 "Branch"（闪烁 + 错误标签）
    if (!getBranchRelation(store, newClaudeId)) {
      // 可见节点数量（user_input + assistant），与 DOM 节点序号和历史路径 branchTriggerIndex 对齐
      const triggerNodeIndex = Math.max(0, getVisibleNodeCount(store, parentClaudeId) - 1)
      // 快照父框当前帧高，计算 branch 连接线的冻结偏移量
      const parentH = store.get(allFrameHeightsAtom).get(parentClaudeId)
      const triggerYOffset = parentH !== undefined ? computeFrozenOffset(parentH) : undefined
      console.log(`[BL-3][DIAG] triggerYOffset snapshot for parent=${parentClaudeId.slice(0,8)}: parentH=${parentH} offset=${triggerYOffset}`)
      const pendingUuid = consumePendingSnapshot(oldBranchId)
      registerBranch(store, newClaudeId, parentClaudeId, {
        triggerNodeIndex,
        inheritedNodeCount: 0,
        branchStartUuid: pendingUuid,
        triggerYOffset,
      })
      console.log(`[BL-3] registerBranch done child=${newClaudeId.slice(0,8)} parent=${parentClaudeId.slice(0,8)} triggerIdx=${triggerNodeIndex} triggerYOffset=${triggerYOffset}`)

      // 插入线 timestamp 取父 session 最后节点的 parsedAt，确保落入正确时间窗口
      const relation = getBranchRelation(store, newClaudeId)
      const side = relation?.side ?? 'right'
      const timestamp = getLastNodeParsedAt(store, parentClaudeId)
      appendInsertion(store, parentClaudeId, {
        id: `${parentClaudeId}-branch-${newClaudeId}`,
        type: 'branch',
        direction: side === 'right' ? 'right' : 'left',
        color: '#35C98A',
        length: 'long',
        customWidth: 750,   // 轴(750px) → 框右/左边缘(1500/0px)，正好跨越半框宽
        sessionId: parentClaudeId,
        timestamp,
        badgeContent: {},
        status: 'done',
        isAnimating: false,
        lineLabel: '继承记忆',
        triggerYOffset,   // 持久化快照，重启时从 insertions.jsonl 恢复
      })
      console.log(`[BL-3] branch insertion appended to parent=${parentClaudeId.slice(0,8)} side=${side} ts=${timestamp} triggerYOffset=${triggerYOffset}`)
    }

    // branch 关系已在 sessionRelations，此时加入实时面板 agentLabelsAtom 计算结果为 "Branch"
    addToRealtime(store, newClaudeId)
    console.log(`[BL-3] IDLE: branch complete child=${newClaudeId} parent=${parentClaudeId}`)
  }

  // ── JSONL_BRANCH_SNAPSHOT ──────────────────────────────────────────────────
  function handleBranchSnapshot(sessionId: string, branchStartUuid: string): void {
    if (getBranchRelation(store, sessionId)) {
      updateBranchSnapshot(store, sessionId, branchStartUuid)
    } else {
      cachePendingSnapshot(sessionId, branchStartUuid)
    }
  }

  // ── 注册所有事件 ──────────────────────────────────────────────────────────
  function register(): Array<() => void> {
    return [
      // SESSION_BRANCH_LINK：预通知 or 确认
      window.api.on(IPC.SESSION_BRANCH_LINK, (raw: unknown) => {
        const msg = raw as {
          sessionId?: string
          parentSessionId?: string
          parentClaudeId?: string
          branchSessionId?: string
          childSessionId?: string
        }
        const parentPtyId = msg.sessionId ?? msg.parentSessionId ?? ''
        const oldBranchId = msg.branchSessionId ?? msg.childSessionId
        console.log(`[BL-3][IPC] SESSION_BRANCH_LINK: parentPtyId=${parentPtyId} oldBranchId=${oldBranchId ?? 'none'} parentClaudeId=${msg.parentClaudeId ?? 'none'} state.phase=${state.phase}`)
        if (!parentPtyId) return
        if (!oldBranchId) {
          handlePreNotify(parentPtyId, msg.parentClaudeId)
        } else {
          handleConfirm(parentPtyId, oldBranchId)
        }
      }),

      // HOOK_EVENT：仅在 PENDING_CONFIRM 时关注 SessionEnd（fallback：confirm 未到时 SessionEnd 先到）
      window.api.on(IPC.HOOK_EVENT, (event: unknown) => {
        const hookEvent = event as HookEvent
        if (hookEvent.eventName !== 'SessionEnd') return
        console.log(`[BL-3][IPC] HOOK_EVENT SessionEnd: sessionId=${hookEvent.sessionId} cwd=${hookEvent.cwd} state.phase=${state.phase}`)
        if (state.phase !== 'PENDING_CONFIRM') return
        const parentSession = getSession(store, state.parentClaudeId)
        if (parentSession && pathMatches(hookEvent.cwd, parentSession.cwd)) {
          handleConfirm(state.parentPtyId, hookEvent.sessionId)
        }
      }),

      // PTY_BIND：branch 新 session 上线（在 ptyBindHandler 之前处理）
      window.api.on(IPC.PTY_BIND, (data: unknown) => {
        const { ptyId, claudeId, transcriptPath, cwd } = data as {
          ptyId: string; claudeId: string; transcriptPath?: string | null; cwd?: string
        }
        console.log(`[BL-3][IPC] PTY_BIND: ptyId=${ptyId} claudeId=${claudeId} state.phase=${state.phase}`)
        handlePtyBind(ptyId, claudeId, transcriptPath, cwd)
      }),

      // JSONL_BRANCH_SNAPSHOT
      window.api.on(IPC.JSONL_BRANCH_SNAPSHOT, (raw: unknown) => {
        const { sessionId, branchStartUuid } = raw as { sessionId: string; branchStartUuid: string }
        if (sessionId && branchStartUuid) {
          handleBranchSnapshot(sessionId, branchStartUuid)
        }
      }),
    ]
  }

  /** 返回当前是否处于 PENDING_BIND 阶段（供 sessionLifecycle 跳过抢先 addToRealtime 用） */
  function isPendingBind(): boolean {
    return state.phase === 'PENDING_BIND'
  }

  return { register, handlePreNotify, handleConfirm, handlePtyBind, handleBranchSnapshot, isPendingBind }
}
