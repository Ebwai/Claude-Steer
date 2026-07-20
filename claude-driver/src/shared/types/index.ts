// 使用方法：import type { Project, Session, PlanNode, HookEvent } from '@renderer/shared/types'
// 编译说明：纯 TypeScript 类型/接口文件，无运行时代码，renderer 与 main 进程均可引用
// 代码说明：Claude Steer 核心 Domain 实体类型定义（Project / Session / PlanNode / Hook 事件）

// ════════════════════════════════════════════════════════════
// 1. Project（项目聚合根）
// ════════════════════════════════════════════════════════════

/**
 * 项目认领状态：
 *  1  = 已认领（在画板展示）
 *  0  = 未认领（待用户确认）
 * -1  = 忽略（不显示）
 */
export type ClaimStatus = 1 | 0 | -1

/** Claude Code 权限模式（对应 settings.json 的 permissionMode 字段） */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'


export interface FeishuBotConfig {
  appId: string
  appSecret: string
  /** 管理员飞书 open_id（ou_xxx），拥有 /dir /shell 等特权命令 */
  adminFrom: string
  /** 白名单用户，逗号分隔的 open_id 或 "*" */
  allowFrom: string
  /** 是否启用飞书卡片消息（支持流式原地更新） */
  enableFeishuCard: boolean
  /** 工具调用进度样式 */
  progressStyle: 'legacy' | 'compact' | 'card'
  /** Claude Code 权限模式 */
  agentMode: string
  /** 指定模型（留空使用默认） */
  model: string
  /** API Provider 名称（如 anthropic、minimax，留空使用默认） */
  provider: string
}

export interface Project {
  /** 项目绝对路径，作为唯一标识 */
  id: string
  /** 项目目录名（path 最后一段） */
  name: string
  /** 项目绝对路径 */
  path: string
  /** 认领状态 */
  claimStatus: ClaimStatus
  /** 是否为 Git 仓库（影响 Git 相关功能可用性） */
  isGitRepo: boolean
  /** 当前活跃的 session ID（无活跃 session 时为 null） */
  activeSessionId: string | null
  /** 历史 session ID 列表 */
  sessionIds: string[]
  /** 最后活跃时间戳（ms） */
  lastActiveAt: number
  /** 飞书机器人配置（cc-connect），未配置时为 undefined */
  feishuBot?: FeishuBotConfig
}

// ════════════════════════════════════════════════════════════
// 2. Session（会话实体）
// ════════════════════════════════════════════════════════════

export type SessionStatus = 'Running' | 'Paused' | 'Interrupted' | 'Completed'

export interface TokenUsage {
  /** 当前上下文窗口已使用 token 数（首次 API 调用前为 null） */
  current: number | null
  /** 当前上下文窗口最大 token 数 */
  max: number | null
  /** 使用百分比（0~100） */
  usedPercentage: number | null
}

export interface Session {
  /** 当前 PTY UUID（每次 resume 会变；PTY 操作和 IPC 调用使用此字段） */
  id: string
  /** Claude Code 内部 session UUID（跨 resume 永远不变；activeSessionsAtom Map key、node.id、历史保存均使用此值） */
  claudeId?: string
  projectId: string
  status: SessionStatus
  /** 当前使用的模型名称（来自 statusLine） */
  currentModel: string | null
  tokenUsage: TokenUsage
  /** 当前 JSONL 转录文件路径（来自 statusLine.transcript_path，首次 API 调用前为 null） */
  transcriptPath: string | null
  /** 当前工作目录 */
  cwd: string
  /** 会话开始时间戳（ms） */
  startedAt: number
  /** 会话结束时间戳（ms），运行中为 null */
  endedAt: number | null
  /** 关联的 Git Worktree 路径（非 Git 项目为 null） */
  worktreePath: string | null
}

// ════════════════════════════════════════════════════════════
// 3. PlanNode（Plan 树节点实体）
// ════════════════════════════════════════════════════════════

/** PRD §4.2 定义的 Plan 状态枚举 */
export type PlanStatus = 'TODO' | 'DOING' | 'DONE'

/** Plan 层级：M=母目标, S=子目标, T=任务 */
export type PlanLevel = 'M' | 'S' | 'T'

export interface PlanNode {
  id: string
  projectId: string
  /** 节点层级 */
  level: PlanLevel
  /** 节点标题（如 "T1 — 初始化项目结构"） */
  title: string
  /** 当前状态 */
  status: PlanStatus
  /** 父节点 ID（M 级别节点为 null） */
  parentId: string | null
  /** 对应的 plan 文件相对路径 */
  filePath: string
  /** 最后更新时间戳（ms） */
  updatedAt: number
}

// ════════════════════════════════════════════════════════════
// 4. AgentNode（Subagent 实体）
// ════════════════════════════════════════════════════════════

export type AgentType = 'General' | 'Explore' | 'Plan'

export interface AgentNode {
  id: string
  sessionId: string
  type: AgentType
  /** 父 Agent ID（顶级 Agent 为 null） */
  parentId: string | null
  /** Subagent 自己的 JSONL 转录路径 */
  transcriptPath: string | null
  status: SessionStatus
  startedAt: number
  endedAt: number | null
}

// ════════════════════════════════════════════════════════════
// 5. Token 统计（全局/项目级聚合）
// ════════════════════════════════════════════════════════════

export interface TokenStats {
  /** 本月总 token 用量 */
  monthlyTokens: number
  /** 累计估算费用（USD） */
  totalCostUsd: number
  /** 最常使用的模型名称 */
  mostUsedModel: string | null
  /** 按项目分摊的费用映射（projectId → costUsd） */
  costByProject: Record<string, number>
}

// ════════════════════════════════════════════════════════════
// 6. Hook 事件（来自 Claude Code HTTP Hook POST）
// ════════════════════════════════════════════════════════════

/** PRD §2.3 / Claude Code 文档定义的 Hook 事件类型 */
export type HookEventName =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Notification'
  | 'Stop'
  | 'SessionEnd'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'

/** Hook HTTP POST body 的基础结构（Claude Code 发给仪表盘的原始 payload） */
export interface HookPayloadBase {
  hook_event_name: HookEventName
  session_id: string
  cwd: string
  /** 当前 session 的 JSONL 转录文件绝对路径（所有 Hook 事件都包含此字段） */
  transcript_path: string | null
  /** 仪表盘注入：用户在 settings.json 中为此事件配置的自定义 hook 命令列表（已排除 app 自身的 curl 转发命令） */
  user_hooks?: string[]
}

export interface HookPayloadToolUse extends HookPayloadBase {
  hook_event_name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  tool_name: string
  tool_input: Record<string, unknown>
  tool_response?: unknown
  /** 工具调用唯一 ID——PreToolUse 与对应 PostToolUse 携带相同值，是 分配/返回 精确配对的依据 */
  tool_use_id?: string
}

export interface HookPayloadSubagent extends HookPayloadBase {
  hook_event_name: 'SubagentStart' | 'SubagentStop'
  subagent_id: string
  agent_id?: string
  agent_type?: string
  agent_transcript_path?: string
  /** SubagentStop 时 subagent 的最后一条回复文本 */
  last_assistant_message?: string
}

export interface HookPayloadNotification extends HookPayloadBase {
  hook_event_name: 'Notification'
  message: string
}

export type HookPayload =
  | HookPayloadBase
  | HookPayloadToolUse
  | HookPayloadSubagent
  | HookPayloadNotification

/** 仪表盘内部解析后的 Hook 事件（含时间戳） */
export interface HookEvent {
  eventName: HookEventName
  sessionId: string
  cwd: string
  /** 来自 Claude Code Hook payload 的 transcript_path（转录文件绝对路径） */
  transcriptPath: string | null
  payload: HookPayload
  receivedAt: number
  /** 用户在 settings.json 中为此事件配置的自定义 hook 命令列表（已排除 app 自身命令） */
  userHooks?: string[]
}

// ════════════════════════════════════════════════════════════
// 7. statusLine 数据（来自桥接脚本的 JSON）
// ════════════════════════════════════════════════════════════

export interface StatusLineData {
  model: string | null
  context_window: {
    current_usage: number | null
    max_tokens: number | null
    used_percentage: number | null
  } | null
  rate_limits: Record<string, unknown> | null
  transcript_path: string | null
  cwd: string | null
}

// ════════════════════════════════════════════════════════════
// 8. 通知（UI 消息通知页面）
// ════════════════════════════════════════════════════════════

export type NotificationType = 'permission_request' | 'info' | 'warning' | 'error'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  message: string
  sessionId: string
  projectId: string
  /** 需要用户操作的通知（权限请求）为 true */
  requiresAction: boolean
  /** 用户已处理（同意/拒绝）为 true */
  resolved: boolean
  createdAt: number
  /** 附加数据（info 类通知携带，如 reportPath） */
  metadata?: Record<string, string>
}

// ════════════════════════════════════════════════════════════
// 9. SessionHistoryMeta（历史 session 磁盘元数据）
// ════════════════════════════════════════════════════════════

/** 历史 session 元数据，由主进程扫描 JSONL 目录后返回 */
export interface SessionHistoryMeta {
  /** claudeId（JSONL 文件名，永久不变） */
  claudeId: string
  /** 项目工作目录（来自 JSONL 第一行 cwd 字段） */
  cwd: string
  /** JSONL 文件绝对路径 */
  transcriptPath: string
  /** 文件最后修改时间（ms，用于时序排序） */
  mtime: number
  /** 真实启动时间戳（ms），从 JSONL 第一条 timestamp 字段提取；fallback 用 mtime */
  startedAt?: number
  /** branch 关系（JSONL 第一行 forkedFrom 字段，无则 null） */
  forkedFrom: { sessionId: string; messageUuid: string } | null
  /**
   * branch session 在父 session 中的触发节点索引（user/assistant 节点计数，从 0 开始）
   * 主进程扫描父 JSONL，在 forkedFrom.messageUuid 出现前累计 user/assistant 记录数
   * 非 branch session 为 null
   */
  branchTriggerIndex: number | null
  /**
   * 触发 branch 时父 JSONL 中已有的 user/assistant 节点总数
   * renderer 用于估算 triggerYOffset = FRAME_HEADER_HEIGHT + nodeCount * NODE_HEIGHT_ESTIMATE
   * 非 branch session 或扫描失败时为 null
   */
  parentNodeCountAtBranch: number | null
  /** subagent JSONL 列表（父 session 子目录下的 agent-*.jsonl） */
  subagentFiles: Array<{ agentId: string; filePath: string }>
  /** 插入线持久化文件路径（<claudeId>.insertions.jsonl，不存在时为 null） */
  insertionsPath: string | null
  /** 里程碑持久化文件路径（<claudeId>.milestones.jsonl，不存在时为 null） */
  milestonesPath: string | null
  /** git 标记持久化文件路径（<claudeId>.git-marks.jsonl，不存在时为 null） */
  gitMarksPath: string | null
}

// ════════════════════════════════════════════════════════════
// 10. GitMark（节点 git 快照标记，持久化用）
// ════════════════════════════════════════════════════════════

/** 记录某节点已被 git 快照的标记（持久化到 <claudeId>.git-marks.jsonl） */
export interface GitMark {
  /** 对应的 TimelineNode id */
  nodeId: string
  /** claudeId（session 标识） */
  sessionId: string
  /** git commit hash（7位 short hash） */
  commitHash: string
  /** 标记创建时间戳（ms） */
  createdAt: number
}

// ════════════════════════════════════════════════════════════
// 11. PlanIndicator（倒三角执行指示器）
// ════════════════════════════════════════════════════════════


/**
 * 倒三角执行指示器：
 *  active         = plan 文件最近有变动，正在执行
 *  possibly-paused = 5min 内无新 plan 文件变动，可能暂停
 *  completed      = M 级任务全完成，3min 无变动后销毁前的过渡状态
 */
export type PlanIndicatorStatus = 'active' | 'possibly-paused' | 'completed'

export interface PlanIndicator {
  /** 对应 plan 节点的 ID（如 'M1-S2-T1'，取自 PlanNode.id） */
  planNodeId: string
  projectId: string
  status: PlanIndicatorStatus
  /** 最后一次 plan 文件变动的时间戳（ms） */
  lastUpdatedAt: number
  /** 首次出现时间戳（ms） */
  triggeredAt: number
}

// ════════════════════════════════════════════════════════════
// 11. Milestone（任务里程碑标记）
// ════════════════════════════════════════════════════════════

export interface Milestone {
  /** PlanNode.id，如 'M4-S3-T10' */
  id: string
  /** 所属项目 ID */
  projectId: string
  /** 触发时的活跃 session claudeId（用于确定显示在哪个 SessionFrameNode） */
  sessionId: string
  /** 创建时刻 SessionFrameNode DOM 的实际高度（px），用于 badge Y 坐标定位 */
  frameHeight: number
  /** 完成时间戳（ms） */
  completedAt: number
  /** 任务描述（PlanNode.title，用于 hover tooltip） */
  description: string
}

// ════════════════════════════════════════════════════════════
// 12. DriverConfig（仪表盘自有配置，存于 ~/.claude-driver/config.json）
// ════════════════════════════════════════════════════════════

export interface DriverConfig {
  /** 输入 token 单价（$/百万 token），默认 3.0 */
  tokenPriceInputPerM: number
  /** 输出 token 单价（$/百万 token），默认 15.0 */
  tokenPriceOutputPerM: number
  /** 月度预算警告阈值（USD），默认 50 */
  monthlyBudgetAlertUsd: number
  /** 桌面通知总开关，默认 true */
  desktopNotificationsEnabled: boolean
  /** 通知窗口始终置顶，默认 true */
  notifWindowAlwaysOnTop?: boolean
  /** 权限请求时自动打开通知窗口，默认 true */
  notifWindowAutoOpen?: boolean
  /** 主题偏好，默认 'dark' */
  themePreference: 'dark' | 'light'
  /** 仪表盘界面语言，默认 'zh-CN' */
  uiLanguage?: 'zh-CN' | 'en'
}

// ════════════════════════════════════════════════════════════
// 13. Provider 配置类型（多供应商支持，参考 cc-switch）
// ════════════════════════════════════════════════════════════

export type ProviderId = 'anthropic' | 'deepseek' | 'openrouter' | 'siliconflow' | 'minimax' | 'custom'

export interface ProviderPreset {
  id: ProviderId
  label: string
  baseUrl: string
  defaultModel: string
  defaultLightModel: string
  defaultBalancedModel: string
  defaultPowerfulModel: string
  reasoningModel: string
  requiresAuthToken: boolean
}

/** settings.json 中 env 块的字段 */
export interface ProviderEnvBlock {
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_AUTH_TOKEN?: string
  ANTHROPIC_MODEL?: string
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string
  ANTHROPIC_REASONING_MODEL?: string
  API_TIMEOUT_MS?: string
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string
}
