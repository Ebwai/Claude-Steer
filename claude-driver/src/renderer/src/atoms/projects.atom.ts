// 使用方法：import { projectsAtom, projectByIdAtom, planNodesByProjectAtom, planIndicatorsByProjectAtom } from '@renderer/atoms/projects.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：项目相关 Jotai 原子状态——projectsAtom 持有所有已知项目的 Map；
//           planNodesByProjectAtom 持有各项目的 PlanNode 列表（由 usePlanIndicator 维护，PostToolUse 触发刷新）；
//           planIndicatorsByProjectAtom 持有每个项目的倒三角执行指示器列表

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { Project, PlanNode, PlanIndicator, Milestone } from '@shared/types/index'
import { activeSessionsAtom, ptySessionIdsAtom } from './session-core.atom'
import { pathMatches } from '../utils/pathUtils'

/** 所有项目的 Map（projectId → Project） */
export const projectsAtom = atom<Map<string, Project>>(new Map())

/** 按 ID 获取单个项目（派生 atom，读取时不触发其他项目的 re-render） */
export const projectByIdAtom = atomFamily((projectId: string) =>
  atom<Project | undefined>((get) => get(projectsAtom).get(projectId))
)

/** 已认领项目列表（claimStatus=1，用于画板展示） */
export const claimedProjectsAtom = atom<Project[]>((get) => {
  const projects = get(projectsAtom)
  return Array.from(projects.values()).filter((p) => p.claimStatus === 1)
})

/** 待确认项目数量（claimStatus=0，用于角标） */
export const pendingProjectCountAtom = atom<number>((get) => {
  const projects = get(projectsAtom)
  return Array.from(projects.values()).filter((p) => p.claimStatus === 0).length
})

/** 当前项目监控页面选中的项目 ID */
export const activeProjectIdAtom = atom<string | null>(null)

/**
 * 按项目 ID 索引的 PlanNode 列表（M/S/T 三级）
 * 初始为空，由 usePlanIndicator 在启动时批量加载，并在 PostToolUse 写入 plan 文件后刷新
 */
export const planNodesByProjectAtom = atomFamily((_projectId: string) =>
  atom<PlanNode[]>([])
)

/**
 * 项目级运行时配置（对应 .claude/settings.json 的关键字段）
 * 由 ProjectSettingsBar 挂载时从 IPC.PROJECT_SETTINGS_READ 填充
 */
export interface ProjectSettings {
  permissionMode: string
  model: string
  allowedTools: string[]
  disallowedTools: string[]
  /** 当前启用的 MCP server 名列表（allMcps - 禁用的） */
  enabledMcps: string[]
  /**
   * 全量 MCP server 名列表（含禁用的），按来源区分：
   * - source='mcp.json'：来自项目根目录 .mcp.json
   * - source='global'：来自 ~/.claude.json 顶层 mcpServers
   */
  allMcps: Array<{ name: string; source: 'mcp.json' | 'global' }>
  enabledClis: string[]
  enabledSkills: string[]
  /**
   * 全量 Skill 列表（含禁用的），按来源区分：
   * - source='project'：来自项目 .claude/skills/
   * - source='user'：来自 ~/.claude/skills/（全局个人）
   * - source='plugin'：来自已安装 plugin，pluginLabel 为插件名
   * CLI skill（name 含 'cli'）同时出现在此列表和 enabledClis 中
   */
  allSkills: Array<{ name: string; source: 'project' | 'user' | 'plugin'; pluginLabel?: string; description?: string }>
  enabledWorkflows: string[]
  enabledPlugins: string[]
}

export const defaultProjectSettings: ProjectSettings = {
  permissionMode: 'default',
  model: '',
  allowedTools: [],
  disallowedTools: [],
  enabledMcps: [],
  allMcps: [],
  enabledClis: [],
  enabledSkills: [],
  allSkills: [],
  enabledWorkflows: [],
  enabledPlugins: [],
}

export const projectSettingsAtom = atomFamily((_projectId: string) =>
  atom<ProjectSettings>({ ...defaultProjectSettings })
)

/**
 * 聚合所有已认领项目的 PlanNode Map（projectId → PlanNode[]）
 * 订阅此 atom 可在任何一个项目的 plan 更新时自动触发 re-render
 */
export const allPlanNodesMapAtom = atom<Map<string, PlanNode[]>>((get) => {
  const projects = get(claimedProjectsAtom)
  const map = new Map<string, PlanNode[]>()
  for (const p of projects) {
    map.set(p.id, get(planNodesByProjectAtom(p.id)))
  }
  return map
})

/**
 * 按项目 ID 索引的倒三角执行指示器列表
 * key = projectId，value = 该项目当前活跃的指示器数组
 * 由 usePlanIndicator hook 维护生命周期（5min 超时 / M 任务完成 3min 销毁）
 */
export const planIndicatorsByProjectAtom = atomFamily((_projectId: string) =>
  atom<PlanIndicator[]>([])
)

/**
 * 按项目 ID 索引的 Milestone 列表
 * 由 usePlanIndicator 在检测到 T 节点 → DONE 时追加
 * 仅本次运行内有效（in-session，不持久化）
 */
export const milestonesByProjectAtom = atomFamily((_projectId: string) =>
  atom<Milestone[]>([])
)

/**
 * 运行中项目列表（派生 atom）
 * 复用 LeftPanel projectSessions 逻辑：ptySessionIds.has + Running/Paused + pathMatches
 * 返回 { projectId, name, sessionCount }[]，供通知窗口 ProjectSplitSection 使用
 */
export interface RunningProject {
  projectId: string
  name: string
  sessionCount: number
}

export const runningProjectsAtom = atom<RunningProject[]>((get) => {
  const sessions = get(activeSessionsAtom)
  const ptySessionIds = get(ptySessionIdsAtom)
  const projects = get(projectsAtom)

  const projectSessionCounts = new Map<string, number>()
  for (const session of sessions.values()) {
    if (!ptySessionIds.has(session.claudeId ?? session.id)) continue
    if (session.status !== 'Running' && session.status !== 'Paused') continue
    for (const project of projects.values()) {
      if (pathMatches(session.cwd, project.path)) {
        projectSessionCounts.set(project.id, (projectSessionCounts.get(project.id) ?? 0) + 1)
        break
      }
    }
  }

  return Array.from(projectSessionCounts.entries()).map(([projectId, count]) => {
    const project = projects.get(projectId)
    return { projectId, name: project?.name ?? projectId, sessionCount: count }
  })
})
