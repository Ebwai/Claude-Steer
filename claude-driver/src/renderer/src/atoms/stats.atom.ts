// 使用方法：import { tokenStatsAtom, todayCostUsdAtom, sessionTokensAtom, driverConfigAtom } from '@renderer/atoms/stats.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：Token 统计相关 Jotai 原子状态——session 级消耗 + 全局派生聚合 + driverConfig 镜像

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { TokenStats, StatusLineData, DriverConfig } from '@shared/types/index'
import { activeSessionsAtom } from './session-core.atom'

// ── per-session token 消耗（来自 JSONL usage 字段）────────────────────────────

export interface SessionTokens {
  /** 纯输入 token 数（不含 cache） */
  inputTokens: number
  /** 输出 token 数 */
  outputTokens: number
  /** cache 写入 token 数 */
  cacheCreationTokens: number
  /** cache 命中 token 数 */
  cacheReadTokens: number
  /** 使用的模型（取最后一条 assistant 行的 model） */
  model: string | null
}

/** 按 claudeId 存储每个 session 的 token 消耗（由 tokenCapability 写入） */
export const sessionTokensAtom = atomFamily((_sessionId: string) =>
  atom<SessionTokens>({
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    model: null,
  })
)

// ── driverConfig 渲染进程镜像（供派生 atom 计算费用）────────────────────────

const DEFAULT_DRIVER_CONFIG: DriverConfig = {
  tokenPriceInputPerM: 3.0,
  tokenPriceOutputPerM: 15.0,
  monthlyBudgetAlertUsd: 50,
  desktopNotificationsEnabled: true,
  themePreference: 'dark',
  uiLanguage: 'zh-CN',
}

/** driverConfig 的 renderer 侧镜像，由 tokenCapability.setDriverConfig 写入 */
export const driverConfigAtom = atom<DriverConfig>({ ...DEFAULT_DRIVER_CONFIG })

// ── 全局 Token 统计（派生 atom，从 activeSessionsAtom + sessionTokensAtom 聚合）──

/**
 * 全局 Token 统计——本月 / 累计 / 常用模型 / 按项目分摊
 * 纯派生，无需手动写入，订阅后自动随 session token 数据变化重算
 */
export const tokenStatsAtom = atom<TokenStats>((get) => {
  const sessions = get(activeSessionsAtom)
  const driverConfig = get(driverConfigAtom)

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

  let monthlyTokens = 0
  let totalCostUsd = 0
  let todayCostUsd = 0
  const modelCount: Record<string, number> = {}
  const costByProject: Record<string, number> = {}

  for (const [claudeId, session] of sessions) {
    const tokens = get(sessionTokensAtom(claudeId))
    const totalTokens = tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens
    if (totalTokens === 0) continue

    // 按 input/output 分别计费（cache token 按 input 价格计算）
    const sessionCost =
      ((tokens.inputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens) / 1_000_000) * driverConfig.tokenPriceInputPerM +
      (tokens.outputTokens / 1_000_000) * driverConfig.tokenPriceOutputPerM

    totalCostUsd += sessionCost

    // 今日费用
    if (session.startedAt >= todayStart) {
      todayCostUsd += sessionCost
    }

    // 本月 token
    if (session.startedAt >= monthStart) {
      monthlyTokens += totalTokens
    }

    // 按项目分摊
    if (session.projectId) {
      costByProject[session.projectId] = (costByProject[session.projectId] ?? 0) + sessionCost
    }

    // 模型计数
    if (tokens.model) {
      modelCount[tokens.model] = (modelCount[tokens.model] ?? 0) + 1
    }
  }

  // 最常用模型
  let mostUsedModel: string | null = null
  let maxCount = 0
  for (const [m, cnt] of Object.entries(modelCount)) {
    if (cnt > maxCount) { mostUsedModel = m; maxCount = cnt }
  }

  return { monthlyTokens, totalCostUsd, mostUsedModel, costByProject }
})

/** 今日估算费用 USD（从 tokenStatsAtom 派生，供 TitleBar 显示） */
export const todayCostUsdAtom = atom<number>((get) => {
  const sessions = get(activeSessionsAtom)
  const driverConfig = get(driverConfigAtom)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

  let todayCost = 0
  for (const [claudeId, session] of sessions) {
    if (session.startedAt < todayStart) continue
    const tokens = get(sessionTokensAtom(claudeId))
    if (tokens.inputTokens + tokens.outputTokens === 0) continue
    todayCost +=
      ((tokens.inputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens) / 1_000_000) * driverConfig.tokenPriceInputPerM +
      (tokens.outputTokens / 1_000_000) * driverConfig.tokenPriceOutputPerM
  }
  return todayCost
})

/** 今日 token 用量（从 sessionTokensAtom 聚合今日 session，供 TitleBar 显示） */
export const todayTokensAtom = atom<number>((get) => {
  const sessions = get(activeSessionsAtom)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

  let total = 0
  for (const [claudeId, session] of sessions) {
    if (session.startedAt < todayStart) continue
    const tokens = get(sessionTokensAtom(claudeId))
    total += tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens
  }
  return total
})

/** 按项目 ID 聚合该项目所有 session 的 token 总消耗 */
export const projectTotalTokensAtom = atomFamily((projectId: string) =>
  atom<number>((get) => {
    const sessions = get(activeSessionsAtom)
    let total = 0
    for (const [claudeId, session] of sessions) {
      if (session.projectId !== projectId) continue
      const tokens = get(sessionTokensAtom(claudeId))
      total += tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens
    }
    return total
  })
)

/** 最新一条 statusLine 数据（来自桥接脚本 ~300ms 推送） */
export const latestStatusLineAtom = atom<StatusLineData | null>(null)
