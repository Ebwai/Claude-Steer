// 使用方法：在 App.tsx 根组件挂载时调用一次 useIpcBridge()
// 编译说明：renderer 进程 browser bundle
// 代码说明：IPC 桥接入口——组合各业务处理单元，注册所有 IPC 监听
//           纯组合层，不含业务逻辑；所有竞态/时序逻辑在 business/ 各模块中

import { useEffect } from 'react'
import { useStore } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import type { Project, Session, HistoryTokenInventoryResult } from '@shared/types/index'
import { projectsAtom } from '../atoms/projects.atom'
import { notificationQueueAtom } from '../atoms/notification.atom'
import type { Notification } from '@shared/types/index'
import { activeSessionsAtom } from '../atoms/session-core.atom'
import { ptyBindingsAtom } from '../atoms/pty-binding.atom'
import { upsertTokenInventory } from '../capabilities/tokenCapability'
import { releaseSessionRuntime } from '../capabilities/runtimeResourceCapability'

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
import { createDetailHandler } from '../business/detailHandler'

type RendererStore = ReturnType<typeof useStore>

let startupInventoryTask: Promise<void> | null = null
let startupInventoryComplete = false

/** React StrictMode 会重挂载根 effect；启动库存属于应用级工作，只允许一个 owner。 */
export function ensureStartupTokenInventory(store: RendererStore): Promise<void> {
  if (startupInventoryComplete) return Promise.resolve()
  if (startupInventoryTask) {
    console.debug('[IpcBridge] Reusing in-flight startup inventory task')
    return startupInventoryTask
  }

  const task = (async (): Promise<void> => {
    const raw = await window.api.invoke(IPC.PROJECT_LIST)
    const projects = (raw as Project[]) ?? []
    store.set(projectsAtom, new Map(projects.map((project) => [project.id, project])))
    console.debug(`[IpcBridge] Loaded ${projects.length} projects`)

    const claimed = projects.filter((project) => project.claimStatus === 1)
    console.log(`[IpcBridge] Starting startup token scan for ${claimed.length} claimed projects`)
    for (const project of claimed) {
      try {
        const requestId = crypto.randomUUID()
        const result = await window.api.invoke(IPC.HISTORY_TOKEN_INVENTORY, {
          projectId: project.id,
          projectPath: project.path,
          requestId,
        }) as HistoryTokenInventoryResult
        if (result.ok) {
          upsertTokenInventory(store, result.entries)
          console.log(`[IpcBridge] Token inventory loaded for ${result.entries.length} sessions in project "${project.name}"`)
        } else if (result.errorCode !== 'HISTORY_CANCELLED') {
          console.warn(`[IpcBridge] Token inventory failed for project "${project.name}": ${result.errorCode} ${result.error}`)
        }
      } catch (err) {
        console.warn(`[IpcBridge] Startup token scan failed for project "${project.name}":`, err)
      }
    }
    startupInventoryComplete = true
  })()

  const wrappedTask = task.finally(() => {
    if (startupInventoryTask === wrappedTask) startupInventoryTask = null
  })
  startupInventoryTask = wrappedTask
  return wrappedTask
}

import { applyManagedChange, applyManagedSnapshot } from '../capabilities/managedSessionCapability'
import type { ManagedChange, ManagedSnapshot } from '@shared/types/managedSession'

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
    const detail = createDetailHandler(store)

    // 后台扫描属于应用级初始化；StrictMode 重挂载复用同一个 promise。
    void ensureStartupTokenInventory(store).catch((err: unknown) => {
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
      ...detail.register(),
    ]

    let disposed = false
    unsubscribers.push(window.api.on(IPC.MANAGED_SESSION_SNAPSHOT, data => applyManagedSnapshot(store, data as ManagedSnapshot)))
    unsubscribers.push(window.api.on(IPC.MANAGED_SESSION_CHANGE, data => applyManagedChange(store, data as ManagedChange)))
    void window.api.invoke(IPC.MANAGED_SESSION_SNAPSHOT).then(snapshot => {
      if (!disposed && snapshot && typeof snapshot === 'object' && 'sessions' in snapshot) applyManagedSnapshot(store, snapshot as ManagedSnapshot)
    }).catch(error => console.error('[ManagedSession] snapshot failed', error))
    unsubscribers.push(() => { disposed = true })

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
        if (status === 'Completed' || status === 'Interrupted') {
          releaseSessionRuntime(store, claudeId, { mode: 'handoff', reason: `session-status:${status}` })
        }
      })
    )

    return () => { unsubscribers.forEach((unsub) => unsub()) }
  }, [store])
}
