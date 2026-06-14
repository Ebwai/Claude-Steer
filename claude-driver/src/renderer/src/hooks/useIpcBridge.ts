// 使用方法：在 App.tsx 根组件挂载时调用一次 useIpcBridge()
// 编译说明：renderer 进程 browser bundle
// 代码说明：IPC 桥接入口——组合各业务处理单元，注册所有 IPC 监听
//           纯组合层，不含业务逻辑；所有竞态/时序逻辑在 business/ 各模块中

import { useEffect } from 'react'
import { useStore } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import type { Project, Session, SessionHistoryMeta } from '@shared/types/index'
import { projectsAtom } from '../atoms/projects.atom'
import { notificationQueueAtom } from '../atoms/notification.atom'
import type { Notification } from '@shared/types/index'
import { activeSessionsAtom } from '../atoms/session-core.atom'
import { ptyBindingsAtom } from '../atoms/pty-binding.atom'
import { updateSessionTokensFromFile } from '../capabilities/tokenCapability'

// 业务处理单元
import { createPtyBindHandler } from '../business/ptyBindHandler'
import { createSessionLifecycle } from '../business/sessionLifecycle'
import { createBranchHandler } from '../business/branchHandler'
import { createToolActivityHandler } from '../business/toolActivityHandler'
import { createSubagentHandler } from '../business/subagentHandler'
import { createJsonlHandler } from '../business/jsonlHandler'
import { createStatusLineHandler } from '../business/statusLineHandler'
import { createPermissionHandler } from '../business/permissionHandler'
import { createContextHandler } from '../business/contextHandler'

export function useIpcBridge(): void {
  const store = useStore()

  useEffect(() => {
    // 初始化各业务处理单元
    const branch = createBranchHandler(store)
    const ptyBind = createPtyBindHandler(store)
    // 注入 isPendingBind：让 lifecycle 在 branch PENDING_BIND 期间跳过 addToRealtime，
    // 避免 agentLabelsAtom 在 sessionRelations 未就绪时将 branch session 计算为 "Agent"
    const lifecycle = createSessionLifecycle(store, () => branch.isPendingBind())
    const toolActivity = createToolActivityHandler(store)
    const subagent = createSubagentHandler(store)
    const jsonl = createJsonlHandler(store)
    const statusLine = createStatusLineHandler(store)
    const permission = createPermissionHandler(store)
    const context = createContextHandler(store)

    // 加载项目列表，完成后对所有已认领项目做后台 token 全量扫描（填充全局统计）
    void window.api.invoke(IPC.PROJECT_LIST).then(async (raw: unknown) => {
      const projects = (raw as Project[]) ?? []
      store.set(projectsAtom, new Map(projects.map((p) => [p.id, p])))
      console.debug(`[IpcBridge] Loaded ${projects.length} projects`)

      // 后台扫描：对已认领项目的全部历史 session 填充 sessionTokensAtom
      // 这样全局监控面板启动后即可显示真实数据，无需先打开项目监控 tab
      const claimed = projects.filter((p) => p.claimStatus === 1)
      console.log(`[IpcBridge] Starting startup token scan for ${claimed.length} claimed projects`)
      for (const project of claimed) {
        try {
          const metas = await window.api.invoke(IPC.PROJECT_HISTORY_SCAN, {
            projectPath: project.path,
            maxSessions: 50,
          }) as SessionHistoryMeta[]

          // 写入 activeSessionsAtom（只写不存在的 entry，防覆盖实时 session）
          store.set(activeSessionsAtom, (prev) => {
            const next = new Map(prev)
            for (const meta of metas) {
              if (next.has(meta.claudeId)) continue
              next.set(meta.claudeId, {
                id: meta.claudeId,
                claudeId: meta.claudeId,
                projectId: project.id,
                status: 'Completed',
                currentModel: null,
                tokenUsage: { current: null, max: null, usedPercentage: null },
                transcriptPath: meta.transcriptPath,
                cwd: meta.cwd,
                startedAt: meta.startedAt ?? meta.mtime,
                endedAt: meta.mtime,
                worktreePath: null,
              })
            }
            return next
          })

          // 并发扫描 token
          const withTranscript = metas.filter((m) => m.transcriptPath)
          void Promise.allSettled(
            withTranscript.map((meta) =>
              updateSessionTokensFromFile(store, meta.claudeId, meta.transcriptPath)
            )
          )
          console.log(`[IpcBridge] Token scan queued for ${withTranscript.length} sessions in project "${project.name}"`)
        } catch (err) {
          console.warn(`[IpcBridge] Startup token scan failed for project "${project.name}":`, err)
        }
      }
    }).catch((err: unknown) => {
      console.error('[IpcBridge] Failed to load projects:', err)
    })

    // 注册顺序：branch 优先，确保 PTY_BIND / HOOK_EVENT 先被 branch 状态机处理
    const unsubscribers: Array<() => void> = [
      ...branch.register(),
      ...ptyBind.register(),
      ...lifecycle.register(),
      ...toolActivity.register(),
      ...subagent.register(),
      ...jsonl.register(),
      ...statusLine.register(),
      ...permission.register(),
      ...context.register(),
    ]

    // 通知队列（全局，无业务逻辑，直接在此处理）
    unsubscribers.push(
      window.api.on(IPC.NOTIFICATION, (data: unknown) => {
        store.set(notificationQueueAtom, (prev) => [...prev, data as Notification])
      })
    )

    // 项目单条更新（SESSION_START 后 main 推送，同步 projectsAtom）
    unsubscribers.push(
      window.api.on(IPC.PROJECT_UPDATED, (data: unknown) => {
        const project = data as Project
        store.set(projectsAtom, (prev) => new Map(prev).set(project.id, project))
      })
    )

    // SESSION_STATUS（PTY 层推送）：sessionId 是 ptyId，需通过绑定表转换
    unsubscribers.push(
      window.api.on(IPC.SESSION_STATUS, (data: unknown) => {
        const { sessionId: rawId, status } = data as { sessionId: string; status?: Session['status'] }
        if (!status) return
        const claudeId = store.get(ptyBindingsAtom).ptyToClaudeMap.get(rawId) ?? rawId
        store.set(activeSessionsAtom, (prev) => {
          const session = prev.get(claudeId)
          if (!session) return prev
          const next = new Map(prev)
          next.set(claudeId, {
            ...session,
            status,
            endedAt: status === 'Completed' || status === 'Interrupted' ? Date.now() : session.endedAt,
          })
          return next
        })
      })
    )

    return () => { unsubscribers.forEach((unsub) => unsub()) }
  }, [store])
}
