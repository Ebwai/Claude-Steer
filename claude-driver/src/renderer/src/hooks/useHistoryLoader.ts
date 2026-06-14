// 使用方法：在 App.tsx 或 ProjectMonitorPage.tsx 中调用 useHistoryLoader()
// 编译说明：renderer 进程 browser bundle
// 代码说明：历史 session 加载 Hook——监听项目切换，扫描 JSONL 目录构建历史 activeSessionsAtom entries
//           核心约束：实时 session（claudeId 已在 activeSessionsAtom）不覆盖；历史 branch 关系从 forkedFrom 字段恢复

import { useEffect, useRef } from 'react'
import { useStore } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import type { SessionHistoryMeta, Milestone } from '@shared/types/index'
import { activeProjectIdAtom, projectByIdAtom, milestonesByProjectAtom } from '../atoms/projects.atom'
import { activeSessionsAtom } from '../atoms/session-core.atom'
import { registerBranch, getBranchRelation } from '../capabilities/branchRegistry'
import { viewportModeAtom, focusedSessionIdAtom } from '../atoms/viewport.atom'
import { lineInsertionsBySessionAtom } from '../atoms/timeline.atom'
import type { LineInsertion } from '@shared/types/lineInsertion'
import type { GitMark } from '@shared/types/index'
import { replayGitMarks } from '../capabilities/gitCapability'
import { updateSessionTokensFromFile } from '../capabilities/tokenCapability'

export const MAX_HISTORY_SESSIONS = 20

export function useHistoryLoader(): void {
  const store = useStore()
  const loadingRef = useRef(false)

  useEffect(() => {
    // 订阅后续项目切换
    const unsub = store.sub(activeProjectIdAtom, () => {
      void loadHistory()
    })
    // 若当前已有活跃项目（组件挂载前就设好了，如双击导航），立即加载
    if (store.get(activeProjectIdAtom)) {
      void loadHistory()
    }
    return unsub
  }, [store])

  async function loadHistory(): Promise<void> {
    if (loadingRef.current) return
    const projectId = store.get(activeProjectIdAtom)
    if (!projectId) return
    loadingRef.current = true

    const project = store.get(projectByIdAtom(projectId))
    if (!project) return

    console.log(`[HistoryLoader] Loading history for project: ${project.path}`)

    // 确保目录是 git repo（项目切换时幂等执行，防止 git commit 报错）
    void window.api.invoke(IPC.GIT_ENSURE_REPO, { projectPath: project.path })
      .catch((err: unknown) => console.warn('[HistoryLoader] git:ensure-repo failed:', err))

    try {
      const metas = await window.api.invoke(IPC.PROJECT_HISTORY_SCAN, {
        projectPath: project.path,
        maxSessions: MAX_HISTORY_SESSIONS,
      }) as SessionHistoryMeta[]

      if (!metas.length) {
        console.log('[HistoryLoader] No history sessions found')
        return
      }

      // ── 写入 activeSessionsAtom（只写不存在的 entry，防覆盖实时 session）─────
      store.set(activeSessionsAtom, (prev) => {
        const next = new Map(prev)
        for (const meta of metas) {
          if (next.has(meta.claudeId)) {
            console.log(`[HistoryLoader] Skip ${meta.claudeId.slice(0, 8)}: already in activeSessionsAtom (live session)`)
            continue
          }
          next.set(meta.claudeId, {
            id: meta.claudeId,        // 无 ptyId，用 claudeId 占位
            claudeId: meta.claudeId,
            projectId: project.id,
            status: 'Completed',
            currentModel: null,
            tokenUsage: { current: null, max: null, usedPercentage: null },
            transcriptPath: meta.transcriptPath,
            cwd: meta.cwd,
            startedAt: meta.startedAt ?? meta.mtime,    // 优先用 JSONL 内真实启动时间戳
            endedAt: meta.mtime,
            worktreePath: null,
          })
        }
        return next
      })

      // ── 先回放插入线（必须先于 branch 关系注册，确保 branch 类型插入线已在 atom 里可查询）──
      const metasWithInsertions = metas.filter((m) => m.insertionsPath)
      console.log(`[HistoryLoader] ${metasWithInsertions.length}/${metas.length} sessions have insertions file`)
      for (const meta of metasWithInsertions) {
        console.log(`[HistoryLoader] Loading insertions for ${meta.claudeId.slice(0, 8)} from ${meta.insertionsPath}`)
        try {
          const result = await window.api.invoke(IPC.INSERTIONS_LOAD, {
            insertionsPath: meta.insertionsPath,
          }) as { ok: boolean; insertions: LineInsertion[] }
          console.log(`[HistoryLoader] INSERTIONS_LOAD result ok=${result.ok} count=${result.insertions?.length ?? 0} for ${meta.claudeId.slice(0, 8)}`)
          if (result.ok && result.insertions.length > 0) {
            let added = 0
            result.insertions.forEach((ins) => {
              store.set(lineInsertionsBySessionAtom(meta.claudeId), (prev) => {
                if (prev.some((p) => p.id === ins.id)) return prev
                added++
                return [...prev, ins]
              })
            })
            console.log(`[HistoryLoader] Replayed ${result.insertions.length} insertions (${added} new) for claudeId=${meta.claudeId.slice(0, 8)}`)
          }
        } catch (err) {
          console.warn(`[HistoryLoader] insertions:load failed for ${meta.claudeId.slice(0, 8)}:`, err)
        }
      }

      // ── 回放 Milestones ───────────────────────────────────────────────────
      const metasWithMilestones = metas.filter((m) => m.milestonesPath)
      console.log(`[HistoryLoader] ${metasWithMilestones.length}/${metas.length} sessions have milestones file`)
      for (const meta of metasWithMilestones) {
        try {
          const result = await window.api.invoke(IPC.MILESTONES_LOAD, {
            milestonesPath: meta.milestonesPath,
          }) as { ok: boolean; milestones: Milestone[] }
          if (result.ok && result.milestones.length > 0) {
            for (const m of result.milestones) {
              store.set(milestonesByProjectAtom(m.projectId), (prev) => {
                if (prev.some((p) => p.id === m.id && p.sessionId === m.sessionId)) return prev
                return [...prev, m]
              })
            }
            console.log(`[HistoryLoader] Replayed ${result.milestones.length} milestones for claudeId=${meta.claudeId.slice(0, 8)}`)
          }
        } catch (err) {
          console.warn(`[HistoryLoader] milestones:load failed for ${meta.claudeId.slice(0, 8)}:`, err)
        }
      }

      // ── 回放 Git 标记（isGitted / commitHash）────────────────────────────
      const metasWithGitMarks = metas.filter((m) => m.gitMarksPath)
      console.log(`[HistoryLoader] ${metasWithGitMarks.length}/${metas.length} sessions have git-marks file`)
      for (const meta of metasWithGitMarks) {
        try {
          const result = await window.api.invoke(IPC.GIT_MARKS_LOAD, {
            gitMarksPath: meta.gitMarksPath,
          }) as { ok: boolean; marks: GitMark[] }
          if (result.ok && result.marks.length > 0) {
            replayGitMarks(store, meta.claudeId, result.marks)
          }
        } catch (err) {
          console.warn(`[HistoryLoader] git:marks-load failed for ${meta.claudeId.slice(0, 8)}:`, err)
        }
      }

      // ── 恢复历史 branch 关系（forkedFrom → sessionRelationsAtom）──────────
      // triggerYOffset 优先从已加载的 branch 插入线读取（持久化的帧高快照）
      // fallback：父 session 已 Completed，帧高静态，用当前高度计算
      for (const meta of metas) {
        if (!meta.forkedFrom) continue
        if (getBranchRelation(store, meta.claudeId)) {
          console.log(`[HistoryLoader] Skip branch relation for ${meta.claudeId.slice(0,8)}: already registered (live)`)
          continue
        }
        const triggerNodeIndex = meta.branchTriggerIndex ?? 0
        const parentId = meta.forkedFrom.sessionId

        // 从父 session 的 insertions 里找对应这个子 session 的 branch 插入线
        const branchInsertionId = `${parentId}-branch-${meta.claudeId}`
        const parentInsertions = store.get(lineInsertionsBySessionAtom(parentId))
        const branchIns = parentInsertions.find((ins) => ins.id === branchInsertionId)
        const triggerYOffset = branchIns?.triggerYOffset

        registerBranch(store, meta.claudeId, parentId, {
          triggerNodeIndex,
          inheritedNodeCount: 0,
          triggerYOffset,
        })
        console.log(`[HistoryLoader] Registered branch ${meta.claudeId.slice(0,8)} → parent ${parentId.slice(0,8)} triggerIdx=${triggerNodeIndex} triggerYOffset=${triggerYOffset} (fromIns=${!!branchIns})`)
      }

      // ── Token 扫描：并发扫描所有历史 session 的 JSONL，不阻塞主流程 ──────────
      const metasWithTranscript = metas.filter((m) => m.transcriptPath)
      console.log(`[HistoryLoader] Starting token scan for ${metasWithTranscript.length} sessions`)
      void Promise.allSettled(
        metasWithTranscript.map((meta) =>
          updateSessionTokensFromFile(store, meta.claudeId, meta.transcriptPath)
        )
      )

      // ── 视口跳转：fitView 到 mtime 最新的 session（metas 已按升序排列）─────
      const latestMeta = metas[metas.length - 1]
      store.set(focusedSessionIdAtom, latestMeta.claudeId)
      store.set(viewportModeAtom, 'focus')

      console.log(
        `[HistoryLoader] Loaded ${metas.length} history sessions, focusing ${latestMeta.claudeId.slice(0, 8)}`
      )
    } catch (err) {
      console.error('[HistoryLoader] Failed to load history:', err)
    } finally {
      loadingRef.current = false
    }
  }
}
