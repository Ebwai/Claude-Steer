// 使用方法：在 App.tsx 根组件挂载时调用一次 usePlanIndicator()
// 编译说明：renderer 进程 browser bundle
// 代码说明：Plan 数据管理 + 倒三角执行指示器状态机
//   1. 启动时对所有已认领项目调用 IPC.PLAN_READ，填充 planNodesByProjectAtom
//   2. 监听 PostToolUse Hook，当 plan 文件被写入时：
//      a. 重新拉取 overall_plan.md 刷新 planNodesByProjectAtom（实时更新画板 plan 列表）
//      b. 创建/更新倒三角指示器，管理 5min 超时生命周期

import { useEffect, useRef } from 'react'
import { useStore } from 'jotai'
import { pathMatches } from '@renderer/utils/pathUtils'
import { IPC } from '@shared/events/ipc-channels'
import type { HookEvent, HookPayloadToolUse, PlanIndicator, PlanNode, Milestone } from '@shared/types/index'
import { planIndicatorsByProjectAtom, planNodesByProjectAtom, milestonesByProjectAtom } from '../atoms/projects.atom'
import { projectsAtom, claimedProjectsAtom } from '../atoms/projects.atom'
import { sessionFrameHeightsAtom } from '../atoms/agent-block.atom'
import { activeSessionsAtom } from '../atoms/session-core.atom'

// 5 分钟无变动 → 可能暂停
const POSSIBLY_PAUSED_TIMEOUT_MS = 5 * 60 * 1000

// ── Plan Markdown 解析器 ──────────────────────────────────────────────────────

/**
 * 从 overall_plan.md 解析出 M/S/T 三级 PlanNode 列表
 * 支持 [ ]/[x]/[!] 三种状态，映射到 TODO/DONE/DOING
 * 容错：标题末尾状态标记前有无空格均可识别
 */
export function parsePlanNodes(content: string, projectId: string): PlanNode[] {
  const lines = content.split('\n')
  const nodes: PlanNode[] = []
  let currentMId: string | null = null
  let currentSId: string | null = null

  const parseStatus = (line: string): PlanNode['status'] => {
    if (/\[x\]/i.test(line)) return 'DONE'
    if (/\[!\]/.test(line))  return 'DOING'
    return 'TODO'
  }

  for (const line of lines) {
    // M 级别：## M1 — 标题 [状态]（状态括号前有无空格均兼容）
    const mMatch = line.match(/^##\s+M(\d+)\s+(?:—|–|-)\s+(.+?)(?:\s*\[.*?\])?$/)
    if (mMatch) {
      const id = `M${mMatch[1]}`
      currentMId = id
      currentSId = null
      nodes.push({
        id,
        projectId,
        level: 'M',
        title: mMatch[2].trim(),
        status: parseStatus(line),
        parentId: null,
        filePath: 'plan/overall_plan.md',
        updatedAt: Date.now(),
      })
      continue
    }

    // S 级别：### S1 — 标题 [状态]
    const sMatch = line.match(/^###\s+S(\d+)\s+(?:—|–|-)\s+(.+?)(?:\s*\[.*?\])?$/)
    if (sMatch && currentMId) {
      const id = `${currentMId}-S${sMatch[1]}`
      currentSId = id
      nodes.push({
        id,
        projectId,
        level: 'S',
        title: sMatch[2].trim(),
        status: parseStatus(line),
        parentId: currentMId,
        filePath: 'plan/overall_plan.md',
        updatedAt: Date.now(),
      })
      continue
    }

    // T 级别：- [x]/[ ]/[!] T1 — 标题
    const tMatch = line.match(/^\s*-\s+\[([x!\s])\]\s+T(\d+)\s+(?:—|–|-)\s+(.+)$/)
    if (tMatch && currentSId) {
      const rawStatus = tMatch[1]
      const status: PlanNode['status'] =
        rawStatus === 'x' ? 'DONE' : rawStatus === '!' ? 'DOING' : 'TODO'
      nodes.push({
        id: `${currentSId}-T${tMatch[2]}`,
        projectId,
        level: 'T',
        title: tMatch[3].trim(),
        status,
        parentId: currentSId,
        filePath: 'plan/overall_plan.md',
        updatedAt: Date.now(),
      })
    }
  }

  return nodes
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function isPlanFile(filePath: unknown): boolean {
  if (typeof filePath !== 'string') return false
  const normalized = filePath.replace(/\\/g, '/')
  return /\/plan\/.+\.md$/.test(normalized) || /^plan\/.+\.md$/.test(normalized)
}

function resolveProjectId(cwd: string, projects: Map<string, { path: string }>): string | null {
  let bestId: string | null = null
  let bestLength = -1
  for (const [id, project] of projects) {
    if (pathMatches(cwd, project.path)) {
      if (project.path.length > bestLength) {
        bestId = id
        bestLength = project.path.length
      }
    }
  }
  return bestId
}

function extractFilePath(toolInput: Record<string, unknown>): string | null {
  return typeof toolInput['file_path'] === 'string' ? toolInput['file_path'] : null
}

function filePathToPlanNodeId(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const match = normalized.match(/plan\/(.+)\.md$/)
  if (!match) return filePath
  return match[1].replace(/\//g, '-')
}

// ── 加载单个项目的 plan 数据 ──────────────────────────────────────────────────

async function loadPlanForProject(
  projectId: string,
  projectPath: string,
  store: ReturnType<typeof useStore>
): Promise<PlanNode[] | null> {
  try {
    const result = await window.api.invoke(IPC.PLAN_READ, projectPath) as { ok: boolean; content?: string | null }
    if (result.ok && result.content) {
      const nodes = parsePlanNodes(result.content, projectId)
      store.set(planNodesByProjectAtom(projectId), nodes)
      console.debug(`[PlanIndicator] plan loaded: ${projectId} (${nodes.length} nodes)`)
      return nodes
    }
  } catch (err) {
    console.error(`[PlanIndicator] plan:read failed for ${projectId}:`, err)
  }
  return null
}

// ── 主 Hook ───────────────────────────────────────────────────────────────────

export function usePlanIndicator(): void {
  const store = useStore()
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // 记录已初始加载过的项目，避免重复发起首次 IPC 请求
  const initializedProjects = useRef<Set<string>>(new Set())
  // 各项目上次解析的 T 节点状态快照：projectId → (planNodeId → status)
  const prevTStatusMap = useRef<Map<string, Map<string, PlanNode['status']>>>(new Map())

  useEffect(() => {
    // ── 1. 加载已认领项目的 plan ──────────────────────────────────────────────
    // 问题：useEffect 挂载时 IPC.PROJECT_LIST 可能还未回来，claimedProjectsAtom 为空。
    // 解法：立即执行一次（处理已有数据），同时用 store.sub 订阅后续变化（项目列表加载后触发）。
    function loadNewlyClaimed(): void {
      const claimedProjects = store.get(claimedProjectsAtom)
      for (const project of claimedProjects) {
        if (initializedProjects.current.has(project.id)) continue
        initializedProjects.current.add(project.id)
        // 启动时初始加载：无活跃 Hook 事件，只建立基准快照，不创建 milestone
        void loadPlanForProject(project.id, project.path, store).then((nodes) => {
          if (!nodes) return
          const tMap = new Map<string, PlanNode['status']>()
          for (const n of nodes) {
            if (n.level === 'T') tMap.set(n.id, n.status)
          }
          prevTStatusMap.current.set(project.id, tMap)
          console.debug(`[PlanIndicator] baseline T-status snapshot: ${project.id} (${tMap.size} T-nodes)`)
        })
      }
    }

    loadNewlyClaimed()  // 立即执行（处理已有数据）
    const unsubClaimed = store.sub(claimedProjectsAtom, loadNewlyClaimed)  // 订阅后续变化

    // ── 2. 指示器超时计时器管理 ───────────────────────────────────────────────
    function resetPauseTimer(projectId: string, planNodeId: string): void {
      const key = `${projectId}::${planNodeId}`
      const existing = timers.current.get(key)
      if (existing) clearTimeout(existing)

      const timer = setTimeout(() => {
        timers.current.delete(key)
        store.set(planIndicatorsByProjectAtom(projectId), (prev) =>
          prev.map((ind) =>
            ind.planNodeId === planNodeId
              ? { ...ind, status: 'possibly-paused' as const }
              : ind
          )
        )
      }, POSSIBLY_PAUSED_TIMEOUT_MS)

      timers.current.set(key, timer)
    }

    // ── 3. PostToolUse 处理：plan 文件变动 → 刷新数据 + 更新指示器 ────────────
    function handlePostToolUse(hookEvent: HookEvent): void {
      const payload = hookEvent.payload as HookPayloadToolUse
      console.log(`[PlanIndicator] PostToolUse: tool=${payload.tool_name} sessionId=${hookEvent.sessionId} cwd=${hookEvent.cwd}`)

      if (!['Write', 'Edit', 'MultiEdit'].includes(payload.tool_name)) {
        console.log(`[PlanIndicator] skip: tool ${payload.tool_name} is not a write tool`)
        return
      }

      const filePath = extractFilePath(payload.tool_input)
      console.log(`[PlanIndicator] filePath=${filePath ?? 'null'} isPlanFile=${filePath ? isPlanFile(filePath) : false}`)
      if (!filePath || !isPlanFile(filePath)) return

      const projects = store.get(projectsAtom)
      console.log(`[PlanIndicator] projects in store: ${projects.size} entries`)
      const projectId = resolveProjectId(hookEvent.cwd, projects)
      if (!projectId) {
        console.warn('[PlanIndicator] Cannot resolve projectId for cwd:', hookEvent.cwd)
        return
      }
      console.log(`[PlanIndicator] resolved projectId=${projectId}`)

      // 重新拉取 overall_plan.md，刷新全局 atom（画板和项目监控页自动响应）
      const project = projects.get(projectId)
      if (project) {
        void loadPlanForProject(projectId, project.path, store).then((nodes) => {
          if (!nodes) {
            console.warn(`[PlanIndicator] loadPlanForProject returned null for ${projectId}`)
            return
          }
          // ── T 节点状态 diff：检测新完成的 T 任务 ──────────────────────────
          const prev = prevTStatusMap.current.get(projectId) ?? new Map<string, PlanNode['status']>()
          console.log(`[PlanIndicator] diff: prev snapshot size=${prev.size} new nodes T-count=${nodes.filter(n => n.level === 'T').length}`)
          const newMilestones: Milestone[] = []

          for (const n of nodes) {
            if (n.level !== 'T') continue
            const prevStatus = prev.get(n.id)
            console.log(`[PlanIndicator] T-node ${n.id}: prev=${prevStatus ?? 'NONE'} new=${n.status}`)
            if (prevStatus !== 'DONE' && n.status === 'DONE') {
              // 读取 SessionFrameNode 当前实际 DOM 高度（ResizeObserver 精确值）
              const frameHeight = store.get(sessionFrameHeightsAtom(hookEvent.sessionId))
              const milestone: Milestone = {
                id: n.id,
                projectId,
                sessionId: hookEvent.sessionId,
                frameHeight,
                completedAt: hookEvent.receivedAt,
                description: n.title,
              }
              newMilestones.push(milestone)
              console.log(`[PlanIndicator] milestone reached: ${n.id} sessionId=${hookEvent.sessionId} frameHeight=${frameHeight}`)
            }
          }

          if (newMilestones.length > 0) {
            store.set(milestonesByProjectAtom(projectId), (prev) => [...prev, ...newMilestones])
            console.log(`[PlanIndicator] wrote ${newMilestones.length} milestones to atom`)

            // 持久化：追加到 <claudeId>.milestones.jsonl（与 insertions.jsonl 同目录）
            const transcriptPath = store.get(activeSessionsAtom).get(hookEvent.sessionId)?.transcriptPath
            if (transcriptPath) {
              for (const m of newMilestones) {
                void window.api.invoke(IPC.MILESTONE_SAVE, { transcriptPath, milestone: m })
                  .catch((err: unknown) => console.error('[PlanIndicator] milestone:save failed:', err))
              }
            } else {
              console.warn(`[PlanIndicator] transcriptPath not found for ${hookEvent.sessionId}, milestone not persisted`)
            }
          } else {
            console.log(`[PlanIndicator] no new milestones this cycle`)
          }

          // 更新 T 状态快照（下次 diff 的基准）
          const newTMap = new Map<string, PlanNode['status']>()
          for (const n of nodes) {
            if (n.level === 'T') newTMap.set(n.id, n.status)
          }
          prevTStatusMap.current.set(projectId, newTMap)
        })
      }

      // 更新倒三角指示器
      const planNodeId = filePathToPlanNodeId(filePath)
      const now = Date.now()

      store.set(planIndicatorsByProjectAtom(projectId), (prev) => {
        const existing = prev.find((ind) => ind.planNodeId === planNodeId)
        if (existing) {
          return prev.map((ind) =>
            ind.planNodeId === planNodeId
              ? { ...ind, status: 'active' as const, lastUpdatedAt: now }
              : ind
          )
        }
        const newIndicator: PlanIndicator = {
          planNodeId,
          projectId,
          status: 'active',
          lastUpdatedAt: now,
          triggeredAt: now,
        }
        return [...prev, newIndicator]
      })

      resetPauseTimer(projectId, planNodeId)
      console.debug(`[PlanIndicator] plan file changed: ${projectId} / ${planNodeId}`)
    }

    const hookUnsub = window.api.on(IPC.HOOK_EVENT, (event: unknown) => {
      const hookEvent = event as HookEvent
      if (hookEvent.eventName === 'PostToolUse') {
        handlePostToolUse(hookEvent)
      }
    })

    return () => {
      hookUnsub()
      unsubClaimed()
      for (const timer of timers.current.values()) {
        clearTimeout(timer)
      }
      timers.current.clear()
    }
  }, [store])
}
